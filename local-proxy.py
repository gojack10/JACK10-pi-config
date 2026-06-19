#!/usr/bin/env python3
"""
Local LLM proxy: merges ds4-server (:8001), omlx (:8000), the tunnel
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
import time
import uuid
from pathlib import Path
from aiohttp import ClientSession, ClientTimeout, CookieJar, web

CHAT_TIMEOUT = ClientTimeout(total=None, sock_connect=10, sock_read=None)
DISCOVERY_TIMEOUT = ClientTimeout(total=5, sock_connect=2, sock_read=5)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("local-proxy")

DS4_PORT = 8001
OMLX_PORT = 8000
TUNNEL_PORT = 8003
FLASH_MOE_PORT = 8004
LISTEN_PORT = 8002

QWEN_FLASH_MODEL_ID = "qwen36-35b-a3b-flash-moe"
DS4_FLASH_MODEL_ID = "tunnel-model"
DS4_PRO_MODEL_ID = "deepseek-v4-pro"
DS4_MODEL_IDS = {DS4_FLASH_MODEL_ID, DS4_PRO_MODEL_ID}
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
        "context_length": 524288,
        "max_completion_tokens": 393216,
    },
    DS4_PRO_MODEL_ID: {
        "name": "DeepSeek V4 Pro",
        "context_length": 393216,
        "max_completion_tokens": 393216,
    },
}
DS4_LOADED_MODEL_ID = None
DS4_LOADED_CHECK_AT = 0.0
DS4_SWITCH_LOCK = asyncio.Lock()

DS4_IDLE_TIMEOUT = 60
DS4_ACTIVE_REQUESTS = 0
DS4_LAST_REQUEST_AT = 0.0
DS4_IDLE_TASK = None

OMLX_ADMIN_COOKIE = None
OMLX_LOGIN_LOCK = asyncio.Lock()

AUTH_HEADERS = {"Authorization": "Bearer REDACTED-LOCAL-KEY"}

BACKENDS = {
    "ds4": {
        "label": "ds4",
        "v1": f"http://127.0.0.1:{DS4_PORT}/v1",
        "admin": f"http://127.0.0.1:{DS4_PORT}/admin",
        "models": set(),
    },
    "omlx": {
        "label": "omlx",
        "v1": f"http://127.0.0.1:{OMLX_PORT}/v1",
        "admin": f"http://127.0.0.1:{OMLX_PORT}/admin",
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
    DS4_FLASH_MODEL_ID: "ds4",
    DS4_PRO_MODEL_ID: "ds4",
    QWEN_FLASH_MODEL_ID: "flash_moe",
}
MODEL_BACKENDS = dict(STATIC_MODEL_BACKENDS)
DEFAULT_BACKEND = "omlx"

# Active Flash-MoE requests, populated by proxied streaming SSE chunks.
FLASH_ACTIVE = {}


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
    if model_id in STATIC_MODEL_BACKENDS:
        return STATIC_MODEL_BACKENDS[model_id]
    return MODEL_BACKENDS.get(model_id, DEFAULT_BACKEND)


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
    if payload.get("model") not in DS4_MODEL_IDS:
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
    return body


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


async def omlx_admin_login():
    global OMLX_ADMIN_COOKIE
    async with OMLX_LOGIN_LOCK:
        if OMLX_ADMIN_COOKIE:
            return OMLX_ADMIN_COOKIE
        try:
            jar = CookieJar()
            async with ClientSession(timeout=DISCOVERY_TIMEOUT, cookie_jar=jar) as sess:
                payload = {"api_key": "REDACTED-LOCAL-KEY"}
                async with sess.post(
                    f"{BACKENDS['omlx']['admin']}/api/login",
                    json=payload,
                ) as r:
                    if r.status != 200:
                        log.warning(f"omlx admin login failed: HTTP {r.status}")
                        return None
                    for cookie in jar:
                        if cookie.key == "session":
                            OMLX_ADMIN_COOKIE = f"session={cookie.value}"
                            log.info("omlx admin session obtained")
                            return OMLX_ADMIN_COOKIE
        except Exception as e:
            log.warning(f"omlx admin login error: {e}")
        return None


def _omlx_admin_headers():
    h = {"Authorization": AUTH_HEADERS["Authorization"]}
    if OMLX_ADMIN_COOKIE:
        h["Cookie"] = OMLX_ADMIN_COOKIE
    return h


async def omlx_loaded_model_ids():
    await omlx_admin_login()
    try:
        async with ClientSession(timeout=DISCOVERY_TIMEOUT) as sess:
            async with sess.get(
                f"{BACKENDS['omlx']['admin']}/api/stats",
                headers=_omlx_admin_headers(),
            ) as r:
                if r.status != 200:
                    return []
                data = await r.json()
    except Exception:
        return []
    ids = set()
    for model in data.get("active_models", {}).get("models", []):
        mid = model.get("id")
        if mid:
            ids.add(mid)
    return list(ids)


async def omlx_unload_ids(ids):
    ids = list(ids)
    if not ids:
        return
    log.info(f"unloading omlx models: {ids}")
    await omlx_admin_login()
    async with ClientSession(timeout=ClientTimeout(total=30)) as sess:
        for mid in ids:
            try:
                async with sess.post(
                    f"{BACKENDS['omlx']['admin']}/api/models/{mid}/unload",
                    headers=_omlx_admin_headers(),
                ) as r:
                    if r.status in (200, 204):
                        log.info(f"omlx unloaded: {mid}")
                    else:
                        log.warning(f"omlx unload {mid}: HTTP {r.status}")
            except Exception as e:
                log.warning(f"omlx unload {mid}: {e}")
    await asyncio.sleep(2)


async def omlx_unload_all():
    await omlx_unload_ids(await omlx_loaded_model_ids())


async def omlx_unload_except(model_id):
    ids = [mid for mid in await omlx_loaded_model_ids() if mid != model_id]
    await omlx_unload_ids(ids)


async def stop_dsv4():
    uid = os.getuid()
    domain = f"gui/{uid}"
    log.info("stopping dsv4")
    try:
        proc = await asyncio.create_subprocess_exec(
            "/bin/launchctl", "bootout", f"gui/{uid}/{DS4_SERVICE_LABEL}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
        if proc.returncode != 0 and b"Could not find service" not in stderr:
            log.warning(f"launchctl bootout: {stderr.decode()[:200]}")
    except Exception as e:
        log.warning(f"stop_dsv4 error: {e}")
    global DS4_LOADED_MODEL_ID, DS4_LOADED_CHECK_AT
    DS4_LOADED_MODEL_ID = None
    DS4_LOADED_CHECK_AT = 0.0


async def start_dsv4():
    uid = os.getuid()
    plist = str(Path.home() / "Library" / "LaunchAgents" / "com.dsv4.server.plist")
    log.info("starting dsv4")
    try:
        # Bootstrap the service definition (idempotent if already loaded).
        proc = await asyncio.create_subprocess_exec(
            "/bin/launchctl", "bootstrap", f"gui/{uid}", plist,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
        if proc.returncode != 0:
            err = (stderr or stdout).decode()[:300]
            log.debug(f"launchctl bootstrap note: {err}")
        # Kickstart to actually run the service.
        proc2 = await asyncio.create_subprocess_exec(
            "/bin/launchctl", "kickstart", f"gui/{uid}/{DS4_SERVICE_LABEL}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout2, stderr2 = await asyncio.wait_for(proc2.communicate(), timeout=15)
        if proc2.returncode != 0:
            err2 = (stderr2 or stdout2).decode()[:300]
            log.warning(f"launchctl kickstart: {err2}")
    except Exception as e:
        log.warning(f"start_dsv4 error: {e}")


async def ds4_idle_check_loop():
    global DS4_LAST_REQUEST_AT
    while True:
        await asyncio.sleep(30)
        try:
            now = time.monotonic()
            if DS4_ACTIVE_REQUESTS > 0:
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
                if DS4_ACTIVE_REQUESTS > 0 or await ds4_is_busy():
                    DS4_LAST_REQUEST_AT = time.monotonic()
                    continue
                if time.monotonic() - DS4_LAST_REQUEST_AT < DS4_IDLE_TIMEOUT:
                    continue
                await stop_dsv4()
                DS4_LAST_REQUEST_AT = 0.0
        except Exception as e:
            log.warning(f"idle loop: {e}")


# ── DS4 model switching ──────────────────────────────────────────────────────


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
    return None


def _mode_from_model_id(model_id):
    if model_id == DS4_PRO_MODEL_ID:
        return "pro"
    return "flash"


def _detect_ds4_loaded_model_sync():
    try:
        out = subprocess.check_output(
            ["/bin/ps", "-axo", "pid=,command="],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None

    ds4_lines = []
    for line in out.splitlines():
        if "/Users/jack/dsv4/ds4-server" not in line:
            continue
        if "--port 8001" not in line and "--port" not in line:
            continue
        ds4_lines.append(line)

    if not ds4_lines:
        return None

    cmd = ds4_lines[-1]
    if "DeepSeek-V4-Pro" in cmd or "--ssd-streaming" in cmd:
        return DS4_PRO_MODEL_ID
    return DS4_FLASH_MODEL_ID


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


def _kickstart_ds4_sync():
    target = f"gui/{os.getuid()}/{DS4_SERVICE_LABEL}"
    try:
        subprocess.run(
            ["/bin/launchctl", "kickstart", "-k", target],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError((e.stderr or e.stdout or str(e)).strip()) from e


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
                    return False
                data = await r.json()
    except Exception:
        return False

    for model in data.get("active_models", {}).get("models", []):
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


async def ensure_ds4_model(model_id):
    if model_id not in DS4_MODEL_IDS:
        return

    async with DS4_SWITCH_LOCK:
        loaded = await detect_ds4_loaded_model(refresh=True)
        if loaded == model_id and await ds4_v1_ready():
            return

        if loaded and loaded != model_id and await ds4_is_busy():
            raise web.HTTPConflict(
                text=json.dumps({
                    "error": {
                        "message": "DSV4 is busy with another request; try again when the current generation finishes.",
                        "type": "model_switch_busy",
                    }
                }),
                content_type="application/json",
            )

        # Pre-emptively free omlx memory before loading dsv4.
        await omlx_unload_all()

        mode = _mode_from_model_id(model_id)
        log.info(f"switching ds4 backend to {model_id}")

        if loaded is not None:
            await stop_dsv4()
            await asyncio.sleep(3)

        await asyncio.to_thread(_write_ds4_desired_model_sync, model_id)
        await start_dsv4()

        global DS4_LOADED_MODEL_ID, DS4_LOADED_CHECK_AT
        DS4_LOADED_MODEL_ID = None
        DS4_LOADED_CHECK_AT = 0.0

        if not await wait_for_ds4_model(model_id):
            raise web.HTTPServiceUnavailable(
                text=json.dumps({
                    "error": {
                        "message": f"Timed out waiting for DSV4 to load {model_id} ({mode}).",
                        "type": "model_switch_timeout",
                    }
                }),
                content_type="application/json",
            )
        log.info(f"ds4 backend ready: {model_id}")


def finish_ds4_request(started):
    global DS4_ACTIVE_REQUESTS, DS4_LAST_REQUEST_AT
    if not started:
        return
    DS4_ACTIVE_REQUESTS = max(0, DS4_ACTIVE_REQUESTS - 1)
    DS4_LAST_REQUEST_AT = time.monotonic()


async def unload_ds4_if_idle(reason):
    if DS4_ACTIVE_REQUESTS > 0:
        return
    if await detect_ds4_loaded_model(refresh=True) is not None:
        log.info(f"unloading dsv4 before {reason} request")
        await stop_dsv4()


async def prepare_non_ds4_backend(backend_name, model_id):
    await unload_ds4_if_idle(backend_name)
    if backend_name == "omlx":
        await omlx_unload_except(model_id)
    else:
        await omlx_unload_all()


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

    # DSV4 advertises both IDs regardless of which GGUF is actually loaded.
    # The proxy owns the real Flash/Pro lifecycle, so expose accurate static
    # metadata here and ignore DSV4's misleading duplicate model records below.
    for model_id in (DS4_FLASH_MODEL_ID, DS4_PRO_MODEL_ID):
        merged.append(ds4_static_model(model_id))
        seen.add(model_id)

    for result in results:
        if isinstance(result, Exception):
            continue
        for model in result:
            model_id = model.get("id")
            if not model_id or model_id in seen or model_id in DS4_MODEL_IDS:
                continue
            seen.add(model_id)
            merged.append(model)

    return web.json_response({"object": "list", "data": merged})


# ── /v1/chat/completions (route by model) ───────────────────────────────────

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
    is_ds4 = backend_name == "ds4" and model_id in DS4_MODEL_IDS
    ds4_started = False
    try:
        if is_ds4:
            DS4_ACTIVE_REQUESTS += 1
            ds4_started = True
            await ensure_ds4_model(model_id)
        else:
            await prepare_non_ds4_backend(backend_name, model_id)

        backend = BACKENDS[backend_name]["v1"]
        body = maybe_prepare_chat_body(backend_name, body)
        log.info(f"routing {model_id} -> {backend}")

        headers = {
            "Authorization": request.headers.get("Authorization", AUTH_HEADERS["Authorization"]),
            "Content-Type": "application/json",
        }

        async with ClientSession(timeout=CHAT_TIMEOUT) as sess:
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
                    await response.prepare(request)

                    client_gone = False
                    flash_req_id = flash_start(model_id) if backend_name == "flash_moe" else None
                    flash_buf = ""

                    async def watchdog():
                        nonlocal client_gone
                        while not client_gone:
                            await asyncio.sleep(0.5)
                            t = request.transport
                            if t is None or t.is_closing():
                                client_gone = True
                                log.info("client disconnected during stream; closing backend connection")
                                resp.close()
                                return

                    watchdog_task = asyncio.create_task(watchdog())
                    try:
                        async for chunk in resp.content.iter_any():
                            if flash_req_id:
                                flash_buf = flash_observe_chunk(flash_req_id, flash_buf, chunk)
                            try:
                                await response.write(chunk)
                            except (ConnectionResetError, ConnectionAbortedError):
                                client_gone = True
                                log.info("client write failed; closing backend connection")
                                resp.close()
                                break
                        if not client_gone:
                            await response.write_eof()
                    except Exception as e:
                        if not client_gone:
                            raise
                        log.info(f"backend read aborted after client disconnect: {e!r}")
                    finally:
                        watchdog_task.cancel()
                        flash_finish(flash_req_id)
                    return response

                async def read_or_abort():
                    nonlocal_client_gone = {"v": False}

                    async def watchdog():
                        while not nonlocal_client_gone["v"]:
                            await asyncio.sleep(0.5)
                            t = request.transport
                            if t is None or t.is_closing():
                                nonlocal_client_gone["v"] = True
                                resp.close()
                                return

                    wd = asyncio.create_task(watchdog())
                    try:
                        return await resp.read(), nonlocal_client_gone["v"]
                    finally:
                        wd.cancel()

                data, gone = await read_or_abort()
                if gone:
                    log.info("client disconnected during non-stream read; backend closed")
                return web.Response(status=resp.status, body=data, content_type=resp.content_type)
    finally:
        finish_ds4_request(ds4_started)


# ── /admin/api/login (forward to omlx) ──────────────────────────────────────

async def handle_admin_login(request):
    """Forward login to omlx (ds4/llama.cpp do not need auth)."""
    body = await request.read()
    headers = {
        "Content-Type": request.headers.get("Content-Type", "application/json"),
    }
    async with ClientSession(timeout=DISCOVERY_TIMEOUT) as sess:
        async with sess.post(f"{BACKENDS['omlx']['admin']}/api/login", data=body, headers=headers) as resp:
            data = await resp.read()
            response = web.Response(status=resp.status, body=data, content_type=resp.content_type)
            if resp.headers.get("Set-Cookie"):
                response.headers["Set-Cookie"] = resp.headers["Set-Cookie"]
            return response


# ── /admin/api/stats (merge from backends) ──────────────────────────────────

async def handle_admin_stats(request):
    """Poll admin/stats and merge results with synthesized Flash-MoE activity."""
    cookie = request.headers.get("Cookie", "")
    auth = request.headers.get("Authorization", AUTH_HEADERS["Authorization"])

    async def fetch_admin_models(sess, name):
        backend = BACKENDS[name]
        headers = {"Authorization": auth or AUTH_HEADERS["Authorization"]}
        if cookie:
            headers["Cookie"] = cookie
        try:
            async with sess.get(f"{backend['admin']}/api/stats", headers=headers) as r:
                if r.status != 200:
                    return []
                data = await r.json()
                return data.get("active_models", {}).get("models", [])
        except Exception:
            return []

    async with ClientSession(timeout=DISCOVERY_TIMEOUT) as sess:
        results = await asyncio.gather(
            *(fetch_admin_models(sess, name) for name in ("ds4", "omlx", "tunnel")),
            return_exceptions=True,
        )

    ds4_loaded_model_id = await detect_ds4_loaded_model()
    merged = {"active_models": {"models": []}}
    seen_ids = set()
    for models in results:
        if isinstance(models, Exception):
            continue
        for m in models:
            if m.get("id") in DS4_MODEL_IDS:
                m = dict(m)
                m["id"] = ds4_loaded_model_id or DS4_FLASH_MODEL_ID
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
    backend_name = DEFAULT_BACKEND
    if body:
        payload, err = parse_json_body(body)
        if not err and isinstance(payload, dict):
            model_id = payload.get("model", "")
            if model_id:
                backend_name = get_backend_name(model_id)
    is_ds4 = backend_name == "ds4" and model_id in DS4_MODEL_IDS
    ds4_started = False

    try:
        if is_ds4:
            DS4_ACTIVE_REQUESTS += 1
            ds4_started = True
            await ensure_ds4_model(model_id)
        else:
            await prepare_non_ds4_backend(backend_name, model_id)
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
            async with meth(f"{backend}{path}", data=body, headers=headers) as resp:
                data = await resp.read()
                return web.Response(status=resp.status, body=data, content_type=resp.content_type)
    finally:
        finish_ds4_request(ds4_started)


# ── Main ─────────────────────────────────────────────────────────────────────

async def main():
    global DS4_LAST_REQUEST_AT
    if await detect_ds4_loaded_model(refresh=True) is not None:
        DS4_LAST_REQUEST_AT = time.monotonic()
    await discover_models()
    asyncio.create_task(periodic_discover())
    asyncio.create_task(ds4_idle_check_loop())

    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.router.add_get("/v1/models", handle_models)
    app.router.add_post("/v1/chat/completions", handle_chat)
    app.router.add_post("/admin/api/login", handle_admin_login)
    app.router.add_get("/admin/api/stats", handle_admin_stats)
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
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", LISTEN_PORT)
    await site.start()

    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
