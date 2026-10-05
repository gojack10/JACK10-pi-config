#!/usr/bin/env python3
"""
Local LLM proxy: merges ds4-server (:8001), mlx-lm (:8000), the tunnel
SSH tunnel (:8003), and local Flash-MoE llama-server (:8004) under one
endpoint.

Routes /v1/chat/completions to the right backend based on model ID.
Merges /v1/models from all reachable backends.
Merges /admin/api/stats from admin-capable backends and synthesizes Flash-MoE
progress from llama.cpp streaming prompt_progress chunks so pi's local LLM
progress extension can monitor Qwen through the proxy.
"""

import asyncio
import json
import logging
import os
import subprocess
import hashlib
import shlex
import time
import uuid
from pathlib import Path
from aiohttp import ClientSession, ClientTimeout, web
import reservation_body
import swap_policy
from winnow_runtime import WinnowRuntime, MODEL_ID as WINNOW_MODEL_ID, UPSTREAM_ID as WINNOW_UPSTREAM_ID, PORT as WINNOW_PORT

CHAT_TIMEOUT = ClientTimeout(total=None, sock_connect=10, sock_read=None)
DISCOVERY_TIMEOUT = ClientTimeout(total=5, sock_connect=2, sock_read=5)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("local-proxy")


class _AccessNoiseFilter(logging.Filter):
    def filter(self, record):
        return '"GET /admin/api/stats ' not in record.getMessage()


logging.getLogger("aiohttp.access").addFilter(_AccessNoiseFilter())

DS4_PORT = int(os.getenv('LOCAL_PROXY_DS4_PORT', '8001')) if os.getenv('LOCAL_PROXY_RESERVATION') == '1' else 8001
MLX_PORT = 8000
TUNNEL_PORT = 8003
FLASH_MOE_PORT = 8004
LISTEN_PORT = int(os.getenv('LOCAL_PROXY_PORT', '8002')) if os.getenv('LOCAL_PROXY_RESERVATION') == '1' else 8002
# Default OFF. This build has no live native adapter; never advertise a grant
# based on an HTTP stream, an old pause file, or a process-exit observation.
RESERVATION_TRIAL = os.getenv("LOCAL_PROXY_RESERVATION", "0") == "1"
DUAL_MODELS = RESERVATION_TRIAL and os.getenv('LOCAL_PROXY_DUAL_MODELS') == '1'
COORDINATOR = Path("/Users/jack/research/bend/coordinator/liveness-evidence-20260925/coordinator-cpu")
COORDINATOR_SHA256 = "eac1a3d92d1e55c0545549dfaaa41d00298a77c4ceff953aec3b563985dd86bd"

QWEN_FLASH_MODEL_ID = "qwen36-35b-a3b-flash-moe"
DS4_FLASH_MODEL_ID = "tunnel-model"
DS4_PRO_MODEL_ID = "deepseek-v4-pro"
GLM_FLASH_MODEL_ID = "glm-5.3-flash"
QWEN_NEXT_MODEL_ID = "qwen3.8-flash-next"
# mlx-lm serves exactly one checkpoint per process and has no admin API, so the
# proxy owns its lifecycle the way it owns dsv4: the desired checkpoint goes in a
# file, bootout frees the whole footprint, and only one model is ever resident.
# Native context for all three checkpoints is 262,144; no YaRN scaling anywhere.
MLX_SERVICE_LABEL = "com.mlx-lm.server"
MLX_DESIRED_FILE = Path.home() / ".mlx-lm" / "desired-model"
MLX_MODEL_PATHS = {
    "qwen3.8-27b-uncensored": ".mlx-lm/models/Qwen3.8-27B-Uncensored-8bit",
    "gemma-4-31b-mlx": ".mlx-lm/models/mlx-community/gemma-4-31b-it-8bit",
}
MLX_MODEL_IDS = set(MLX_MODEL_PATHS)
MLX_MODEL_METADATA = {
    "qwen3.8-27b-uncensored": {"name": "Qwen3.8 27B Uncensored (MLX 8-bit)", "context_length": 262144},
    "gemma-4-31b-mlx": {"name": "Gemma 4 31B IT (MLX 8-bit)", "context_length": 262144},
}
MLX_SUPPORTED_PARAMETERS = [
    "tools", "tool_choice", "max_tokens", "temperature", "top_p", "top_k",
    "min_p", "stop", "seed", "stream",
]
MLX_START_TIMEOUT = 900
MLX_IDLE_TIMEOUT = 30 * 60
MLX_LAST_REQUEST_AT = 0.0
DS41_MODEL_ID = "deepseek-v4.1-flash"
DS4_MODEL_IDS = {QWEN_NEXT_MODEL_ID, DS41_MODEL_ID}
DS4_SERVICE_LABEL = "com.dsv4.server"
DS4_DESIRED_FILE = Path.home() / ".dsv4" / "desired-model"
DS4_SWITCH_TIMEOUT = 600
DS4_CACHE_TTL = 5.0
DS4_SUPPORTED_PARAMETERS = [
    "tools",
    "tool_choice",
    "max_tokens",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "stop",
    "seed",
    "stream",
    "reasoning_effort",
]
DS4_MODEL_METADATA = {
    DS4_FLASH_MODEL_ID: {
        "name": "DeepSeek V4 Flash",
        "context_length": 1048576,
        "max_completion_tokens": 1048576,
    },
    DS4_PRO_MODEL_ID: {
        "name": "DeepSeek V4 Pro",
        "context_length": 1048576,
        "max_completion_tokens": 1048576,
    },
    QWEN_NEXT_MODEL_ID: {
        "name": "Qwen3.8 Flash Next",
        "context_length": 500000,
        "max_completion_tokens": 500000,
    },
    GLM_FLASH_MODEL_ID: {
        "name": "GLM 5.3 Flash",
        "context_length": 500000,
        "max_completion_tokens": 393216,
    },
    # Must match the wrapper's --ctx for the ds41 case; a mismatch desyncs Pi's
    # view from the resident engine.
    DS41_MODEL_ID: {
        "name": "DeepSeek V4.1 Flash",
        "context_length": 1000000,
        "max_completion_tokens": 1000000,
    },
}
DS4_LOADED_MODEL_ID = None
DS4_LOADED_CHECK_AT = 0.0
DS4_SWITCH_LOCK = asyncio.Lock()
REQUEST_CONDITION = asyncio.Condition(DS4_SWITCH_LOCK)
ACTIVE_MODEL_ID = None
ACTIVE_REQUESTS = 0
ACTIVE_TICKET = None
REQUEST_QUEUE = []
CHAT_OWNER = None
INDEPENDENT_SWITCH = None
WINNOW = WinnowRuntime()

DS4_IDLE_TIMEOUT = 30 * 60
DS4_ACTIVE_REQUESTS = 0
DS4_LAST_REQUEST_AT = 0.0
DS4_IDLE_TASK = None


# Localhost-only proxy key: env override, then the gitignored .proxy-key next to this file.
PROXY_API_KEY = (os.getenv("LOCAL_LLM_PROXY_API_KEY")
                 or (Path(__file__).resolve().parent / ".proxy-key").read_text().strip())
AUTH_HEADERS = {"Authorization": f"Bearer {PROXY_API_KEY}"}

BACKENDS = {
    "ds4": {
        "label": "ds4",
        "v1": f"http://127.0.0.1:{DS4_PORT}/v1",
        "admin": f"http://127.0.0.1:{DS4_PORT}/admin",
        "models": set(),
    },
    "mlx": {
        "label": "mlx-lm",
        "v1": f"http://127.0.0.1:{MLX_PORT}/v1",
        "admin": None,
        "models": set(),
    },
    "tunnel": {
        "label": "tunnel",
        "v1": f"http://127.0.0.1:{TUNNEL_PORT}/v1",
        "admin": f"http://127.0.0.1:{TUNNEL_PORT}/admin",
        "models": set(),
    },
    "flash_moe": {
        "label": "flash-moe",
        "v1": f"http://127.0.0.1:{FLASH_MOE_PORT}/v1",
        "admin": None,
        "models": set(),
    },
}

# Static routes let hot local models route correctly immediately after the proxy
# starts, even before the first successful /v1/models discovery.
STATIC_MODEL_BACKENDS = {
    GLM_FLASH_MODEL_ID: "ds4",
    QWEN_NEXT_MODEL_ID: "ds4",
    # DSV4 only advertises the model it currently holds, so V4.1 needs a static
    # backend entry or it becomes unroutable while another model is resident.
    DS41_MODEL_ID: "ds4",
    QWEN_FLASH_MODEL_ID: "flash_moe",
}
STATIC_MODEL_BACKENDS.update({mid: "mlx" for mid in MLX_MODEL_IDS})
MODEL_BACKENDS = dict(STATIC_MODEL_BACKENDS)

# Active Flash-MoE requests, populated by proxied streaming SSE chunks.
FLASH_ACTIVE = {}


