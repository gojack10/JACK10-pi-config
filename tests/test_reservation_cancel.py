"""CPU-only HTTP cancellation checks; fake native receipts are not GPU evidence.

Run: PYTHONPATH=. uv run --no-project --with aiohttp python -m unittest discover -s tests -p test_reservation_cancel.py
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import reservation_body as body


class ProductionTestServer(TestServer):
    async def _make_runner(self, **kwargs):
        kwargs['handler_cancellation'] = False
        return web.AppRunner(self.app, **kwargs)


class Engine:
    def __init__(self, control):
        self.control = Path(control)
        self.pid, self.started, self.incarnation = os.getpid(), 'fake-start', 'fake-engine'
        self.hold = self.terminal_ticket = self.resume_ticket = None
        self.high_water = 0
        self.bind_started = asyncio.Event()
        self.bind_allowed = asyncio.Event()
        self.bind_allowed.set()
        self.terminal_started = asyncio.Event()
        self.terminal_allowed = asyncio.Event()
        self.fail_terminal = False
        self.released = False

    async def bind(self, request_id):
        self.bind_started.set()
        await self.bind_allowed.wait()
        return {'request': request_id}

    async def pause(self, ticket):
        raise AssertionError('ordinary cancellation must not request a decode pause')

    async def terminal(self):
        self.terminal_started.set()
        await self.terminal_allowed.wait()
        if self.fail_terminal:
            raise RuntimeError('fake native drain failed')
        self.terminal_ticket = 1
        return {'kind': 'terminal', 'clean': 1}

    async def release_terminal(self):
        self.released = True
        self.terminal_ticket = None


class CancellationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = self.enterContext(tempfile.TemporaryDirectory())
        self.engine = Engine(self.directory)
        self.disconnected = asyncio.Event()
        self.tasks = []
        spec = importlib.util.spec_from_file_location('cancel_proxy', ROOT / 'local-proxy.py')
        self.proxy = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, LOCAL_LLM_PROXY_API_KEY='test-only'):
            spec.loader.exec_module(self.proxy)
        self.proxy.RESERVATION_TRIAL = True
        self.proxy.DUAL_MODELS = True
        self.enterContext(patch.object(body, 'LIVE', None))
        self.enterContext(patch.object(body, 'MAIN_TASK', None))
        self.enterContext(patch.object(body, 'KevHTTP', lambda *_: None))

        async def prepare(_model):
            return self.engine
        self.enterContext(patch.object(body, 'MANAGED_ENGINE_PREPARER', prepare))
        self.enterContext(patch.object(body, 'MANAGED_ENGINE_RELEASER', None))

        async def upstream(request):
            await request.read()
            response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
            await response.prepare(request)
            await response.write(b': prefill\n\n')
            while request.transport is not None and not request.transport.is_closing():
                await asyncio.sleep(.005)
            self.disconnected.set()
            return response

        self.stats = {'active_models': {'models': [{'prefilling': [], 'generating': []}]}}

        async def stats(_request):
            return web.json_response(self.stats)

        app = web.Application()
        app.router.add_post('/v1/chat/completions', upstream)
        app.router.add_get('/admin/api/stats', stats)
        self.backend = ProductionTestServer(app)
        await self.backend.start_server()
        self.proxy.BACKENDS['ds4']['v1'] = str(self.backend.make_url('/v1'))
        self.enterContext(patch.dict(os.environ, LOCAL_PROXY_PRIVATE_LEASE='1',
                                    LOCAL_PROXY_DS4_PORT=str(self.backend.port)))
        app = web.Application()
        app.router.add_post('/v1/chat/completions', self.proxy.handle_chat)
        self.server = ProductionTestServer(app)
        await self.server.start_server()
        self.client = ClientSession()

    async def asyncTearDown(self):
        self.engine.bind_allowed.set()
        self.engine.terminal_allowed.set()
        if body.MAIN_TASK:
            await asyncio.wait_for(body.MAIN_TASK, 3)
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.client.close()
        await self.server.close()
        await self.backend.close()

    async def cancel(self, before_bind=False, queued_kev=False):
        if before_bind:
            self.engine.bind_allowed.clear()
        response = await self.client.post(self.server.make_url('/v1/chat/completions'),
            json={'model': 'deepseek-v4.1-flash', 'stream': True, 'temperature': 0, 'messages': []},
            headers={'X-Pi-Request-Id': 'cancel-prefill', 'X-Pi-Chat-Id': 'main-chat'})
        await asyncio.wait_for(self.engine.bind_started.wait(), 2)
        if not before_bind:
            await asyncio.wait_for(response.content.readany(), 2)
            self.assertIsNotNone(body.LIVE)
        if queued_kev:
            self.engine.pause_requested = False
            waiting = asyncio.Event()

            async def wait_prefill(_ticket):
                waiting.set()
                await asyncio.Event().wait()
            self.engine.pause = wait_prefill
            self.borrow = asyncio.create_task(body.LIVE.enqueue(7, {}))
            self.tasks.append(self.borrow)
            await asyncio.wait_for(waiting.wait(), 2)
        response.close()
        await asyncio.wait_for(self.disconnected.wait(), 2)
        await asyncio.wait_for(self.engine.terminal_started.wait(), 2)
        self.assertEqual(self.proxy.ACTIVE_REQUESTS, 1)
        self.assertFalse(self.engine.released)

    async def test_prefill_cancel_closes_socket_but_holds_queue_until_native_drain(self):
        await self.cancel()
        reservation = body.LIVE
        self.assertEqual(reservation.lifecycle, 'cancelling')
        with self.assertRaisesRegex(RuntimeError, 'borrow admission unavailable'):
            await reservation.enqueue(1, {})
        follower = asyncio.create_task(self.proxy.begin_request('ds4', 'qwen3.8-flash-next',
            SimpleNamespace(headers={'X-Pi-Request-Id': 'next', 'X-Pi-Chat-Id': 'next-chat'},
                            transport=SimpleNamespace(is_closing=lambda: False)), managed=True))
        self.tasks.append(follower)
        await asyncio.sleep(.02)
        self.assertFalse(follower.done())
        self.engine.terminal_allowed.set()
        await asyncio.wait_for(body.MAIN_TASK, 2)
        await asyncio.wait_for(follower, 2)
        self.assertTrue(self.engine.released)
        self.assertIsNone(body.LIVE)
        self.assertEqual(self.proxy.CHAT_OWNER['chat_id'], 'next-chat')
        await self.proxy.finish_request('ds4', release_chat=True)
        self.assertIsNone(self.proxy.CHAT_OWNER)

    async def test_cancel_before_binding_also_closes_socket_and_requires_drain(self):
        await self.cancel(before_bind=True)
        self.engine.terminal_allowed.set()
        await asyncio.wait_for(body.MAIN_TASK, 2)
        self.assertTrue(self.engine.released)
        self.assertEqual(self.proxy.ACTIVE_REQUESTS, 0)
        self.assertIsNone(self.proxy.CHAT_OWNER)

    async def test_cancel_prefill_with_kev_queued_returns_borrow_without_launching(self):
        await self.cancel(queued_kev=True)
        reservation = body.LIVE
        self.engine.terminal_allowed.set()
        await asyncio.wait_for(body.MAIN_TASK, 2)
        with self.assertRaisesRegex(RuntimeError, 'returned to outer scheduler'):
            await self.borrow
        self.assertTrue(reservation.pause_task.cancelled())
        self.assertFalse(reservation.calls[7]['launched'])
        self.assertEqual(self.proxy.ACTIVE_REQUESTS, 0)

    async def test_long_prefill_wait_is_not_a_pause_timeout_or_foreign_decode(self):
        native = object.__new__(body.FileEngine)
        native.kind, native.control, native.pid = 'ds4', self.engine.control, os.getpid()
        native.binding = {'request': 'main', 'nonce': 'n', 'session': 's'}
        native.hold, native.pause_requested, native.high_water, native.ticket = None, False, 0, 0
        native.serial_key, native.core = ('test', 'phase-wait', None), self.proxy.COORDINATOR
        native.alive = lambda: True
        native.receipt = lambda _name, predicate: (ack if predicate(ack) else None)
        ack = dict(ticket=1, pid=native.pid, phase='decode', nonce='n', session='s',
                   generated=0, outstanding=0, submitted=1, completed=1, checkpoint_valid=1)
        model = self.stats['active_models']['models'][0]
        model.update(prefilling=[{'request_id': 'main'}], generating=[{'request_id': 'other'}])
        with patch.object(body, 'MAX_WAIT', .05):
            task = asyncio.create_task(native.pause('checked-ticket'))
            self.tasks.append(task)
            await asyncio.sleep(.45)  # > watchdog, but main is still legitimately prefilling
            self.assertFalse(task.done())
            self.assertFalse(native.pause_requested)
            self.assertFalse((native.control / 'request').exists())
            model.update(prefilling=[], generating=[{'request_id': 'main'}])
            self.assertEqual(await asyncio.wait_for(task, 2), ack)
            self.assertTrue(native.pause_requested)
            self.assertIn('decode main', (native.control / 'request').read_text())

    async def test_unknown_phase_and_dead_main_fail_closed(self):
        native = object.__new__(body.FileEngine)
        native.binding = {'request': 'main'}
        native.alive = lambda: True
        with patch.object(body, 'MAX_WAIT', .01):
            with self.assertRaisesRegex(RuntimeError, 'phase unknown'):
                await native.wait_for_decode()
        native.alive = lambda: False
        with self.assertRaisesRegex(RuntimeError, 'main exited'):
            await native.wait_for_decode()

    async def test_failed_drain_does_not_reopen_admission(self):
        await self.cancel()
        self.engine.fail_terminal = True
        self.engine.terminal_allowed.set()
        await asyncio.wait_for(body.MAIN_TASK, 2)
        self.assertFalse(self.engine.released)
        self.assertEqual(self.proxy.ACTIVE_REQUESTS, 1)
        self.assertTrue(self.proxy.ACTIVE_TICKET['uncertain'])
        with self.assertRaises(web.HTTPServiceUnavailable):
            await self.proxy.begin_request('ds4', 'qwen3.8-flash-next', managed=True)

    async def test_native_terminal_retries_busy_but_never_poisoned_receipts(self):
        native = object.__new__(body.FileEngine)
        native.kind, native.hold, native.ticket = 'ds4', None, 0
        native.control, native.pid, native.incarnation = self.engine.control, os.getpid(), 'native'
        native.serial_key, native.core = ('test', 'terminal', None), self.proxy.COORDINATOR
        native.alive = lambda: True
        commands = []
        poisoned = False
        original_publish = body.publish

        def publish(_directory, _name, text):
            pid, engine, serial, ticket, action = text.split()
            commands.append((int(serial), action))
            ok = int(not poisoned and len(commands) > 2)
            ack = dict(kind='terminal', pid=int(pid), engine=engine, serial=serial,
                       ticket=ticket, action=action, ok=ok, admission_closed=ok,
                       retired=0, closed=ok, clean=ok, failed=int(poisoned),
                       submitted=ok, completed=ok, outstanding=0,
                       keepalive_submitted=0, keepalive_completed=0, keepalive_parked=ok)
            original_publish(native.control, 'terminal-ack', json.dumps(ack))

        with patch.object(body, 'publish', publish):
            proof = await native.terminal()
            self.assertEqual(commands, [(1, 'close'), (2, 'close'), (3, 'close'), (4, 'status')])
            self.assertEqual(proof['ok'], 1)
            await native.release_terminal()
            self.assertEqual(commands[-1], (5, 'release'))
            poisoned = True
            with self.assertRaisesRegex(RuntimeError, 'admission retained'):
                await native.terminal()
            self.assertEqual(commands[-1], (6, 'close'))
            self.assertEqual(len(commands), 6)  # no retry/status/release of poisoned state

    async def test_held_borrower_cancellation_still_uses_checked_stop(self):
        # A direct socket abort cannot bypass a borrower or pending pause.
        from unittest.mock import AsyncMock, Mock
        for phase in ('awaiting-pause', 'held', 'awaiting-stop', 'resume-pending'):
            with self.subTest(phase=phase):
                reservation = body.Reservation(self.proxy.CheckedReservation, self.engine, None,
                    (0, 1, 2, 3), Path(self.directory) / ('journal-' + phase), 'main',
                    abort_main=Mock())
                reservation.lifecycle = phase
                reservation.event = AsyncMock()
                await reservation.cancel_main()
                reservation.abort_main.assert_not_called()
                if phase == 'resume-pending':
                    self.assertTrue(reservation.cancel_pending)
                else:
                    reservation.event.assert_awaited_once_with('1/' + reservation.owner)


if __name__ == '__main__':
    unittest.main()
