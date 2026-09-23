"""Deterministic ownership checks; no engine/model/process I/O."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aiohttp import web
from proxy_queue_test import load_proxy, MODEL


class ChatOwnershipTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.p = load_proxy()
        self.now = 10000.0
        self.enterContext(patch.object(self.p, "time", SimpleNamespace(monotonic=lambda: self.now)))
        self.p.ensure_ds4_model = AsyncMock()
        self.p.prepare_non_ds4_backend = AsyncMock()
        self.tasks = []

    async def asyncTearDown(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    def request(self, chat, rid):
        return SimpleNamespace(headers={"X-Pi-Chat-Id": chat, "X-Pi-Request-Id": rid,
                                        "X-Pi-Chat-Label": f"Label {chat}"},
                               transport=SimpleNamespace(is_closing=lambda: False))

    async def start(self, chat, rid):
        await self.p.begin_request("ds4", MODEL, self.request(chat, rid))

    async def queue(self, chat, rid):
        task = asyncio.create_task(self.start(chat, rid))
        self.tasks.append(task)
        await asyncio.sleep(0)
        return task

    async def release(self, chat, rid=None, operator=False, auth=True):
        return await self.p.handle_release_chat(SimpleNamespace(
            headers=self.p.AUTH_HEADERS if auth else {},
            json=AsyncMock(return_value={"chat_id": chat, "request_id": rid, "operator": operator})))

    async def test_owner_reenters_before_waiting_chat(self):
        await self.start("a", "a1")
        await self.p.finish_request("ds4")
        b = await self.queue("b", "b1")
        await asyncio.wait_for(self.start("a", "a2"), 0.2)
        self.assertFalse(b.done())
        self.assertEqual(self.p.ACTIVE_TICKET["request_id"], "a2")
        self.assertEqual(self.p.ACTIVE_REQUESTS, 1)

    async def test_same_and_other_chat_never_overlap(self):
        await self.start("a", "a1")
        b = await self.queue("b", "b1")
        a = await self.queue("a", "a2")
        self.assertFalse(a.done())
        self.assertFalse(b.done())
        self.assertEqual(self.p.ACTIVE_REQUESTS, 1)
        self.assertEqual([t["request_id"] for t in self.p.admission_order()], ["a2", "b1"])
        await self.p.finish_request("ds4")
        await asyncio.wait_for(a, 0.2)
        self.assertFalse(b.done())
        self.assertEqual(self.p.ACTIVE_REQUESTS, 1)
        await self.p.finish_request("ds4")
        await self.release("a", "a2")
        await asyncio.wait_for(b, 0.2)
        self.assertEqual(self.p.ACTIVE_REQUESTS, 1)

    async def test_explicit_release_hands_over_and_stale_release_is_rejected(self):
        await self.start("a", "a1")
        await self.p.finish_request("ds4")
        await self.start("a", "a2")
        await self.p.finish_request("ds4")
        b = await self.queue("b", "b1")
        with self.assertRaises(web.HTTPConflict):
            await self.release("a", "a1")
        self.assertFalse(b.done())
        await self.release("a", "a2")
        await asyncio.wait_for(b, 0.2)
        self.assertEqual(self.p.CHAT_OWNER["chat_id"], "b")

    async def test_expiry_hands_over_and_old_owner_returns_at_back(self):
        await self.start("a", "a1")
        await self.p.finish_request("ds4")
        b = await self.queue("b", "b1")
        c = await self.queue("c", "c1")
        self.now += self.p.DS4_IDLE_TIMEOUT
        a = await self.queue("a", "a2")
        async with self.p.REQUEST_CONDITION:
            self.p.REQUEST_CONDITION.notify_all()
        await asyncio.wait_for(b, 0.2)
        self.assertFalse(a.done())
        await self.p.finish_request("ds4")
        await self.release("b", "b1")
        await asyncio.wait_for(c, 0.2)
        self.assertFalse(a.done())
        await self.p.finish_request("ds4")
        await self.release("c", "c1")
        await asyncio.wait_for(a, 0.2)

    async def test_operator_release_requires_auth_and_does_not_preempt(self):
        await self.start("a", "a1")
        b = await self.queue("b", "b1")
        self.now += self.p.DS4_IDLE_TIMEOUT * 2
        self.assertIsNotNone(self.p.live_chat_owner())
        with self.assertRaises(web.HTTPUnauthorized):
            await self.release("a", operator=True, auth=False)
        await self.release("a", operator=True)
        self.assertTrue(self.p.CHAT_OWNER["release_pending"])
        self.assertFalse(b.done())
        self.assertEqual(self.p.ACTIVE_REQUESTS, 1)
        await self.p.finish_request("ds4")
        await asyncio.wait_for(b, 0.2)
        await self.p.finish_request("ds4")
        await self.release("b", operator=True)
        self.assertIsNone(self.p.CHAT_OWNER)

    async def test_cancel_releases_but_unknown_completion_stays_closed(self):
        await self.start("a", "a1")
        b = await self.queue("b", "b1")
        await self.p.finish_request("ds4", uncertain=True, release_chat=True)
        self.assertEqual(self.p.CHAT_OWNER["chat_id"], "a")
        with self.assertRaises(web.HTTPServiceUnavailable):
            await self.release("a", operator=True)
        # Test-only confirmed recovery; production cancellation waits for idle.
        await self.p.finish_request("ds4", release_chat=True)
        await asyncio.wait_for(b, 0.2)
        self.assertEqual(self.p.CHAT_OWNER["chat_id"], "b")

    async def test_idle_unload_suppressed_for_both_backends_until_expiry(self):
        await self.start("a", "a1")
        await self.p.finish_request("ds4")
        self.p.DS4_LAST_REQUEST_AT = self.p.MLX_LAST_REQUEST_AT = 1.0
        self.p.detect_ds4_loaded_model = AsyncMock(return_value=MODEL)
        self.p.mlx_resident_model = AsyncMock(return_value="mlx")
        self.p.ds4_is_busy = AsyncMock(return_value=False)
        self.p.stop_dsv4 = AsyncMock()
        self.p.stop_mlx = AsyncMock()
        for expired in [False, True]:
            if expired:
                self.now += self.p.DS4_IDLE_TIMEOUT
            for loop in [self.p.ds4_idle_check_loop, self.p.mlx_idle_check_loop]:
                with patch.object(self.p.asyncio, "sleep", AsyncMock(side_effect=[None, asyncio.CancelledError])):
                    with self.assertRaises(asyncio.CancelledError):
                        await loop()
            self.assertEqual(self.p.stop_dsv4.await_count, int(expired))
            self.assertEqual(self.p.stop_mlx.await_count, int(expired))

    async def test_failed_continuation_does_not_strand_previous_owner(self):
        await self.start("a", "a1")
        await self.p.finish_request("ds4")
        self.p.ensure_ds4_model.side_effect = RuntimeError("preparation failed")
        with self.assertRaises(RuntimeError):
            await self.start("a", "a2")
        self.assertIsNone(self.p.CHAT_OWNER)
        self.assertEqual(self.p.ACTIVE_REQUESTS, 0)

    async def test_vega_rejected_between_owner_requests_and_invalid_identity(self):
        await self.start("a", "a1")
        await self.p.finish_request("ds4")
        request = self.request("vega", "v1")
        request.headers["X-Pi-Origin"] = "vega-rewriter"
        with self.assertRaises(web.HTTPConflict):
            await self.p.begin_request("ds4", MODEL, request)
        self.assertEqual(self.p.REQUEST_QUEUE, [])
        with self.assertRaises(web.HTTPBadRequest):
            await self.start("not a valid chat", "bad")


if __name__ == "__main__":
    unittest.main()