class CheckedReservation:
    """CPU-only checked-core continuation. No HTTP/client data can supply an ack.

    The engine adapters must establish the host facts in HOST_CONTRACT before
    wiring any action to hardware. Until then this record is deliberately not
    adoptable by live traffic. Effects are never inferred from core state.
    """

    MAX_NAT = 281474976410654

    def __init__(self, owner, journal):
        if len(owner) != 4 or owner[0] not in (0, 1) or any(
            type(n) is not int or not 0 <= n <= self.MAX_NAT for n in owner
        ):
            raise ValueError("invalid owner binding")
        if hashlib.sha256(COORDINATOR.read_bytes()).hexdigest() != COORDINATOR_SHA256:
            raise RuntimeError("unqualified coordinator binary")
        self.owner = "/".join(map(str, owner))
        self.journal = Path(journal)
        self.state = None
        self.version = 0
        self.blocked = None
        self.dispatched = set()
        self.calls = {}
        self.returned = set()
        self.lifecycle = "active"
        self.apply(None)

    def apply(self, event, effect_id=None):
        """Serialize externally; an effect ID must remain unique across retries.

        Events are internal, constructed only from identity-bound host evidence.
        A bad CLI reply freezes this record; it cannot reset/re-begin ownership.
        """
        if self.blocked:
            raise RuntimeError(f"reservation blocked: {self.blocked}")
        if event is not None:
            fields = event.split("/")
            if len(event) > 4096 or not fields or any(
                not f.isascii() or not f.isdecimal() or int(f) > self.MAX_NAT for f in fields
            ):
                raise ValueError("invalid private coordinator event")
        args = [self.owner] if event is None and self.state is None else [self.state, event]
        try:
            new_call = int(event.split("/")[1]) if event and event.startswith("0/") else None
            if new_call is not None and new_call in self.calls:
                raise ValueError("duplicate accepted call")
            result = subprocess.run([str(COORDINATOR), "--gpu", "off", *args],
                                    capture_output=True, check=True, timeout=5)
            text = result.stdout.decode("ascii")
            if result.stderr or not text.endswith("\n") or text.count("\n") != 1:
                raise ValueError("invalid coordinator framing")
            parts = text[:-1].split(" ")
            if len(parts) != 3 or parts[0] != "OK":
                raise ValueError("invalid coordinator reply")
            state, action = parts[1:]
            for field in (state, action):
                if len(field) > 4096 or not field or any(
                    not f.isascii() or not f.isdecimal() or int(f) > self.MAX_NAT
                    for f in field.split("/")
                ):
                    raise ValueError("invalid coordinator fields")
            if not state.startswith(self.owner + "/") or action.split("/")[0] not in map(str, range(9)):
                raise ValueError("foreign coordinator reply")
            if effect_id is not None and effect_id in self.dispatched:
                raise ValueError("reused physical effect")
            action_fields = list(map(int, action.split("/")))
            returned = action_fields[6:] if action_fields[0] == 7 else (
                action_fields[1:] if action_fields[0] == 8 else []
            )
            if action_fields[0] == 7 and action_fields[1:5] != list(map(int, self.owner.split("/"))):
                raise ValueError("foreign closed owner")
            if any(call not in self.calls and call != new_call or call in self.returned for call in returned):
                raise ValueError("foreign or reused returned call")
            with self.journal.open("a") as output:
                output.write(json.dumps({"version": self.version, "input": args,
                                         "state": state, "action": action, "effect": effect_id}) + "\n")
                output.flush()
                os.fsync(output.fileno())
            self.state, self.version = state, self.version + 1
            if new_call is not None:
                self.calls[new_call] = "accepted"
            for call in returned:
                self.calls[call] = "returned"
                self.returned.add(call)
            if effect_id is not None:
                self.dispatched.add(effect_id)
            if action.startswith("7/"):
                self.lifecycle = "retiring"  # Closed is not physical release.
            if action.startswith("6/"):
                self.lifecycle = "blocked"
            return action
        except Exception as exc:
            self.blocked = f"checked core/journal unavailable: {exc!r}"
            self.lifecycle = "blocked"
            raise


def reservation_unavailable(request, backend_name):
    """No qualified physical owner/borrower mapping exists on this build."""
    if RESERVATION_TRIAL and (DUAL_MODELS or backend_name in ("ds4", "mlx")):
        request_id = request.headers.get("X-Pi-Request-Id") or str(uuid.uuid4())
        raise web.HTTPServiceUnavailable(
            text=json.dumps({"admitted": False, "request_id": request_id,
                             "reason": "native_reservation_adapter_unavailable"}),
            content_type="application/json",
        )


async def fetch_backend_models(sess, backend_name):
    backend = BACKENDS[backend_name]
    try:
        async with sess.get(f"{backend['v1']}/models", headers=AUTH_HEADERS) as r:
            if r.status != 200:
                raise RuntimeError(f"HTTP {r.status}")
            data = await r.json()
            models = data.get("data", [])
            ids = {m.get("id") for m in models if m.get("id")}
            backend["models"] = ids
            log.info(f"{backend['label']} models: {sorted(ids)}")
            return backend_name, ids
    except Exception as e:
        backend["models"] = set()
        log.warning(f"{backend['label']} unreachable: {e}")
        return backend_name, set()


async def discover_models():
    """Discover which models each backend serves."""
    global MODEL_BACKENDS
    async with ClientSession(timeout=DISCOVERY_TIMEOUT) as sess:
        pairs = await asyncio.gather(
            *(fetch_backend_models(sess, name) for name in BACKENDS),
            return_exceptions=True,
        )

    discovered = {}
    for pair in pairs:
        if isinstance(pair, Exception):
            continue
        backend_name, ids = pair
        for model_id in ids:
            if backend_name != "ds4" or model_id in DS4_MODEL_IDS:
                discovered[model_id] = backend_name

    discovered.update(STATIC_MODEL_BACKENDS)
    MODEL_BACKENDS = discovered


async def periodic_discover():
    while True:
        await asyncio.sleep(60)
        try:
            await discover_models()
        except Exception as e:
            log.debug(f"periodic discover error: {e}")


def get_backend_name(model_id):
    """Return backend name for a model ID."""
    if isinstance(model_id, str):
        if model_id in STATIC_MODEL_BACKENDS:
            return STATIC_MODEL_BACKENDS[model_id]
        if model_id in MODEL_BACKENDS and model_id not in (DS4_FLASH_MODEL_ID, DS4_PRO_MODEL_ID):
            return MODEL_BACKENDS[model_id]
    raise web.HTTPBadRequest(
        text=json.dumps({"error": {"type": "unknown_model", "message": f"Unknown model ID: {model_id!r}"}}),
        content_type="application/json",
    )


def get_backend_v1(model_id):
    return BACKENDS[get_backend_name(model_id)]["v1"]


def parse_json_body(body):
    try:
        return json.loads(body), None
    except Exception as e:
        return None, e


def normalize_ds4_chat_body(backend_name, body):
    """Normalize proxy clients onto DS4's DeepSeek-compatible thinking API.

    DS4 exposes three modes: none, high, max. Its chat-completions parser accepts
    reasoning_effort, but intentionally collapses xhigh/minimal/low/medium/high
    to HIGH; only the literal DeepSeek API value "max" enters Think Max. Normalize
    OpenRouter/pi/qwen-template shapes here so proxy clients cannot accidentally
    turn xhigh into high before the request reaches ds4-server.
    """
    if backend_name != "ds4":
        return body
    payload, err = parse_json_body(body)
    if err or not isinstance(payload, dict):
        return body
    if payload.get("model") not in (GLM_FLASH_MODEL_ID, DS4_FLASH_MODEL_ID, DS4_PRO_MODEL_ID):
        return body

    changed = False
    effort = None

    reasoning = payload.get("reasoning")
    if isinstance(reasoning, dict) and isinstance(reasoning.get("effort"), str):
        effort = reasoning.get("effort", "").lower()
        payload.pop("reasoning", None)
        changed = True
    elif isinstance(payload.get("reasoning_effort"), str):
        effort = payload["reasoning_effort"].lower()

    if effort in ("none", "off"):
        payload["thinking"] = {"type": "disabled"}
        payload.pop("reasoning_effort", None)
        changed = True
    elif effort in ("max", "xhigh"):
        payload["thinking"] = {"type": "enabled"}
        payload["reasoning_effort"] = "max"
        changed = True
    elif effort in ("minimal", "low", "medium", "high"):
        payload["thinking"] = {"type": "enabled"}
        payload["reasoning_effort"] = "high"
        changed = True

    chat_template_kwargs = payload.get("chat_template_kwargs")
    if isinstance(chat_template_kwargs, dict) and "enable_thinking" in chat_template_kwargs:
        enabled = bool(chat_template_kwargs.get("enable_thinking"))
        payload["thinking"] = {"type": "enabled" if enabled else "disabled"}
        if not enabled:
            payload.pop("reasoning_effort", None)
        payload.pop("chat_template_kwargs", None)
        changed = True

    if changed:
        return json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return body


def maybe_prepare_flash_body(backend_name, body):
    """Enable llama.cpp prompt progress events for proxied Qwen streams."""
    if backend_name != "flash_moe":
        return body
    payload, err = parse_json_body(body)
    if err or not isinstance(payload, dict):
        return body
    if payload.get("stream", False):
        payload["return_progress"] = True
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def maybe_prepare_chat_body(backend_name, body):
    body = normalize_ds4_chat_body(backend_name, body)
    body = maybe_prepare_flash_body(backend_name, body)
    body = maybe_prepare_mlx_body(backend_name, body)
    return body


def maybe_prepare_mlx_body(backend_name, body):
    """mlx-lm takes a checkpoint path in `model`; the proxy owns that mapping."""
    if backend_name != "mlx" or not body:
        return body
    payload, err = parse_json_body(body)
    if err or not isinstance(payload, dict):
        return body
    payload["model"] = mlx_model_path(payload.get("model"))
    return json.dumps(payload).encode()


# ── Flash-MoE progress tracking ─────────────────────────────────────────────


def flash_start(model_id):
    req_id = str(uuid.uuid4())
    now = time.monotonic()
    FLASH_ACTIVE[req_id] = {
        "model": model_id or QWEN_FLASH_MODEL_ID,
        "phase": "prefill",
        "start": now,
        "last": now,
        "decode_start": None,
        "prefill": {"processed": 0, "total": 0, "time_ms": 0, "cache": 0},
        "generated_tokens": 0,
    }
    return req_id


