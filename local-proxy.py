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
import time
import uuid
from aiohttp import ClientSession, ClientTimeout, web

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

# Static route lets Qwen route correctly immediately after the proxy starts,
# even before the first successful /v1/models discovery from llama-server.
STATIC_MODEL_BACKENDS = {
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
    for result in results:
        if isinstance(result, Exception):
            continue
        for model in result:
            model_id = model.get("id")
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            merged.append(model)

    return web.json_response({"object": "list", "data": merged})


# ── /v1/chat/completions (route by model) ───────────────────────────────────

async def handle_chat(request):
    """Route /v1/chat/completions to the right backend, streaming passthrough."""
    body = await request.read()
    model_id = ""
    is_stream = False
    payload, err = parse_json_body(body)
    if not err and isinstance(payload, dict):
        model_id = payload.get("model", "")
        is_stream = bool(payload.get("stream", False))

    backend_name = get_backend_name(model_id)
    backend = BACKENDS[backend_name]["v1"]
    body = maybe_prepare_flash_body(backend_name, body)
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
            else:
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

    merged = {"active_models": {"models": []}}
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


# ── Main ─────────────────────────────────────────────────────────────────────

async def main():
    await discover_models()
    asyncio.create_task(periodic_discover())

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
