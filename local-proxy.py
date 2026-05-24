#!/usr/bin/env python3
"""
Local LLM proxy: merges ds4-server (:8001) and omlx (:8000) under one endpoint.
Routes /v1/chat/completions to the right backend based on model ID.
Merges /v1/models from both backends.
Merges /admin/api/stats from both backends (so progress bars work).
"""

import asyncio
import json
import logging
from aiohttp import ClientSession, ClientTimeout, web

CHAT_TIMEOUT = ClientTimeout(total=None, sock_connect=10, sock_read=None)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("local-proxy")

DS4_PORT = 8001
OMLX_PORT = 8000
LISTEN_PORT = 8002

DS4_V1 = f"http://127.0.0.1:{DS4_PORT}/v1"
OMLX_V1 = f"http://127.0.0.1:{OMLX_PORT}/v1"
DS4_ADMIN = f"http://127.0.0.1:{DS4_PORT}/admin"
OMLX_ADMIN = f"http://127.0.0.1:{OMLX_PORT}/admin"

# Model IDs served by ds4-server (discovered at startup)
DS4_MODELS = set()

# Shared API key from models.json
AUTH_HEADERS = {"Authorization": "Bearer REDACTED-LOCAL-KEY"}


async def discover_models():
    """Discover which models each backend serves."""
    global DS4_MODELS
    async with ClientSession() as sess:
        try:
            async with sess.get(f"{DS4_V1}/models", headers=AUTH_HEADERS) as r:
                data = await r.json()
                DS4_MODELS = {m["id"] for m in data.get("data", [])}
                log.info(f"ds4 models: {DS4_MODELS}")
        except Exception as e:
            log.warning(f"ds4 unreachable: {e}")

        try:
            async with sess.get(f"{OMLX_V1}/models", headers=AUTH_HEADERS) as r:
                data = await r.json()
                log.info(f"omlx models: {[m['id'] for m in data.get('data', [])]}")
        except Exception as e:
            log.warning(f"omlx unreachable: {e}")


def get_backend_v1(model_id):
    """Return the v1 base URL for a given model ID."""
    if model_id in DS4_MODELS:
        return DS4_V1
    return OMLX_V1


# ── /v1/models (merge) ───────────────────────────────────────────────────────

async def handle_models(request):
    """Merge /v1/models from both backends."""
    async with ClientSession() as sess:
        tasks = [
            sess.get(f"{DS4_V1}/models", headers=AUTH_HEADERS),
            sess.get(f"{OMLX_V1}/models", headers=AUTH_HEADERS),
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        merged = []
        for r in results:
            if isinstance(r, Exception):
                continue
            try:
                data = await r.json()
                merged.extend(data.get("data", []))
            except Exception:
                pass

        return web.json_response({"object": "list", "data": merged})


# ── /v1/chat/completions (route by model) ───────────────────────────────────

async def handle_chat(request):
    """Route /v1/chat/completions to the right backend, streaming passthrough."""
    body = await request.read()
    model_id = ""
    is_stream = False
    try:
        payload = json.loads(body)
        model_id = payload.get("model", "")
        is_stream = payload.get("stream", False)
    except Exception:
        pass

    backend = get_backend_v1(model_id)
    log.info(f"routing {model_id} -> {backend}")

    headers = {
        "Authorization": request.headers.get("Authorization", ""),
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

                async def watchdog():
                    """If the upstream client disconnects, close the backend
                    connection so the model server sees the cancel instead of
                    sitting in iter_any() until the proxy timeout fires."""
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
                return response
            else:
                # Non-streaming: short window, same disconnect risk but bounded.
                # If the client vanished, abandon the backend response.
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
    """Forward login to omlx (ds4-server doesn't need auth)."""
    body = await request.read()
    headers = {
        "Content-Type": request.headers.get("Content-Type", "application/json"),
    }
    async with ClientSession() as sess:
        async with sess.post(f"{OMLX_ADMIN}/api/login", data=body, headers=headers) as resp:
            data = await resp.read()
            response = web.Response(status=resp.status, body=data, content_type=resp.content_type)
            if resp.headers.get("Set-Cookie"):
                response.headers["Set-Cookie"] = resp.headers["Set-Cookie"]
            return response


# ── /admin/api/stats (merge from both backends) ─────────────────────────────

async def handle_admin_stats(request):
    """Poll admin/stats from both backends and merge results."""
    cookie = request.headers.get("Cookie", "")
    auth = request.headers.get("Authorization", AUTH_HEADERS["Authorization"])

    async with ClientSession() as sess:
        tasks = []
        # ds4 - no auth needed
        tasks.append(sess.get(f"{DS4_ADMIN}/api/stats", headers=AUTH_HEADERS))
        # omlx - needs auth cookie (if the extension logged in)
        omlx_headers = {"Authorization": auth}
        if cookie:
            omlx_headers["Cookie"] = cookie
        tasks.append(sess.get(f"{OMLX_ADMIN}/api/stats", headers=omlx_headers))

        results = await asyncio.gather(*tasks, return_exceptions=True)

        merged = {"active_models": {"models": []}}
        seen_ids = set()
        for r in results:
            if isinstance(r, Exception):
                continue
            if r.status != 200:
                continue
            try:
                data = await r.json()
                models = data.get("active_models", {}).get("models", [])
                for m in models:
                    # Skip idle models so the extension's findBestMatch latches
                    # onto whichever backend is actually doing work.
                    if not m.get("prefilling") and not m.get("generating"):
                        continue
                    if m.get("id") not in seen_ids:
                        seen_ids.add(m.get("id"))
                        merged["active_models"]["models"].append(m)
            except Exception:
                pass

        return web.json_response(merged)


# ── Catch-all: proxy any other /v1/* request ────────────────────────────────

async def handle_other(request):
    """Proxy any other /v1/* request to the right backend."""
    path = request.path[len("/v1"):]
    body = await request.read() if request.method in ("POST", "PUT") else None

    backend = OMLX_V1
    if body:
        try:
            payload = json.loads(body)
            model_id = payload.get("model", "")
            if model_id:
                backend = get_backend_v1(model_id)
        except Exception:
            pass

    headers = {
        "Authorization": request.headers.get("Authorization", ""),
        "Cookie": request.headers.get("Cookie", ""),
    }
    if body:
        headers["Content-Type"] = request.headers.get("Content-Type", "application/json")
    if request.query_string:
        path = f"{path}?{request.query_string}"

    async with ClientSession() as sess:
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
        "ds4_models": list(DS4_MODELS),
    }))

    log.info(f"local-proxy listening on :{LISTEN_PORT}")
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", LISTEN_PORT)
    await site.start()

    while True:
        await asyncio.sleep(3600)


async def periodic_discover():
    while True:
        await asyncio.sleep(60)
        try:
            await discover_models()
        except Exception as e:
            log.debug(f"periodic discover error: {e}")


if __name__ == "__main__":
    asyncio.run(main())