def flash_finish(req_id):
    if req_id:
        FLASH_ACTIVE.pop(req_id, None)


def flash_note_progress(req_id, progress):
    state = FLASH_ACTIVE.get(req_id)
    if not state:
        return
    now = time.monotonic()
    total = int(progress.get("total") or 0)
    processed = int(progress.get("processed") or 0)
    cache = int(progress.get("cache") or 0)
    time_ms = float(progress.get("time_ms") or 0)
    state["phase"] = "prefill"
    state["last"] = now
    state["prefill"] = {
        "processed": processed,
        "total": total,
        "cache": cache,
        "time_ms": time_ms,
    }


def flash_note_decode(req_id):
    state = FLASH_ACTIVE.get(req_id)
    if not state:
        return
    now = time.monotonic()
    if state.get("phase") != "decode":
        state["phase"] = "decode"
        state["decode_start"] = now
        state["generated_tokens"] = 0
    state["last"] = now
    state["generated_tokens"] += 1


def flash_process_sse_event(req_id, event_text):
    data_lines = []
    for line in event_text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            data_lines.append(line[5:].strip())
    if not data_lines:
        return

    payload_text = "\n".join(data_lines)
    if payload_text == "[DONE]":
        flash_finish(req_id)
        return

    try:
        data = json.loads(payload_text)
    except Exception:
        return

    progress = data.get("prompt_progress")
    if isinstance(progress, dict):
        flash_note_progress(req_id, progress)

    for choice in data.get("choices", []) or []:
        delta = choice.get("delta") or {}
        # OpenAI-compatible llama.cpp chunks use content/reasoning deltas once
        # prompt eval has completed. Count chunks as a display-only proxy for
        # generated tokens; exact token counts are not exposed mid-stream here.
        if delta.get("content") or delta.get("reasoning_content"):
            flash_note_decode(req_id)
        if choice.get("finish_reason"):
            flash_finish(req_id)


def flash_observe_chunk(req_id, buffer, chunk):
    if not req_id:
        return buffer
    try:
        buffer += chunk.decode("utf-8", "ignore").replace("\r\n", "\n")
    except Exception:
        return buffer

    while "\n\n" in buffer:
        event_text, buffer = buffer.split("\n\n", 1)
        flash_process_sse_event(req_id, event_text)
    return buffer


def build_flash_admin_models():
    prefilling = []
    generating = []
    now = time.monotonic()

    for state in list(FLASH_ACTIVE.values()):
        # Expire abandoned entries defensively.
        if now - state.get("last", now) > 300:
            continue

        if state.get("phase") == "prefill":
            pf = state.get("prefill", {})
            total = int(pf.get("total") or 0)
            processed = int(pf.get("processed") or 0)
            if total <= 0:
                continue
            elapsed = max(float(pf.get("time_ms") or 0) / 1000.0, 0.001)
            speed = processed / elapsed if processed > 0 else 0
            eta = (total - processed) / speed if speed > 0 and total > processed else 0
            prefilling.append({
                "processed": processed,
                "total": total,
                "cache": int(pf.get("cache") or 0),
                "speed": speed,
                "tok_s": speed,
                "eta": eta,
            })
        elif state.get("phase") == "decode":
            elapsed = max(now - (state.get("decode_start") or state.get("start") or now), 0.001)
            tokens = int(state.get("generated_tokens") or 0)
            speed = tokens / elapsed if tokens > 0 else 0
            generating.append({
                "generated_tokens": tokens,
                "tokens": tokens,
                "elapsed_seconds": elapsed,
                "speed": speed,
                "tok_s": speed,
            })

    models = []
    if prefilling or generating:
        models.append({
            "id": QWEN_FLASH_MODEL_ID,
            "prefilling": prefilling,
            "generating": generating,
        })
    return models


# ── Memory cop: pre-emptive unload coordination ─────────────────────────────


