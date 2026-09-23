"""Offline queue trials: ephemeral loopback backends, no lifecycle or model I/O."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

SOURCE = Path(__file__).resolve().parents[2] / "local-proxy.py"
MODEL = "qwen3.8-flash-next"


def load_proxy():
    spec = importlib.util.spec_from_file_location("queue_proxy_under_test", SOURCE)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(os.environ, LOCAL_LLM_PROXY_API_KEY="offline-test"):
        spec.loader.exec_module(module)
    return module


class ProductionTestServer(TestServer):
    async def _make_runner(self, **kwargs):
        # aiohttp TestServer otherwise forces True, unlike production AppRunner.
        kwargs["handler_cancellation"] = False
        return web.AppRunner(self.app, **kwargs)


class QueueIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.p = load_proxy()
        self.release = asyncio.Event()
        self.pulse = asyncio.Event()
        self.pulsed = asyncio.Event()
        self.started = []
        self.active = 0
        self.peak = 0
        self.stats_pause = None
        self.extra_busy = False
        self.abort_seen = asyncio.Event()

        async def backend(request):
            body = await request.json()
            name = body.get("tag", request.headers.get("X-Pi-Request-Id"))
            self.started.append(name)
            self.active += 1
            self.peak = max(self.peak, self.active)
            try:
                if name == "broken":
                    response = web.StreamResponse(headers={"Content-Type": "application/json", "Content-Length": "100"})
                    await response.prepare(request)
                    await response.write(b"{")
                    await self.release.wait()
                    request.transport.abort()
                    return response
                if name == "nonstream":
                    response = web.StreamResponse(headers={"Content-Type": "application/json"})
                    await response.prepare(request)
                    await response.write(b"{")
                    await self.release.wait()
                    await response.write(b"}")
                    await response.write_eof()
                    return response
                if name == "cancelme":
                    # Streams until the proxy closes us, then keeps working: an engine
                    # can notice an abort and still be busy for a moment afterwards.
                    response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
                    await response.prepare(request)
                    await response.write(b'data: {"choices":[]}\n\n')
                    for _ in range(200):
                        await asyncio.sleep(0.02)
                        transport = request.transport
                        if transport is None or transport.is_closing():
                            self.extra_busy = True
                            self.abort_seen.set()
                            break
                        await response.write(b'data: {"choices":[]}\n\n')
                    return response
                if body.get("stream"):
                    response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
                    await response.prepare(request)
                    await response.write(b'data: {"choices":[]}\n\n')
                    if len(self.started) == 1:
                        await self.pulse.wait()
                        await response.write(b'data: {"choices":[]}\n\n')
                        self.pulsed.set()
                        await self.release.wait()
                    await response.write_eof()
                    return response
                if len(self.started) == 1:
                    await self.release.wait()
                return web.json_response({"id": name, "model": body["model"]})
            finally:
                self.active -= 1

        async def stats(_request):
            if self.stats_pause:
                started, release = self.stats_pause
                started.set()
                await release.wait()
            generating = [{"generated_tokens": 99}] if (self.active or self.extra_busy) else []
            return web.json_response({"active_models": {"models": [{
                "id": MODEL, "prefilling": [], "generating": generating,
            }]}})

        backend_app = web.Application()
        backend_app.router.add_get("/admin/api/stats", stats)
        backend_app.router.add_get("/v1/models", lambda r: web.json_response({"data": []}))
        backend_app.router.add_route("*", "/v1/{tail:.*}", backend)
        self.backend_server = ProductionTestServer(backend_app)
        await self.backend_server.start_server()
        for cfg in self.p.BACKENDS.values():
            cfg["v1"] = str(self.backend_server.make_url("/v1"))
            cfg["admin"] = str(self.backend_server.make_url("/admin"))
        self.requests = {}
        begin = self.p.begin_request
        async def capture(backend, model, request=None):
            if request is not None:
                self.requests[request.headers.get("X-Pi-Request-Id")] = request
            await begin(backend, model, request)
        self.p.begin_request = capture
        self.p.ensure_ds4_model = AsyncMock()
        self.p.prepare_non_ds4_backend = AsyncMock()
        self.p.detect_ds4_loaded_model = AsyncMock(return_value=MODEL)
        # Any accidentally unmocked lifecycle operation fails before process I/O.
        self.enterContext(patch.object(self.p.asyncio, "create_subprocess_exec", side_effect=AssertionError("process forbidden")))
        self.enterContext(patch.object(self.p.subprocess, "check_output", side_effect=AssertionError("process forbidden")))

        app = web.Application()
        app.router.add_post("/v1/chat/completions", self.p.handle_chat)
        app.router.add_get("/v1/models", self.p.handle_models)
        app.router.add_get("/admin/api/stats", self.p.handle_admin_stats)
        app.router.add_post("/admin/api/login", self.p.handle_admin_login)
        app.router.add_post("/admin/api/release-chat", self.p.handle_release_chat)
        app.router.add_route("*", "/v1/{tail:.*}", self.p.handle_other)
        self.proxy_server = ProductionTestServer(app)
        await self.proxy_server.start_server()
        self.client = ClientSession()
        self.tasks = []

    async def asyncTearDown(self):
        self.release.set()
        self.pulse.set()
        if self.stats_pause:
            self.stats_pause[1].set()
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.client.close()
        await self.proxy_server.close()
        await self.backend_server.close()

    def post(self, name, model=MODEL, path="/v1/chat/completions", stream=False, request_id=True, origin=None, chat=None):
        headers = {"X-Pi-Chat-Id": chat, "X-Pi-Chat-Label": f"Label {chat}"} if chat else {}
        if request_id is not None:
            headers["X-Pi-Request-Id"] = name if request_id is True else request_id
        if origin:
            headers["X-Pi-Origin"] = origin
        task = asyncio.create_task(self.client.post(self.proxy_server.make_url(path),
            json={"model": model, "tag": name, "stream": stream}, headers=headers))
        self.tasks.append(task)
        return task

    async def wait_for(self, predicate):
        async with asyncio.timeout(2):
            while not predicate():
                await asyncio.sleep(0.005)

    async def stats(self, request_id=None):
        headers = {"X-Pi-Request-Id": request_id} if request_id else {}
        async with self.client.get(self.proxy_server.make_url("/admin/api/stats"), headers=headers) as response:
            return await response.json()

    async def finish(self, *tasks):
        self.release.set()
        async with asyncio.timeout(3):
            for response in await asyncio.gather(*tasks):
                self.assertEqual(response.status, 200)
                await response.read()
                response.release()
        self.assertEqual(self.peak, 1)
        self.assertEqual(self.p.ACTIVE_REQUESTS, 0)

    async def test_fifo_notify_storm_and_late_arrivals(self):
        first = self.post("first")
        await self.wait_for(lambda: len(self.started) == 1)
        waiters = []
        for i in range(8):
            waiters.append(self.post(str(i)))
            await self.wait_for(lambda: len(self.p.REQUEST_QUEUE) == i + 1)
            async with self.p.REQUEST_CONDITION:
                self.p.REQUEST_CONDITION.notify_all()
        for i in range(8):
            stats = await self.stats(str(i))
            self.assertEqual(stats["queue_position"], i + 1)
        self.assertEqual(self.started, ["first"])
        await self.finish(first, *waiters)
        self.assertEqual(self.started, ["first", *map(str, range(8))])

    async def test_mixed_models_endpoints_and_transition_arrival(self):
        transition_started, transition_release = asyncio.Event(), asyncio.Event()
        async def prepare(*_args):
            self.assertEqual(self.active, 0)
            transition_started.set()
            await transition_release.wait()
        self.p.prepare_non_ds4_backend.side_effect = prepare
        first = self.post("first")
        await self.wait_for(lambda: len(self.started) == 1)
        switching = self.post("switching", "gemma-4-31b-mlx", path="/v1/embeddings")
        self.release.set()
        await asyncio.wait_for(transition_started.wait(), 2)
        third = self.post("third", self.p.DS41_MODEL_ID, path="/v1/completions")
        await self.wait_for(lambda: len(self.p.REQUEST_QUEUE) == 2)
        self.assertEqual(self.started, ["first"])
        transition_release.set()
        await self.finish(first, switching, third)
        self.assertEqual(self.started, ["first", "switching", "third"])

    async def test_vega_rejected_when_active_queued_or_transitioning(self):
        first = self.post("first")
        await self.wait_for(lambda: len(self.started) == 1)
        second = self.post("second")
        await self.wait_for(lambda: len(self.p.REQUEST_QUEUE) == 1)
        response = await self.post("vega", origin="vega-rewriter")
        self.assertEqual(response.status, 409)
        response.release()
        self.assertEqual(len(self.p.REQUEST_QUEUE), 1)
        await self.finish(first, second)
        async with self.p.REQUEST_CONDITION:
            response = await self.post("vega-transition", origin="vega-rewriter")
            self.assertEqual(response.status, 409)
            response.release()
        self.assertEqual(self.started, ["first", "second"])

    async def test_missing_ids_cancel_only_the_matching_ticket(self):
        first = self.post("first")
        await self.wait_for(lambda: len(self.started) == 1)
        head = self.post("head", request_id=None)
        await self.wait_for(lambda: len(self.p.REQUEST_QUEUE) == 1)
        tail = self.post("tail", request_id=None)
        await self.wait_for(lambda: len(self.p.REQUEST_QUEUE) == 2)
        head_ticket = self.p.REQUEST_QUEUE[0]
        tail.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await tail
        await self.wait_for(lambda: len(self.p.REQUEST_QUEUE) == 1)
        self.assertIs(self.p.REQUEST_QUEUE[0], head_ticket)
        self.assertIsNone((await self.stats())["queue_position"])
        await self.finish(first, head)
        self.assertEqual(self.started, ["first", "head"])

    async def test_disconnect_before_admission_returns_499_without_handler_error(self):
        body = json.dumps({"model": MODEL}).encode()
        for handler, path in ((self.p.handle_chat, "/v1/chat/completions"),
                              (self.p.handle_other, "/v1/embeddings")):
            with self.subTest(path=path):
                request = SimpleNamespace(
                    headers={}, transport=None, method="POST", path=path, query_string="",
                    read=AsyncMock(return_value=body),
                )
                with patch.object(self.p, "begin_request", AsyncMock(
                    side_effect=ConnectionResetError("client disconnected while queued"))):
                    response = await handler(request)
                self.assertEqual(response.status, 499)

    async def test_duplicate_ids_fail_closed_for_queue_and_active_telemetry(self):
        first = self.post("first")
        await self.wait_for(lambda: len(self.started) == 1)
        second = self.post("second", request_id="collision")
        await self.wait_for(lambda: len(self.p.REQUEST_QUEUE) == 1)
        duplicate = await self.post("duplicate", request_id="collision")
        self.assertEqual(duplicate.status, 409)
        duplicate.release()
        stats = await self.stats("collision")
        self.assertIsNone(stats["queue_position"])
        self.assertEqual(stats["request_state"], "ambiguous")
        self.assertFalse(stats["active_models"]["models"])
        duplicate = await self.post("duplicate-active", request_id="first")
        self.assertEqual(duplicate.status, 409)
        duplicate.release()
        self.assertFalse((await self.stats("first"))["active_models"]["models"])
        await self.finish(first, second)

    async def test_abandoned_transition_finishes_but_never_decodes(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def ensure(_model):
            entered.set()
            await release.wait()
        self.p.ensure_ds4_model.side_effect = ensure
        abandoned = self.post("abandoned")
        await asyncio.wait_for(entered.wait(), 2)
        follower = self.post("follower")
        await self.wait_for(lambda: len(self.p.REQUEST_QUEUE) == 2)
        abandoned.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await abandoned
        # Observe server transport closure before releasing the transition.
        await self.wait_for(lambda: self.p.client_disconnected(self.requests["abandoned"]))
        self.assertFalse(self.started)
        release.set()
        await self.finish(follower)
        self.assertEqual(self.started, ["follower"])

    async def test_stream_cancel_closes_upstream_and_waits_for_engine_idle(self):
        first = await self.post("cancelme", stream=True, chat="a")
        await first.content.readany()
        first.close()
        # Cancel means cancel: the proxy closes upstream instead of draining to EOF.
        await asyncio.wait_for(self.abort_seen.wait(), 2)
        self.assertTrue(self.extra_busy)
        second = self.post("second", chat="b")
        await self.wait_for(lambda: len(self.p.REQUEST_QUEUE) == 1)
        # Engine still reports activity, so the successor must stay queued.
        await asyncio.sleep(0.3)
        self.assertEqual(self.started, ["cancelme"])
        self.assertEqual(self.p.ACTIVE_REQUESTS, 1)
        stats = await self.stats("second")
        self.assertEqual(stats["queue_position"], 1)
        self.assertEqual(stats["chat_owner"]["chat_id"], "a")
        self.assertEqual(stats["chat_owner"]["label"], "Label a")
        self.assertGreaterEqual(stats["chat_owner"]["held_seconds"], 0)
        # Only observed quiescence releases the owner.
        self.extra_busy = False
        await self.wait_for(lambda: len(self.started) == 2)
        await self.finish(second)
        self.assertEqual(self.peak, 1)
        self.assertEqual(self.p.CHAT_OWNER["chat_id"], "b")

    async def test_nonstream_disconnect_does_not_release_engine_before_eof(self):
        first = self.post("nonstream")
        await self.wait_for(lambda: len(self.started) == 1)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        second = self.post("second")
        await self.wait_for(lambda: len(self.p.REQUEST_QUEUE) == 1)
        await asyncio.sleep(0.6)
        self.assertEqual(self.started, ["nonstream"])
        self.assertEqual(self.p.ACTIVE_REQUESTS, 1)
        await self.finish(second)

    async def test_unknown_id_and_owner_change_suppress_global_progress(self):
        first = self.post("first")
        await self.wait_for(lambda: len(self.started) == 1)
        stats = await self.stats("not-arrived")
        self.assertEqual(stats["request_state"], "unknown")
        self.assertFalse(stats["active_models"]["models"])
        self.stats_pause = (asyncio.Event(), asyncio.Event())
        poll = asyncio.create_task(self.stats("first"))
        await asyncio.wait_for(self.stats_pause[0].wait(), 2)
        await self.finish(first)
        self.stats_pause[1].set()
        self.assertFalse((await poll)["active_models"]["models"])

    async def test_upstream_failure_closes_admission_on_both_paths(self):
        for path in ("/v1/chat/completions", "/v1/embeddings"):
            with self.subTest(path=path):
                self.started.clear()
                self.release.clear()
                broken = self.post("broken", path=path)
                await self.wait_for(lambda: self.started == ["broken"])
                waiting = self.post("waiting")
                await self.wait_for(lambda: len(self.p.REQUEST_QUEUE) == 1)
                self.release.set()
                response = await broken
                self.assertEqual(response.status, 500)
                response.release()
                response = await asyncio.wait_for(waiting, 2)
                self.assertEqual(response.status, 503)
                response.release()
                response = await self.post("late")
                self.assertEqual(response.status, 503)
                response.release()
                self.assertEqual(self.started, ["broken"])
                self.assertEqual(self.p.ACTIVE_REQUESTS, 1)
                self.assertTrue(self.p.ACTIVE_TICKET["uncertain"])
                # Test-only reset after the stub is proven idle.
                self.assertEqual(self.active, 0)
                await self.p.finish_request("ds4")

    async def test_disconnect_at_admission_and_transition_failure_leave_no_ticket(self):
        request = SimpleNamespace(headers={}, transport=None)
        with self.assertRaises(ConnectionResetError):
            await self.p.begin_request("ds4", MODEL, request)
        self.p.ensure_ds4_model.assert_not_awaited()
        self.assertFalse(self.p.REQUEST_QUEUE)
        self.p.ensure_ds4_model.side_effect = RuntimeError("offline transition failure")
        with self.assertRaises(RuntimeError):
            await self.p.begin_request("ds4", MODEL)
        self.assertFalse(self.p.REQUEST_QUEUE)
        self.assertEqual(self.p.ACTIVE_REQUESTS, 0)

    async def test_metadata_and_unknown_admin_do_not_start_inference(self):
        first = self.post("first")
        await self.wait_for(lambda: len(self.started) == 1)
        for path in ("/v1/models", "/admin/api/stats"):
            async with self.client.get(self.proxy_server.make_url(path)) as response:
                self.assertEqual(response.status, 200)
        async with self.client.post(self.proxy_server.make_url("/admin/api/login")) as response:
            self.assertEqual(response.status, 204)
        async with self.client.post(self.proxy_server.make_url("/admin/api/unload")) as response:
            self.assertEqual(response.status, 404)
        self.assertEqual(self.started, ["first"])
        await self.finish(first)


if __name__ == "__main__":
    unittest.main()