async def _mlx_launchctl(*args, timeout=15):
    proc = await asyncio.create_subprocess_exec(
        "/bin/launchctl", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    return proc.returncode, (stdout or b"") + (stderr or b"")


def _mlx_unavailable(message):
    return web.HTTPServiceUnavailable(
        text=json.dumps({"error": {
            "type": "mlx_unavailable",
            "message": f"{message}; no fallback or automatic restore was attempted.",
        }}),
        content_type="application/json",
    )


def mlx_model_path(model_id):
    """Absolute checkpoint path for a proxy model ID, resolving symlinks."""
    if model_id not in MLX_MODEL_PATHS:
        raise web.HTTPBadRequest(
            text=json.dumps({"error": {"type": "unknown_model", "message": f"Unknown mlx model ID: {model_id!r}"}}),
            content_type="application/json",
        )
    return str((Path.home() / MLX_MODEL_PATHS[model_id]).resolve())


def _write_mlx_desired_sync(path):
    # Atomic publication: the wrapper either sees the old path or the new one.
    MLX_DESIRED_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = MLX_DESIRED_FILE.with_name("desired-model.tmp")
    tmp.write_text(path + "\n")
    tmp.replace(MLX_DESIRED_FILE)


async def mlx_resident_model():
    """Model ID whose checkpoint the loaded job reports, or None.

    mlx-lm lists the resolved --model path among /v1/models ids, which is the
    only residency signal it offers (it has no admin API).
    """
    try:
        async with ClientSession(timeout=DISCOVERY_TIMEOUT) as sess:
            async with sess.get(
                f"{BACKENDS['mlx']['v1']}/models", headers=AUTH_HEADERS,
            ) as r:
                if r.status != 200:
                    return None
                ids = {m.get("id") for m in (await r.json()).get("data", [])}
    except Exception:
        return None
    for model_id in MLX_MODEL_IDS:
        if mlx_model_path(model_id) in ids:
            return model_id
    return None


async def mlx_service_loaded():
    code, _ = await _mlx_launchctl("print", f"gui/{os.getuid()}/{MLX_SERVICE_LABEL}")
    return code == 0


async def stop_mlx():
    """Free the whole mlx-lm footprint by booting its job out. Idempotent."""
    global MLX_LAST_REQUEST_AT
    label = f"gui/{os.getuid()}/{MLX_SERVICE_LABEL}"
    if not await mlx_service_loaded():
        return
    log.info("stopping mlx-lm")
    try:
        async with asyncio.timeout(90):
            code, out = await _mlx_launchctl("bootout", label)
            if code != 0 and b"Could not find service" not in out:
                raise RuntimeError(f"launchctl bootout: {out.decode()[:200]}")
            # The Metal footprint is only gone once launchd reports the job gone.
            while await mlx_service_loaded():
                await asyncio.sleep(0.25)
    except Exception as e:
        raise _mlx_unavailable(f"mlx-lm shutdown failed: {e!r}") from e
    MLX_LAST_REQUEST_AT = 0.0


async def start_mlx():
    uid = os.getuid()
    plist = str(Path.home() / "Library" / "LaunchAgents" / f"{MLX_SERVICE_LABEL}.plist")
    label = f"gui/{uid}/{MLX_SERVICE_LABEL}"
    log.info("starting mlx-lm")
    try:
        # The job runs with RunAtLoad=false so no activation or login can load a
        # checkpoint beside ds4; bootstrap only registers it, so kick it off.
        code, out = await _mlx_launchctl("bootstrap", f"gui/{uid}", plist)
        if code != 0 and b"already bootstrapped" not in out:
            raise RuntimeError(f"launchctl bootstrap: {out.decode()[:200]}")
        code, out = await _mlx_launchctl("kickstart", label)
        if code != 0:
            raise RuntimeError(f"launchctl kickstart: {out.decode()[:200]}")
        deadline = time.monotonic() + MLX_START_TIMEOUT
        while time.monotonic() < deadline:
            if await mlx_resident_model() is not None:
                log.info("mlx-lm backend ready")
                return
            await asyncio.sleep(1)
        raise RuntimeError(f"mlx-lm served no known checkpoint within {MLX_START_TIMEOUT}s")
    except Exception as e:
        raise _mlx_unavailable(f"failed to start mlx-lm: {e!r}") from e


async def ensure_mlx_model(model_id):
    """Called under the admission gate: make model_id the one resident checkpoint.

    The checked swap policy decides reuse / stop-then-start / refuse; the host
    proves identity, service exit and readiness.
    """
    global MLX_LAST_REQUEST_AT
    resident, mlx_unproven = await refresh_swap_residency()
    if mlx_unproven:
        raise _mlx_unavailable("mlx lane is occupied/unproven; no MLX admission was attempted")
    action, target = swap_policy.SWAP.admit(model_id, qualified=model_id in MLX_MODEL_IDS)
    if action == "reuse":
        if await mlx_resident_model() == model_id:
            MLX_LAST_REQUEST_AT = time.monotonic()
            return
        swap_policy.SWAP.adopt_unknown()
        raise _mlx_unavailable(f"mlx reports no ready {model_id!r} after an identity match; no repair was attempted")
    if action not in ("stop", "start"):
        raise _mlx_unavailable(f"swap policy refused {model_id!r} ({action}); resident {resident!r} retained")
    if action == "stop":
        try:
            if target in MLX_MODEL_IDS:
                await stop_mlx()
            else:
                await unload_ds4_if_idle("mlx")
        except BaseException:
            try:
                swap_policy.SWAP.stop_unknown()
            except swap_policy.SwapPolicyError as exc:
                log.warning(f"swap policy blocked after stop failure: {exc}")
            raise
        swap_policy.SWAP.stop_done()
    try:
        await asyncio.to_thread(_write_mlx_desired_sync, mlx_model_path(model_id))
        await start_mlx()
        resident_now = await mlx_resident_model()
        if resident_now != model_id:
            raise _mlx_unavailable(f"mlx-lm reports {resident_now!r} instead of {model_id!r}")
    except BaseException:
        try:
            swap_policy.SWAP.start_unknown()
        except swap_policy.SwapPolicyError as exc:
            log.warning(f"swap policy blocked after start failure: {exc}")
        raise
    swap_policy.SWAP.start_ready()
    MLX_LAST_REQUEST_AT = time.monotonic()


async def mlx_idle_check_loop():
    global MLX_LAST_REQUEST_AT
    while True:
        await asyncio.sleep(30)
        try:
            if ACTIVE_REQUESTS > 0 or live_chat_owner():
                continue
            now = time.monotonic()
            if MLX_LAST_REQUEST_AT == 0.0:
                if await mlx_resident_model() is not None:
                    MLX_LAST_REQUEST_AT = now
                continue
            if now - MLX_LAST_REQUEST_AT < MLX_IDLE_TIMEOUT:
                continue
            # Same shared admission lock as ds4 switching: no lifecycle action can
            # overlap an admitted request on either backend.
            async with DS4_SWITCH_LOCK:
                if ACTIVE_REQUESTS > 0 or live_chat_owner():
                    MLX_LAST_REQUEST_AT = time.monotonic()
                    continue
                if await mlx_resident_model() is None:
                    MLX_LAST_REQUEST_AT = 0.0
                    continue
                log.info(f"mlx-lm idle {now - MLX_LAST_REQUEST_AT:.0f}s; policy check")
                resident, mlx_unproven = await refresh_swap_residency()
                if mlx_unproven:
                    continue  # foreign/unproven mlx listener: never release or adopt it
                action, _target = swap_policy.SWAP.idle_tick(
                    int((time.monotonic() - MLX_LAST_REQUEST_AT) * 1000),
                    MLX_IDLE_TIMEOUT * 1000, False)
                if action != "unload":
                    continue  # Keep: sticky Winnow, unknown identity or active owner
                await stop_mlx()
                swap_policy.SWAP.release_done()
        except Exception as e:
            log.warning(f"mlx idle loop: {e}")


async def stop_dsv4():
    uid = os.getuid()
    label = f"gui/{uid}/{DS4_SERVICE_LABEL}"
    log.info("stopping dsv4")
    try:
        async with asyncio.timeout(90):
            proc = await asyncio.create_subprocess_exec(
                "/bin/launchctl", "bootout", label,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
            if proc.returncode != 0 and b"Could not find service" not in stderr:
                raise RuntimeError(f"launchctl bootout: {stderr.decode()[:200]}")
            # Process exit can precede launchd removing the old service. Starting
            # then can address that dying registration instead of a new job.
            while True:
                proc = await asyncio.create_subprocess_exec(
                    "/bin/launchctl", "print", label,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
                if proc.returncode != 0:
                    if b"Could not find service" not in stderr:
                        raise RuntimeError(f"launchctl print: {stderr.decode()[:200]}")
                    if await detect_ds4_loaded_model(refresh=True) is None:
                        break
                await asyncio.sleep(0.25)
    except Exception as e:
        raise web.HTTPServiceUnavailable(text=f"DS4 shutdown failed; no replacement started: {str(e) or type(e).__name__}") from e
    global DS4_LOADED_MODEL_ID, DS4_LOADED_CHECK_AT
    DS4_LOADED_MODEL_ID = None
    DS4_LOADED_CHECK_AT = 0.0


async def start_dsv4():
    uid = os.getuid()
    plist = str(Path.home() / "Library" / "LaunchAgents" / "com.dsv4.server.plist")
    label = f"gui/{uid}/{DS4_SERVICE_LABEL}"
    log.info("starting dsv4")

    for attempt in range(2):
        try:
            proc = await asyncio.create_subprocess_exec(
                "/bin/launchctl", "bootstrap", f"gui/{uid}", plist,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
            if proc.returncode != 0:
                err = (stderr or stdout).decode()[:300]
                log.warning(f"launchctl bootstrap note: {err}")
            proc2 = await asyncio.create_subprocess_exec(
                "/bin/launchctl", "kickstart", label,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout2, stderr2 = await asyncio.wait_for(proc2.communicate(), timeout=15)
            if proc2.returncode != 0:
                err2 = (stderr2 or stdout2).decode()[:300]
                log.warning(f"launchctl kickstart: {err2}")
        except Exception as e:
            log.warning(f"start_dsv4 error: {e}")

        # Verify the service actually exists in launchd (race: bootout between
        # idle stop and this start can leave no service loaded).
        try:
            proc3 = await asyncio.create_subprocess_exec(
                "/bin/launchctl", "print", label,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout3, stderr3 = await asyncio.wait_for(proc3.communicate(), timeout=10)
            if proc3.returncode == 0:
                return  # service is loaded
            log.warning(f"dsv4 not loaded after attempt {attempt+1}, retrying")
        except Exception as e:
            log.warning(f"dsv4 verify error: {e}")

        if attempt == 0:
            await asyncio.sleep(1)

    log.error("dsv4 failed to load after 2 attempts")
    raise web.HTTPServiceUnavailable(text="DS4 launch failed after 2 attempts; no fallback was attempted")


async def ds4_idle_check_loop():
    global DS4_LAST_REQUEST_AT
    while True:
        await asyncio.sleep(30)
        try:
            now = time.monotonic()
            if DS4_ACTIVE_REQUESTS > 0 or live_chat_owner():
                continue
            if DS4_LAST_REQUEST_AT == 0.0:
                if await detect_ds4_loaded_model(refresh=True) is not None:
                    DS4_LAST_REQUEST_AT = now
                continue
            if now - DS4_LAST_REQUEST_AT < DS4_IDLE_TIMEOUT:
                continue
            loaded = await detect_ds4_loaded_model(refresh=True)
            if loaded is None:
                DS4_LAST_REQUEST_AT = 0.0
                continue
            if await ds4_is_busy():
                DS4_LAST_REQUEST_AT = now
                continue
            log.info(f"dsv4 idle {now - DS4_LAST_REQUEST_AT:.0f}s; stopping")
            async with DS4_SWITCH_LOCK:
                loaded2 = await detect_ds4_loaded_model(refresh=True)
                if loaded2 is None:
                    continue
                if DS4_ACTIVE_REQUESTS > 0 or live_chat_owner() or await ds4_is_busy():
                    DS4_LAST_REQUEST_AT = time.monotonic()
                    continue
                if time.monotonic() - DS4_LAST_REQUEST_AT < DS4_IDLE_TIMEOUT:
                    continue
                await refresh_swap_residency()
                action, _target = swap_policy.SWAP.idle_tick(
                    int((time.monotonic() - DS4_LAST_REQUEST_AT) * 1000),
                    DS4_IDLE_TIMEOUT * 1000, False)
                if action != "unload":
                    continue  # Keep: sticky Winnow, unknown identity or active owner
                await stop_dsv4()
                swap_policy.SWAP.release_done()
                DS4_LAST_REQUEST_AT = 0.0
        except Exception as e:
            log.warning(f"idle loop: {e}")


# ── DS4 model switching ──────────────────────────────────────────────────────


def mlx_static_model(model_id, cfg):
    ctx = cfg["context_length"]
    return {
        "id": model_id,
        "object": "model",
        "created": 1767225600,
        "owned_by": "mlx-lm",
        "name": cfg["name"],
        "context_length": ctx,
        "top_provider": {
            "context_length": ctx,
            "max_completion_tokens": ctx,
            "is_moderated": False,
        },
        "supported_parameters": MLX_SUPPORTED_PARAMETERS,
    }


def ds4_static_model(model_id):
    cfg = DS4_MODEL_METADATA[model_id]
    ctx = cfg["context_length"]
    max_completion = min(cfg["max_completion_tokens"], ctx)
    return {
        "id": model_id,
        "object": "model",
        "created": 1767225600,
        "owned_by": "ds4.c",
        "name": cfg["name"],
        "context_length": ctx,
        "top_provider": {
            "context_length": ctx,
            "max_completion_tokens": max_completion,
            "is_moderated": False,
        },
        "supported_parameters": DS4_SUPPORTED_PARAMETERS,
    }


def _model_id_from_mode(value):
    value = (value or "").strip()
    if value in ("flash", DS4_FLASH_MODEL_ID):
        return DS4_FLASH_MODEL_ID
    if value in ("pro", DS4_PRO_MODEL_ID):
        return DS4_PRO_MODEL_ID
    if value in ("glm", GLM_FLASH_MODEL_ID):
        return GLM_FLASH_MODEL_ID
    if value in ("qwen", QWEN_NEXT_MODEL_ID):
        return QWEN_NEXT_MODEL_ID
    return None


def _mode_from_model_id(model_id):
    return {
        GLM_FLASH_MODEL_ID: "glm",
        QWEN_NEXT_MODEL_ID: "qwen",
        DS41_MODEL_ID: "ds41",
    }[model_id]


def _detect_ds4_loaded_model_sync():
    try:
        out = subprocess.check_output(
            ["/bin/ps", "-axo", "pid=,command="],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        raise RuntimeError("Cannot inspect DS4 processes; refusing lifecycle action") from e

    ds4_lines = []
    for line in out.splitlines():
        fields = line.split(None, 2)
        if len(fields) < 2 or (Path(fields[1]).name != "ds4-server" and
                              fields[1] != '/Users/jack/ds4/ds4-server-v41-reservation'):
            continue
        args = shlex.split(line)
        if "--port" not in args or args[args.index("--port") + 1:][:1] != [str(DS4_PORT)]:
            continue
        ds4_lines.append(line)

    if not ds4_lines:
        return None

    if len(ds4_lines) != 1:
        raise RuntimeError("Multiple DS4 processes on port 8001; refusing lifecycle action")
    cmd = ds4_lines[0]
    # Checked before the V4-Flash fallback: the V4.1 filename does not contain
    # the V4-Flash substring, but keep the specific match first regardless.
    if "DeepSeek-V4.1-Flash" in cmd:
        return DS41_MODEL_ID
    if "Qwen3.8-Flash-Next-Q4.gguf" in cmd:
        return QWEN_NEXT_MODEL_ID
    if "GLM-5.3-Flash-Q2.gguf" in cmd:
        return GLM_FLASH_MODEL_ID
    if "DeepSeek-V4-Pro" in cmd:
        return DS4_PRO_MODEL_ID
    if "DeepSeek-V4-Flash" in cmd or "ds4flash.gguf" in cmd:
        return DS4_FLASH_MODEL_ID
    raise RuntimeError("Unrecognized DS4 process; refusing lifecycle action")


async def detect_ds4_loaded_model(refresh=False):
    global DS4_LOADED_MODEL_ID, DS4_LOADED_CHECK_AT
    now = time.monotonic()
    if not refresh and DS4_LOADED_MODEL_ID and now - DS4_LOADED_CHECK_AT < DS4_CACHE_TTL:
        return DS4_LOADED_MODEL_ID
    model_id = await asyncio.to_thread(_detect_ds4_loaded_model_sync)
    DS4_LOADED_MODEL_ID = model_id
    DS4_LOADED_CHECK_AT = now
    return model_id


def _write_ds4_desired_model_sync(model_id):
    DS4_DESIRED_FILE.parent.mkdir(parents=True, exist_ok=True)
    DS4_DESIRED_FILE.write_text(f"{model_id}\n")


async def ds4_v1_ready():
    try:
        async with ClientSession(timeout=DISCOVERY_TIMEOUT) as sess:
            async with sess.get(f"{BACKENDS['ds4']['v1']}/models", headers=AUTH_HEADERS) as r:
                return r.status == 200
    except Exception:
        return False


async def ds4_is_busy():
    try:
        async with ClientSession(timeout=DISCOVERY_TIMEOUT) as sess:
            async with sess.get(f"{BACKENDS['ds4']['admin']}/api/stats", headers=AUTH_HEADERS) as r:
                if r.status != 200:
                    return True  # Unknown activity is not permission to stop.
                data = await r.json()
        models = data["active_models"]["models"]
        if not isinstance(models, list):
            return True
    except Exception:
        return True

    for model in models:
        if model.get("prefilling") or model.get("generating"):
            return True
    return False


async def wait_for_ds4_model(model_id):
    deadline = time.monotonic() + DS4_SWITCH_TIMEOUT
    while time.monotonic() < deadline:
        loaded = await detect_ds4_loaded_model(refresh=True)
        if loaded == model_id and await ds4_v1_ready():
            return True
        await asyncio.sleep(1)
    return False


async def wait_for_ds4_idle():
    # Also account for work left running after a client disconnect or proxy restart.
    while await detect_ds4_loaded_model(refresh=True) is not None and await ds4_is_busy():
        await asyncio.sleep(1)


# Models whose lifecycle this proxy owns and whose swaps the checked policy
# decides. tunnel/flash-moe backends are external and stay host-side.
DS4_SWAP_MODELS = DS4_MODEL_IDS | {GLM_FLASH_MODEL_ID}


async def refresh_swap_residency():
    """Host-side identity composition for the checked swap policy.

    Loaded-model identity, service state and readiness are foreign observations
    the policy cannot prove. `mlx_unproven` is a host guard fact: the managed
    mlx job is absent (or its checkpoint identity is unproven) while its
    proxy-owned port is occupied, so a listener that is not the managed job may
    be a foreign engine. The policy still models proxy-owned engines only; the
    guard makes transitions fail closed while exclusivity is unproven.

    Returns (resident_model_id_or_None, mlx_unproven).
    """
    try:
        if await asyncio.to_thread(WINNOW.probe):
            # The ordinary path has no native Winnow adapter. Never adopt
            # it as empty and start a second engine after a proxy restart.
            swap_policy.SWAP.adopt_unknown()
            return None, True
    except Exception as exc:
        log.warning(f"swap residency: Winnow identity unproven: {exc}")
        swap_policy.SWAP.adopt_unknown()
        return None, True
    try:
        ds4 = await detect_ds4_loaded_model(refresh=True)
    except Exception as exc:
        log.warning(f"swap residency: ds4 identity unproven: {exc}")
        ds4 = "unknown"
    mlx = None
    mlx_unproven = False
    try:
        if await mlx_service_loaded():
            mlx = await mlx_resident_model()
            if mlx is None:
                mlx_unproven = True
        elif await asyncio.to_thread(swap_policy.port_listening, MLX_PORT):
            # The managed job is not loaded but its port is occupied: the
            # listener is foreign/unproven. Listening is not native-quiescence
            # evidence; it only proves the lane is not proven empty.
            mlx_unproven = True
    except Exception as exc:
        log.warning(f"swap residency: mlx identity unproven: {exc}")
        mlx_unproven = True
    if ds4 == "unknown":
        swap_policy.SWAP.adopt_unknown()
        return None, True
    if mlx is None:
        if mlx_unproven:
            if ds4 is None:
                swap_policy.SWAP.adopt_unknown()
                return None, True
            swap_policy.SWAP.adopt(ds4)
            return ds4, True
        if ds4 is None:
            swap_policy.SWAP.adopt_empty()
            return None, False
        swap_policy.SWAP.adopt(ds4)
        return ds4, False
    if ds4 is None:
        swap_policy.SWAP.adopt(mlx)
        return mlx, False
    # One engine at a time; two proven residents is a contradiction.
    swap_policy.SWAP.adopt_unknown()
    return None, False


async def ensure_ds4_model(model_id):
    """Called with REQUEST_CONDITION held and no admitted requests.

    The checked swap policy decides reuse / stop-then-start / refuse; this host
    proves native quiescence and service exit, executes the physical effects and
    reports the receipts back to the policy.
    """
    resident, mlx_unproven = await refresh_swap_residency()
    if mlx_unproven and resident != model_id:
        raise web.HTTPServiceUnavailable(
            text=json.dumps({"error": {
                "message": f"mlx lane is occupied/unproven; no {model_id} transition while exclusivity is unproven.",
                "type": "swap_lane_unproven",
            }}),
            content_type="application/json",
        )
    action, target = swap_policy.SWAP.admit(model_id, qualified=model_id in DS4_SWAP_MODELS)
    if action == "reuse":
        if await ds4_v1_ready():
            await wait_for_ds4_idle()  # same-model reuse still waits for foreign decode
            return
        swap_policy.SWAP.adopt_unknown()
        raise web.HTTPServiceUnavailable(
            text=json.dumps({"error": {
                "message": f"{model_id} identity matches but backend readiness is unproven; no repair was attempted.",
                "type": "model_switch_unready",
            }}),
            content_type="application/json",
        )
    if action not in ("stop", "start"):
        raise web.HTTPServiceUnavailable(
            text=json.dumps({"error": {
                "message": f"swap policy refused {model_id} ({action}); resident {resident!r} retained.",
                "type": "model_switch_refused",
            }}),
            content_type="application/json",
        )
    mode = _mode_from_model_id(model_id)
    if action == "stop":
        try:
            await wait_for_ds4_idle()  # native quiescence: host fact, not policy state
            if target in MLX_MODEL_IDS:
                await stop_mlx()
            else:
                await stop_dsv4()
        except BaseException:
            try:
                swap_policy.SWAP.stop_unknown()
            except swap_policy.SwapPolicyError as exc:
                log.warning(f"swap policy blocked after stop failure: {exc}")
            raise
        swap_policy.SWAP.stop_done()
    try:
        log.info(f"switching ds4 backend to {model_id}")
        await asyncio.to_thread(_write_ds4_desired_model_sync, mode)
        await start_dsv4()
        if not await wait_for_ds4_model(model_id):
            raise web.HTTPServiceUnavailable(
                text=json.dumps({"error": {
                    "message": f"Failed to load {model_id} ({mode}); no fallback or automatic restore was attempted.",
                    "type": "model_switch_timeout",
                }}),
                content_type="application/json",
            )
    except BaseException:
        try:
            swap_policy.SWAP.start_unknown()
        except swap_policy.SwapPolicyError as exc:
            log.warning(f"swap policy blocked after start failure: {exc}")
        raise
    swap_policy.SWAP.start_ready()
    log.info(f"ds4 backend ready: {model_id}")


def client_disconnected(request):
    if request is None:
        return False
    transport = request.transport
    return transport is None or transport.is_closing()


# Cancel means cancel. Measured 2026-09-22 on the live ds4 engine: closing the
# upstream connection aborts decode in the same second
# (`request aborted; restoring clean abort checkpoint ... reason="cancelled
# during generation"`), so a cancelled request stops working instead of draining
# to EOF. The queue still never overlaps: the successor waits until the engine
# is proven idle below. Backends with no verified abort path keep draining.
ABORT_CONFIRMED_BACKENDS = {"ds4"}


def live_chat_owner():
    """Reuse the RAM-idle clock; never expire an in-flight request."""
    global CHAT_OWNER
    if CHAT_OWNER and not ACTIVE_REQUESTS and time.monotonic() - CHAT_OWNER["last_request_at"] >= DS4_IDLE_TIMEOUT:
        log.info("chat lease expired chat=%s", CHAT_OWNER["chat_id"])
        CHAT_OWNER = None
    return CHAT_OWNER


def admission_order():
    owner = live_chat_owner()
    if not owner or owner.get("release_pending"):
        return REQUEST_QUEUE
    # ponytail: sort pending requests (O(n log n)); index by chat only if queue
    # size becomes material. Ownership is a reservation, not a priority class.
    return sorted(REQUEST_QUEUE, key=lambda t: t["chat_id"] != owner["chat_id"])


def check_inference_certainty():
    if ACTIVE_TICKET and ACTIVE_TICKET.get("uncertain"):
        raise web.HTTPServiceUnavailable(text="Backend completion unknown; admission closed pending operator recovery")


async def begin_request(backend_name, model_id, request=None, managed=False):
    global ACTIVE_MODEL_ID, ACTIVE_REQUESTS, DS4_ACTIVE_REQUESTS, ACTIVE_TICKET, CHAT_OWNER
    global DS4_LOADED_MODEL_ID, DS4_LOADED_CHECK_AT
    if request is not None and not managed:
        reservation_unavailable(request, backend_name)
    check_inference_certainty()
    if request is not None and request.headers.get("X-Pi-Origin") == "vega-rewriter" and (
        ACTIVE_REQUESTS or REQUEST_QUEUE or live_chat_owner() or DS4_SWITCH_LOCK.locked()
    ):
        raise web.HTTPConflict(text="local inference busy; VEGA must reroute")
    request_id = request.headers.get("X-Pi-Request-Id") if request is not None else None
    for existing in [*REQUEST_QUEUE, ACTIVE_TICKET]:
        if request_id and existing and existing["request_id"] == request_id:
            # The ID can no longer identify either caller's progress reliably.
            existing["ambiguous"] = True
            raise web.HTTPConflict(text="X-Pi-Request-Id already in use; send a fresh ID")
    chat_id = request.headers.get("X-Pi-Chat-Id") if request is not None else None
    if chat_id and (len(chat_id) > 128 or not all(c.isascii() and (c.isalnum() or c in "-_") for c in chat_id)):
        raise web.HTTPBadRequest(text="Invalid X-Pi-Chat-Id")
    ticket = {
        "chat_id": chat_id,
        "chat_label": request.headers.get("X-Pi-Chat-Label", "")[:160] if request is not None else "",
        "identity": object(),  # list.remove must not equate anonymous requests
        "backend": backend_name,
        "model": model_id,
        "request_id": request_id,
        "managed": managed,
    }
    # Appending before the first await preserves arrival order even while the
    # head holds DS4_SWITCH_LOCK for a safe backend transition.
    REQUEST_QUEUE.append(ticket)
    log.info("queued request id=%s model=%s position=%d", request_id or "-", model_id, len(REQUEST_QUEUE))
    engine = None
    try:
        async with REQUEST_CONDITION:
            # Track all pending IDs for collision/poll safety. An owner's next
            # request bypasses FIFO, but never an in-flight request.
            while (ACTIVE_REQUESTS or admission_order()[0] is not ticket or
                   (live_chat_owner() and CHAT_OWNER["chat_id"] != chat_id)):
                check_inference_certainty()
                if client_disconnected(request):
                    raise ConnectionResetError("client disconnected while queued")
                try:
                    await asyncio.wait_for(REQUEST_CONDITION.wait(), 0.1)
                except asyncio.TimeoutError:
                    pass
            if client_disconnected(request):
                raise ConnectionResetError("client disconnected while queued")
            if managed and backend_name == 'winnow':
                if INDEPENDENT_SWITCH is None:
                    raise web.HTTPServiceUnavailable(text='Winnow managed switch unavailable')
                engine = await INDEPENDENT_SWITCH.prepare_winnow()
            elif managed:
                # Switch/verify/rebind while no main is admitted and the same
                # condition still excludes every queued request and idle task.
                engine = await reservation_body.prepare_main(model_id)
                DS4_LOADED_MODEL_ID = model_id
                DS4_LOADED_CHECK_AT = time.monotonic()
            elif backend_name == "ds4":
                await ensure_ds4_model(model_id)
            else:
                await prepare_non_ds4_backend(backend_name, model_id)
            if client_disconnected(request):
                raise ConnectionResetError("client disconnected while queued")
            REQUEST_QUEUE.remove(ticket)
            if chat_id:
                now = time.monotonic()
                if not CHAT_OWNER:
                    CHAT_OWNER = {"chat_id": chat_id, "label": ticket["chat_label"], "held_since": now}
                CHAT_OWNER.update(last_request_at=now, request_id=request_id)
            log.info("admitted request id=%s chat=%s model=%s", request_id or "-", chat_id or "-", model_id)
            ACTIVE_MODEL_ID = model_id
            ACTIVE_TICKET = ticket
            ACTIVE_REQUESTS = 1
            if backend_name == "ds4":
                DS4_ACTIVE_REQUESTS += 1
            return engine
    except BaseException:
        if engine is not None and reservation_body.MANAGED_ENGINE_RELEASER:
            reservation_body.MANAGED_ENGINE_RELEASER()
        if ticket in REQUEST_QUEUE:
            REQUEST_QUEUE.remove(ticket)
        if CHAT_OWNER and CHAT_OWNER["chat_id"] == chat_id:
            # A continuation can fail/cancel during preparation, before its new
            # ID is admitted. Do not strand the previous request's reservation.
            if ACTIVE_REQUESTS:
                CHAT_OWNER["release_pending"] = True
            else:
                CHAT_OWNER = None
        # ponytail: disconnect detection polls at 100 ms; replace with an
        # aiohttp transport callback only if queued cancellation latency matters.
        raise


async def begin_independent_kev(request):
    """Borrow the ordinary seat without switching/evicting the idle main model."""
    global ACTIVE_TICKET, ACTIVE_REQUESTS, DS4_ACTIVE_REQUESTS, ACTIVE_MODEL_ID
    if not DUAL_MODELS or INDEPENDENT_SWITCH is None:
        raise RuntimeError('native_independent_adapter_unavailable')
    check_inference_certainty()
    if ACTIVE_REQUESTS and (not ACTIVE_TICKET or not ACTIVE_TICKET.get('independent')) and reservation_body.LIVE is None:
        raise RuntimeError('main_native_binding_pending_or_unsupported_owner')
    ticket = dict(chat_id=None, request_id=str(uuid.uuid4()), backend='ds4',
                  managed=True, independent=True, identity=object())
    REQUEST_QUEUE.append(ticket)
    manager = INDEPENDENT_SWITCH
    try:
        async with REQUEST_CONDITION:
            while ACTIVE_REQUESTS or admission_order()[0] is not ticket:
                check_inference_certainty()
                if reservation_body.LIVE is not None:
                    return None  # take the existing checked pause path instead
                if client_disconnected(request):
                    raise ConnectionResetError('borrower_client_disconnected')
                try:
                    await asyncio.wait_for(REQUEST_CONDITION.wait(), .1)
                except asyncio.TimeoutError:
                    pass
            if reservation_body.LIVE is not None:
                return None
            if client_disconnected(request):
                raise ConnectionResetError('borrower_client_disconnected')
            # A running MLX job can submit without this DS4 terminal gate.
            code, output = await _mlx_launchctl('print', f'gui/{os.getuid()}/{MLX_SERVICE_LABEL}')
            lines = [line.strip() for line in output.splitlines()]
            if code == 0 and (any(line.startswith(b'pid = ') for line in lines) or
                              b'state = waiting' not in lines):
                raise RuntimeError('mlx_native_gate_not_qualified_for_independent_kev')
            if code != 0 and b'Could not find service' not in output:
                raise RuntimeError('mlx_process_state_unknown')
            if manager.blocked:
                raise RuntimeError('managed_native_owner_blocked')
            # ponytail: lease wait holds the admission lock for up to 90s; split it if contention matters.
            await asyncio.wait_for(manager.acquire(), 90)
            try:
                manager.adopt()  # existing pinned Qwen/V4.1 only; never start/switch a model
                engine = manager.engine
                if hashlib.sha256(engine.core.read_bytes()).hexdigest() != COORDINATOR_SHA256:
                    raise RuntimeError('unqualified coordinator binary')
            except BaseException:
                manager.release()  # no native control issued yet
                raise
            ACTIVE_TICKET = ticket
            ACTIVE_REQUESTS = 1
            DS4_ACTIVE_REQUESTS += 1
            ACTIVE_MODEL_ID = manager.model
            try:
                # This native close/status proves idle ownership, not HTTP-idle telemetry.
                await engine.terminal()
            except BaseException as exc:
                ticket['uncertain'] = True
                manager.blocked = repr(exc)
                REQUEST_CONDITION.notify_all()
                raise
            return engine
    finally:
        if ticket in REQUEST_QUEUE:
            REQUEST_QUEUE.remove(ticket)


async def finish_independent_kev(engine, stopped):
    if not stopped:
        await finish_request('ds4', uncertain=True)
        return False  # native borrower stop unknown: keep seat, closed terminal and lease
    try:
        await engine.release_terminal()
    except BaseException:
        await finish_request('ds4', uncertain=True)
        raise
    await finish_request('ds4')
    return True


async def finish_request(backend_name, uncertain=False, release_chat=False):
    global ACTIVE_REQUESTS, DS4_ACTIVE_REQUESTS, DS4_LAST_REQUEST_AT, ACTIVE_TICKET, CHAT_OWNER
    async with REQUEST_CONDITION:
        if uncertain:
            # ponytail: no portable backend completion API. Retain the owner on
            # upstream failure; only operator-verified recovery may reopen admission.
            ACTIVE_TICKET["uncertain"] = True
            REQUEST_CONDITION.notify_all()
            return
        if ACTIVE_TICKET.get('managed') and reservation_body.MANAGED_ENGINE_RELEASER:
            reservation_body.MANAGED_ENGINE_RELEASER()
        ACTIVE_REQUESTS -= 1
        if CHAT_OWNER:
            if not ACTIVE_TICKET.get('independent'):
                CHAT_OWNER["last_request_at"] = time.monotonic()
            if release_chat or CHAT_OWNER.get("release_pending"):
                CHAT_OWNER = None
        ACTIVE_TICKET = None
        if backend_name == "ds4":
            DS4_ACTIVE_REQUESTS -= 1
            DS4_LAST_REQUEST_AT = time.monotonic()
        REQUEST_CONDITION.notify_all()


async def unload_ds4_if_idle(reason):
    await wait_for_ds4_idle()
    if await detect_ds4_loaded_model(refresh=True) is not None:
        log.info(f"unloading dsv4 before {reason} request")
        await stop_dsv4()


async def prepare_non_ds4_backend(backend_name, model_id):
    if backend_name == "mlx":
        # Policy-owned swap: any DS4 eviction is the policy's Stop directive.
        await ensure_mlx_model(model_id)
    else:
        # External backends have no checked Winnow handoff. Refuse rather than
        # overlap an unmanaged request with its resident Metal process.
        if await asyncio.to_thread(WINNOW.probe):
            raise web.HTTPServiceUnavailable(text='Winnow resident; external backend handoff unqualified')
        await unload_ds4_if_idle(backend_name)
        await stop_mlx()


# ── /v1/models (merge) ───────────────────────────────────────────────────────

async def handle_models(request):
    """Merge /v1/models from all reachable backends."""
    async with ClientSession(timeout=DISCOVERY_TIMEOUT) as sess:
        async def one_backend(name, backend):
            try:
                async with sess.get(f"{backend['v1']}/models", headers=AUTH_HEADERS) as r:
                    if r.status != 200:
                        return []
                    data = await r.json()
                    return data.get("data", [])
            except Exception:
                return []

        results = await asyncio.gather(
            *(one_backend(name, backend) for name, backend in BACKENDS.items()),
            return_exceptions=True,
        )

    merged = []
    seen = set()

    # DSV4 advertises switchable IDs regardless of which GGUF is actually loaded.
    # The proxy owns their lifecycle, so expose accurate static metadata here and
    # ignore DSV4's misleading duplicate model records below.
    for model_id in sorted(DS4_MODEL_IDS):
        merged.append(ds4_static_model(model_id))
        seen.add(model_id)

    # mlx-lm serves one checkpoint and reports its path as the model id, so the
    # proxy advertises the stable ID whether or not the job is currently loaded.
    for model_id, cfg in MLX_MODEL_METADATA.items():
        merged.append(mlx_static_model(model_id, cfg))
        seen.add(model_id)

    for name, result in zip(BACKENDS, results):
        if name in ("ds4", "mlx") or isinstance(result, Exception):
            continue
        for model in result:
            model_id = model.get("id")
            if not model_id or model_id in seen or model_id in DS4_MODEL_IDS:
                continue
            seen.add(model_id)
            merged.append(model)

    return web.json_response({"object": "list", "data": merged})


# ── /v1/chat/completions (route by model) ───────────────────────────────────

def mark_reservation_blocked():
    if ACTIVE_TICKET:
        ACTIVE_TICKET['uncertain'] = True


async def handle_chat(request):
    """Route /v1/chat/completions to the right backend, streaming passthrough."""
    global DS4_ACTIVE_REQUESTS
    body = await request.read()
    model_id = ""
    is_stream = False
    payload, err = parse_json_body(body)
    if not err and isinstance(payload, dict):
        model_id = payload.get("model", "")
        is_stream = bool(payload.get("stream", False))

    backend_name = get_backend_name(model_id)
    if RESERVATION_TRIAL and backend_name in ('ds4', 'mlx'):
        return await reservation_body.handle_main(request, body, backend_name, model_id,
            CheckedReservation, begin_request, finish_request, REQUEST_CONDITION,
            BACKENDS[backend_name]['v1'], mark_reservation_blocked)
    started = forwarded = complete = cancelled = False
    try:
        await begin_request(backend_name, model_id, request)
        started = True

        backend = BACKENDS[backend_name]["v1"]
        body = maybe_prepare_chat_body(backend_name, body)
        log.info(f"routing {model_id} -> {backend}")

        headers = {
            "Authorization": request.headers.get("Authorization", AUTH_HEADERS["Authorization"]),
            "Content-Type": "application/json",
        }
        for name in ("X-Pi-Request-Id", "X-Pi-Origin", "X-Pi-Live-Answer"):
            if value := request.headers.get(name):
                headers[name] = value
        # Pi marks its own requests with X-Pi-Live-Answer; the tunnel-style
        # headers stay a fallback marker for clients that only send those.
        if "X-Pi-Live-Answer" not in headers and (
            headers.get("X-Pi-Request-Id") or headers.get("X-Pi-Origin")
        ):
            headers["X-Pi-Live-Answer"] = "1"
        log.debug("request provenance id=%s origin=%s", headers.get("X-Pi-Request-Id"), headers.get("X-Pi-Origin"))

        async with ClientSession(timeout=CHAT_TIMEOUT) as sess:
            forwarded = True
            async with sess.post(f"{backend}/chat/completions", data=body, headers=headers) as resp:
                if is_stream and resp.content_type == "text/event-stream":
                    response = web.StreamResponse(
                        status=resp.status,
                        headers={
                            "Content-Type": "text/event-stream",
                            "Cache-Control": "no-cache",
                            "Connection": "keep-alive",
                        },
                    )
                    client_gone = client_disconnected(request)
                    if not client_gone:
                        try:
                            await response.prepare(request)
                        except (ConnectionResetError, ConnectionAbortedError):
                            client_gone = True
                    flash_req_id = flash_start(model_id) if backend_name == "flash_moe" else None
                    flash_buf = ""
                    abort_on_cancel = backend_name in ABORT_CONFIRMED_BACKENDS
                    try:
                        async for chunk in resp.content.iter_any():
                            if client_gone and abort_on_cancel:
                                # Stop forwarding and close upstream now; the engine
                                # aborts on close. Proven quiescence in the outer
                                # finally gates the next owner, so requests still
                                # never share it.
                                cancelled = True
                                break
                            if flash_req_id:
                                flash_buf = flash_observe_chunk(flash_req_id, flash_buf, chunk)
                            if not client_gone:
                                try:
                                    await response.write(chunk)
                                except (ConnectionResetError, ConnectionAbortedError):
                                    client_gone = True
                                    if abort_on_cancel:
                                        cancelled = True
                                        break
                        complete = True
                        if not client_gone:
                            await response.write_eof()
                    finally:
                        flash_finish(flash_req_id)
                    return response

                if backend_name in ABORT_CONFIRMED_BACKENDS and client_disconnected(request):
                    # Already cancelled: do not start reading a response nobody wants.
                    cancelled = True
                    return web.Response(status=499, text="client cancelled")
                data = await resp.read()
                complete = True
                return web.Response(status=resp.status, body=data, content_type=resp.content_type)
    except ConnectionResetError:
        if not started:
            return web.Response(status=499, text="client cancelled before admission")
        raise
    finally:
        if started:
            if cancelled:
                # Reuse the same quiescence wait model switching already uses: the
                # next owner is admitted only once the engine reports it stopped.
                await wait_for_ds4_idle()
            await finish_request(backend_name, uncertain=forwarded and not complete and not cancelled,
                                 release_chat=cancelled or client_disconnected(request))


async def handle_systemone(request):
    """Decision-only Winnow entry; no chat route and no direct public GPU port."""
    if request.headers.get('Authorization') != AUTH_HEADERS['Authorization']:
        raise web.HTTPUnauthorized()
    body = await request.content.read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise web.HTTPRequestEntityTooLarge(max_size=1024 * 1024, actual_size=len(body))
    payload, err = parse_json_body(body)
    if err or not isinstance(payload, dict) or payload.get('model') != WINNOW_MODEL_ID:
        raise web.HTTPBadRequest(text='Explicit model winnow-12b required; Kev/jev aliases are retired')
    if not isinstance(payload.get('questions'), dict) or not payload['questions'] or \
       payload.get('state') is None:
        raise web.HTTPBadRequest(text='Winnow requires state and named questions')
    if INDEPENDENT_SWITCH is None:
        raise web.HTTPServiceUnavailable(text='managed Winnow route unavailable')
    payload['model'] = WINNOW_UPSTREAM_ID
    started = forwarded = complete = False
    try:
        await begin_request('winnow', WINNOW_MODEL_ID, request, managed=True)
        started = True
        async with ClientSession(timeout=CHAT_TIMEOUT) as session:
            forwarded = True
            async with session.post(f'http://127.0.0.1:{WINNOW_PORT}/v1/systemone',
                 json=payload, headers=AUTH_HEADERS) as upstream:
                result = await upstream.read()  # Drain even if the caller disconnects.
                if upstream.status == 200:
                    answer = json.loads(result)
                    if not isinstance(answer, dict) or answer.get('model') != WINNOW_UPSTREAM_ID or \
                       not isinstance(answer.get('answers'), dict) or \
                       set(answer['answers']) != set(payload['questions']):
                        raise RuntimeError('Winnow response identity/questions mismatch')
                    complete = True  # Error bodies and unverified answers are not native-stop proof.
                return web.Response(status=upstream.status, body=result,
                                    content_type=upstream.content_type)
    except ConnectionResetError:
        if not started:
            return web.Response(status=499, text='client cancelled before admission')
        raise
    finally:
        if started:
            await finish_request('winnow', uncertain=forwarded and not complete,
                                 release_chat=client_disconnected(request))


async def handle_systemone_models(request):
    if request.headers.get('Authorization') != AUTH_HEADERS['Authorization']:
        raise web.HTTPUnauthorized()
    return web.json_response({'object': 'list', 'data': [
        {'id': WINNOW_MODEL_ID, 'name': WINNOW_UPSTREAM_ID, 'type': 'decision',
         'context_length': 65536, 'owned_by': 'winnow-inference'}]})


async def handle_release_chat(request):
    """Authenticated explicit handoff, never preemption of running inference."""
    global CHAT_OWNER
    if request.headers.get("Authorization") != AUTH_HEADERS["Authorization"]:
        raise web.HTTPUnauthorized()
    try:
        body = await request.json()
    except (ValueError, TypeError):
        raise web.HTTPBadRequest(text="Expected JSON object")
    if not isinstance(body, dict) or not isinstance(body.get("chat_id"), str):
        raise web.HTTPBadRequest(text="chat_id required")
    async with REQUEST_CONDITION:
        check_inference_certainty()
        owner = live_chat_owner()
        if not owner or owner["chat_id"] != body["chat_id"]:
            raise web.HTTPConflict(text="Chat no longer owns the engine")
        if body.get("operator") is not True and (not body.get("request_id") or body["request_id"] != owner["request_id"]):
            raise web.HTTPConflict(text="Stale chat release")
        if ACTIVE_REQUESTS:
            owner["release_pending"] = True
        else:
            CHAT_OWNER = None
        REQUEST_CONDITION.notify_all()
        return web.json_response({"released": CHAT_OWNER is None, "release_pending": CHAT_OWNER is not None})


# ── /admin/api/login (no backend requires it) ───────────────────────────────

async def handle_admin_login(request):
    """No backend needs a login session any more (mlx-lm/ds4/llama.cpp are
    static-bearer or unauthenticated); 204 keeps clients that still try."""
    await request.read()
    return web.Response(status=204)


# ── /admin/api/stats (merge from backends) ──────────────────────────────────

async def handle_admin_stats(request):
    """Poll admin/stats and merge results with synthesized Flash-MoE activity."""
    owner = ACTIVE_TICKET
    cookie = request.headers.get("Cookie", "")
    auth = request.headers.get("Authorization", AUTH_HEADERS["Authorization"])

    async def fetch_admin_models(sess, name):
        backend = BACKENDS[name]
        headers = {"Authorization": auth or AUTH_HEADERS["Authorization"]}
        if cookie:
            headers["Cookie"] = cookie
        try:
            # DS4 advertises aliases, not the resident GGUF. Bracket the poll
            # with fresh residency checks; omit uncertain/switching telemetry.
            resident = await detect_ds4_loaded_model(refresh=True) if name == "ds4" else None
            async with sess.get(f"{backend['admin']}/api/stats", headers=headers) as r:
                if r.status != 200:
                    return []
                data = await r.json()
                models = data.get("active_models", {}).get("models", [])
            if name == "ds4":
                if not resident or resident != await detect_ds4_loaded_model(refresh=True):
                    return []
                models = [dict(m, id=resident) for m in models]
            return models
        except Exception:
            return []

    async with ClientSession(timeout=DISCOVERY_TIMEOUT) as sess:
        results = await asyncio.gather(
            *(fetch_admin_models(sess, name) for name in ("ds4", "tunnel")),
            return_exceptions=True,
        )

    request_id = request.headers.get("X-Pi-Request-Id")
    ticket = next((item for item in [*REQUEST_QUEUE, ACTIVE_TICKET]
                   if request_id and item and item["request_id"] == request_id), None)
    state = "unknown"
    queue_position = None
    if ticket:
        if ticket.get("ambiguous"):
            state = "ambiguous"
        elif ticket.get("uncertain"):
            state = "uncertain"
        elif ticket is ACTIVE_TICKET:
            state = "active"
        else:
            state = "queued"
            queue_position = admission_order().index(ticket) + 1
    merged = {
        "active_models": {"models": []},
        "queue_depth": len(REQUEST_QUEUE),
        "queue_position": queue_position,
        "request_state": state,
        "chat_owner": (dict(CHAT_OWNER, held_seconds=time.monotonic() - CHAT_OWNER["held_since"])
                       if live_chat_owner() else None),
    }
    # Only authenticated, matching request IDs may see retained-owner telemetry.
    if RESERVATION_TRIAL and request.headers.get('Authorization') == AUTH_HEADERS['Authorization'] and request_id:
        if detail := reservation_body.status(request_id):
            merged['reservation'] = detail
    # No correlated poll may display another owner, including a turnover during
    # the backend poll. Uncorrelated admin clients retain the global view.
    if request_id and (state != "active" or owner is not ACTIVE_TICKET):
        return web.json_response(merged)
    seen_ids = set()
    for models in results:
        if isinstance(models, Exception):
            continue
        for m in models:
            # Skip idle models so the extension's findBestMatch latches
            # onto whichever backend is actually doing work.
            if not m.get("prefilling") and not m.get("generating"):
                continue
            if m.get("id") not in seen_ids:
                seen_ids.add(m.get("id"))
                merged["active_models"]["models"].append(m)

    for m in build_flash_admin_models():
        if m.get("id") not in seen_ids:
            seen_ids.add(m.get("id"))
            merged["active_models"]["models"].append(m)

    return web.json_response(merged)


# ── Catch-all: proxy any other /v1/* request ────────────────────────────────

async def handle_other(request):
    """Proxy any other /v1/* request to the right backend."""
    global DS4_ACTIVE_REQUESTS
    path = request.path[len("/v1"):]
    body = await request.read() if request.method in ("POST", "PUT") else None

    model_id = ""
    if body:
        payload, err = parse_json_body(body)
        if not err and isinstance(payload, dict):
            model_id = payload.get("model", "")
    backend_name = get_backend_name(model_id)
    started = forwarded = complete = False

    try:
        await begin_request(backend_name, model_id, request)
        started = True
        if body:
            body = maybe_prepare_flash_body(backend_name, body)

        backend = BACKENDS[backend_name]["v1"]
        headers = {
            "Authorization": request.headers.get("Authorization", AUTH_HEADERS["Authorization"]),
            "Cookie": request.headers.get("Cookie", ""),
        }
        if body:
            headers["Content-Type"] = request.headers.get("Content-Type", "application/json")
        if request.query_string:
            path = f"{path}?{request.query_string}"

        async with ClientSession(timeout=CHAT_TIMEOUT) as sess:
            meth = getattr(sess, request.method.lower())
            forwarded = True
            async with meth(f"{backend}{path}", data=body, headers=headers) as resp:
                data = await resp.read()
                complete = True
                return web.Response(status=resp.status, body=data, content_type=resp.content_type)
    except ConnectionResetError:
        if not started:
            return web.Response(status=499, text="client cancelled before admission")
        raise
    finally:
        if started:
            await finish_request(backend_name, uncertain=forwarded and not complete,
                                 release_chat=client_disconnected(request))


# ── Main ─────────────────────────────────────────────────────────────────────

async def main():
    global DS4_LAST_REQUEST_AT, INDEPENDENT_SWITCH
    if DUAL_MODELS:
        from managed_switch import ManagedSwitch
        manager = INDEPENDENT_SWITCH = ManagedSwitch(winnow=WINNOW)
        reservation_body.MANAGED_ENGINE_PREPARER = manager.prepare
        reservation_body.MANAGED_ENGINE_RELEASER = manager.release
        reservation_body.INDEPENDENT_ADMITTER = begin_independent_kev
        reservation_body.INDEPENDENT_RELEASER = finish_independent_kev
    if await detect_ds4_loaded_model(refresh=True) is not None:
        DS4_LAST_REQUEST_AT = time.monotonic()
    await discover_models()
    asyncio.create_task(periodic_discover())
    if not (RESERVATION_TRIAL and os.getenv('LOCAL_PROXY_PRIVATE_LEASE') == '1'):
        asyncio.create_task(ds4_idle_check_loop())
        asyncio.create_task(mlx_idle_check_loop())

    app = web.Application(client_max_size=1024 * 1024 * 1024)
    app.router.add_get("/v1/models", handle_models)
    app.router.add_post("/v1/chat/completions", handle_chat)
    app.router.add_post('/v1/systemone', handle_systemone)
    app.router.add_get('/v1/systemone/models', handle_systemone_models)
    app.router.add_post("/admin/api/login", handle_admin_login)
    app.router.add_get("/admin/api/stats", handle_admin_stats)
    app.router.add_post("/admin/api/release-chat", handle_release_chat)
    app.router.add_route("*", "/v1/{tail:.*}", handle_other)
    app.router.add_get("/health", lambda r: web.json_response({
        "status": "ok",
        "models_by_backend": {k: sorted(v["models"]) for k, v in BACKENDS.items()},
        "routes": MODEL_BACKENDS,
        "ds4_loaded_model": DS4_LOADED_MODEL_ID,
        "ds4_active_requests": DS4_ACTIVE_REQUESTS,
        "ds4_idle_timeout": DS4_IDLE_TIMEOUT,
        "ds4_switchable_models": sorted(DS4_MODEL_IDS),
        # Backwards-compatible field used by old quick checks.
        "ds4_models": sorted(BACKENDS["ds4"]["models"]),
    }))

    log.info(f"local-proxy listening on :{LISTEN_PORT}")
    # Keep draining admitted work after client disconnect; never cancel its owner.
    runner = web.AppRunner(app, handler_cancellation=False)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", LISTEN_PORT)
    await site.start()

    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
