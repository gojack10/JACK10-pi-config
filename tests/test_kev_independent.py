"""CPU-only proxy HTTP tests. Fake native receipts are never production evidence.

Run: uv run --no-project --with aiohttp python -m unittest discover -s tests -p test_kev_independent.py
"""
import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer


class ProductionTestServer(TestServer):
    async def _make_runner(self, **kwargs):
        kwargs['handler_cancellation'] = False
        return web.AppRunner(self.app, **kwargs)


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import reservation_body as body

spec = importlib.util.spec_from_file_location('independent_proxy', ROOT / 'local-proxy.py')
with patch.dict(os.environ, LOCAL_LLM_PROXY_API_KEY='test-independent'):
    proxy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(proxy)


class FakeEngine:
    def __init__(self, directory):
        self.control = Path(directory)
        self.core = proxy.COORDINATOR
        self.pid = os.getpid()
        self.started = 'fake-incarnation'
        self.incarnation = 'fake-engine'
        self.hold = self.terminal_ticket = None
        self.high_water = 0
        self.terminal_count = self.release_count = self.pause_count = self.resume_count = 0
        self.fail_terminal = False
        self.fail_release = False
        self.pause_allowed = asyncio.Event()
        self.pause_allowed.set()
        self.resume_allowed = asyncio.Event()
        self.resume_allowed.set()
        self.resume_event = asyncio.Event()
        self.post_resume_token = False

    def alive(self):
        return True

    async def terminal(self):
        self.terminal_count += 1
        if self.fail_terminal:
            raise RuntimeError('fake terminal evidence unknown')
        body.eligible(self.core, dict(fresh=True, closed=True, drained=True, clean=True))
        self.terminal_ticket = self.terminal_count
        return {'kind': 'terminal', 'clean': 1}

    async def release_terminal(self):
        self.release_count += 1
        if self.fail_release:
            raise RuntimeError('fake terminal release unknown')
        assert self.terminal_ticket is not None
        self.terminal_ticket = None

    async def bind(self, request_id):
        return dict(request=request_id, cache='retained')

    async def pause(self, ticket):
        self.pause_count += 1
        await self.pause_allowed.wait()
        self.hold = dict(ticket=ticket)
        body.eligible(self.core, dict(fresh=True, closed=True, drained=True, clean=True))
        return self.hold

    async def resume(self, run):
        await self.resume_allowed.wait()
        assert self.hold is not None
        self.hold = None
        self.resume_count += 1
        self.resume_ticket = self.pause_count
        self.resume_event.set()

    def progress(self):
        if self.post_resume_token:
            self.post_resume_token = False
            return True
        return False


class FakeSwitch:
    def __init__(self, engine):
        self.engine = engine
        self.model = 'qwen3.8-flash-next'
        self.blocked = None
        self.lease = None
        self.adoptions = 0
        self.releases = 0

    async def acquire(self):
        assert self.lease is None
        self.lease = object()

    def adopt(self):
        assert self.lease is not None
        self.adoptions += 1

    def release(self):
        assert self.lease is not None and not self.blocked
        self.releases += 1
        self.lease = None


class FakeKev:
    instances = []

    def __init__(self, directory):
        self.directory = Path(directory)
        self.process = None
        self.ready = asyncio.Event()
        self.score_started = asyncio.Event()
        self.allow_score = asyncio.Event()
        self.allow_score.set()
        self.stop_count = 0
        FakeKev.instances.append(self)

    async def score(self, key, payload, reservation, request_id=None):
        assert reservation.engine.hold or reservation.engine.terminal_ticket is not None
        self.process = object()
        self.ready.set()
        self.score_started.set()
        await self.allow_score.wait()
        if payload['state'].get('error'):
            raise RuntimeError('fake scoring failed')
        return {'answers': {'next_action': {'choice': 'ask_user'}}}, request_id or 'fake-id'

    async def stop(self, key):
        self.stop_count += 1
        if self.directory.parent.joinpath('fail-stop').exists():
            raise RuntimeError('fake native stop unknown')
        return dict(facts=dict(fresh=True, closed=True, drained=True, clean=True))

    async def sample(self, key):
        await asyncio.sleep(.01)
        return None


async def until(predicate):
    async with asyncio.timeout(4):
        while not predicate():
            await asyncio.sleep(.01)


class KevHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = self.enterContext(tempfile.TemporaryDirectory())
        self.engine = FakeEngine(self.directory)
        self.manager = FakeSwitch(self.engine)
        FakeKev.instances = []
        self.enterContext(patch.dict(os.environ, LOCAL_LLM_PROXY_API_KEY='test-independent',
                                     LOCAL_PROXY_PRIVATE_LEASE='1'))
        self.enterContext(patch.object(body, 'LIVE', None))
        self.enterContext(patch.object(body, 'KevHTTP', FakeKev))
        self.enterContext(patch.object(body, 'INDEPENDENT_ADMITTER', proxy.begin_independent_kev))
        self.enterContext(patch.object(body, 'INDEPENDENT_RELEASER', proxy.finish_independent_kev))
        self.enterContext(patch.object(proxy, 'INDEPENDENT_SWITCH', self.manager))
        self.enterContext(patch.object(proxy, 'DUAL_MODELS', True))
        async def absent(*_args):
            return 1, b'Could not find service'
        self.enterContext(patch.object(proxy, '_mlx_launchctl', absent))
        self.enterContext(patch.object(body, 'MANAGED_ENGINE_PREPARER', self.prepare_main))
        self.enterContext(patch.object(body, 'MANAGED_ENGINE_RELEASER', self.manager.release))
        self.enterContext(patch.object(proxy, 'ACTIVE_TICKET', None))
        self.enterContext(patch.object(proxy, 'ACTIVE_REQUESTS', 0))
        self.enterContext(patch.object(proxy, 'DS4_ACTIVE_REQUESTS', 0))
        self.enterContext(patch.object(proxy, 'CHAT_OWNER', None))
        self.enterContext(patch.object(proxy, 'REQUEST_QUEUE', []))
        self.enterContext(patch.object(proxy, 'REQUEST_CONDITION', asyncio.Condition()))
        self.enterContext(patch.object(body, 'INDEPENDENT_TASKS', set()))
        self.tasks = []
        app = web.Application()
        app.router.add_post('/v1/systemone', body.handle_kev)
        app.router.add_post('/v1/chat/completions', proxy.handle_chat)
        self.server = ProductionTestServer(app)
        await self.server.start_server()
        self.client = ClientSession()

    async def asyncTearDown(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.client.close()
        await self.server.close()
        self.assertFalse(body.INDEPENDENT_TASKS)

    async def prepare_main(self, model):
        await self.manager.acquire()
        self.manager.model = model
        return self.engine

    def scoring(self, **state):
        return self.client.post(self.server.make_url('/v1/systemone'),
            json={'model': 'jev-latest', 'state': state},
            headers={'Authorization': 'Bearer test-independent', 'x-typesafe-request-id': 'score-id'})

    async def test_idle_chat_owner_is_preserved_and_ordinary_request_waits_for_native_stop(self):
        proxy.CHAT_OWNER = dict(chat_id='main-chat', last_request_at=time.monotonic(), held_since=time.monotonic())
        FakeKev.allow_score = asyncio.Event()
        async def gated_score(kev, key, payload, reservation, request_id=None):
            assert self.engine.terminal_ticket is not None
            kev.process = object()
            kev.ready.set()
            kev.score_started.set()
            await FakeKev.allow_score.wait()
            return {'answers': {'next_action': {'choice': 'ask_user'}}}, request_id
        with patch.object(FakeKev, 'score', gated_score):
            score = asyncio.create_task(self.scoring())
            self.tasks.append(score)
            await until(lambda: bool(FakeKev.instances) and FakeKev.instances[-1].score_started.is_set())
            self.assertEqual(proxy.ACTIVE_REQUESTS, 1)
            self.assertEqual(self.engine.terminal_count, 1)
            self.assertEqual(self.manager.adoptions, 1)
            self.assertEqual(proxy.CHAT_OWNER['chat_id'], 'main-chat')
            idle_since = proxy.CHAT_OWNER['last_request_at']
            follower = asyncio.create_task(proxy.begin_request('ds4', 'qwen3.8-flash-next',
                SimpleNamespace(headers={'X-Pi-Request-Id': 'next', 'X-Pi-Chat-Id': 'main-chat'},
                                transport=SimpleNamespace(is_closing=lambda: False)), managed=True))
            self.tasks.append(follower)
            await asyncio.sleep(.05)
            self.assertFalse(follower.done())
            FakeKev.allow_score.set()
            response = await score
            self.assertEqual(response.status, 200, await response.text())
            self.assertEqual(response.headers['x-typesafe-request-id'], 'score-id')
            self.assertEqual((await response.json())['answers']['next_action']['choice'], 'ask_user')
            self.assertEqual(FakeKev.instances[-1].stop_count, 1)
            self.assertEqual(self.engine.release_count, 1)
            await asyncio.wait_for(follower, 3)
            self.assertEqual(proxy.CHAT_OWNER['chat_id'], 'main-chat')
            self.assertGreaterEqual(proxy.CHAT_OWNER['last_request_at'], idle_since)
            await proxy.finish_request('ds4')
            self.assertEqual(self.manager.releases, 2)

    async def test_proxy_inflight_qwen_and_deepseek_use_existing_checked_path(self):
        self.enterContext(patch.object(proxy, 'RESERVATION_TRIAL', True))
        for model in ('qwen3.8-flash-next', 'deepseek-v4.1-flash'):
            self.engine.resume_event.clear()
            async def upstream(_request):
                response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
                await response.prepare(_request)
                await response.write(b'data: {"content":"before"}\n\n')
                await self.engine.resume_event.wait()
                await response.write(b'data: {"content":"after"}\n\n')
                await response.write_eof()
                return response
            app = web.Application()
            app.router.add_post('/v1/chat/completions', upstream)
            backend = TestServer(app)
            await backend.start_server()
            try:
                self.enterContext(patch.dict(proxy.BACKENDS['ds4'], v1=str(backend.make_url('/v1'))))
                self.enterContext(patch.dict(os.environ, LOCAL_PROXY_DS4_PORT=str(backend.port)))
                response = await self.client.post(self.server.make_url('/v1/chat/completions'),
                    json=dict(model=model, stream=True, temperature=0, messages=[]),
                    headers={'X-Pi-Request-Id': 'main-qwen' if model.startswith('qwen') else 'main-deepseek',
                             'X-Pi-Chat-Id': 'same-chat'})
                await until(lambda: body.LIVE is not None)
                self.assertEqual(proxy.ACTIVE_REQUESTS, 1)
                self.assertEqual(self.engine.terminal_count, self.engine.pause_count)
                async with self.scoring() as score:
                    self.assertEqual(score.status, 200, await score.text())
                    self.assertEqual((await score.json())['answers']['next_action']['choice'], 'ask_user')
                self.assertEqual(self.engine.pause_count, self.engine.resume_count)
                self.assertIn('after', await response.text())
                await until(lambda: body.LIVE is None)
                self.assertEqual(self.engine.terminal_count, self.engine.pause_count)
                self.assertEqual(self.engine.release_count, self.engine.pause_count)
                self.assertEqual(self.manager.adoptions, 0)
            finally:
                await backend.close()
        self.assertEqual(self.engine.pause_count, 2)
        self.assertEqual(self.manager.releases, 2)

    async def test_independent_error_stops_natively_before_releasing_seat(self):
        idle_since = time.monotonic()
        proxy.CHAT_OWNER = dict(chat_id='main-chat', last_request_at=idle_since, held_since=idle_since)
        async with self.scoring(error=True) as response:
            self.assertEqual(response.status, 503)
            result = await response.json()
        self.assertTrue(result['admitted'])
        self.assertFalse(result['awaiting_stop'])
        self.assertEqual(FakeKev.instances[-1].stop_count, 1)
        self.assertEqual(self.engine.release_count, 1)
        self.assertIsNone(proxy.ACTIVE_TICKET)
        self.assertEqual(self.manager.releases, 1)
        self.assertEqual(proxy.CHAT_OWNER['last_request_at'], idle_since)

    async def test_abandoned_independent_client_stops_before_releasing(self):
        blocked = asyncio.Event()
        async def score(kev, key, payload, reservation, request_id=None):
            kev.process = object()
            kev.ready.set()
            kev.score_started.set()
            await blocked.wait()
        async with ClientSession() as client:
            with patch.object(FakeKev, 'score', score):
                pending = asyncio.create_task(client.post(self.server.make_url('/v1/systemone'),
                    json={'model': 'jev-latest', 'state': {}},
                    headers={'Authorization': 'Bearer test-independent'}))
                self.tasks.append(pending)
                await until(lambda: bool(FakeKev.instances) and FakeKev.instances[-1].score_started.is_set())
                await client.close()
                await asyncio.gather(pending, return_exceptions=True)
                await until(lambda: self.engine.release_count == 1)
        self.assertEqual(FakeKev.instances[-1].stop_count, 1)
        self.assertEqual(self.manager.releases, 1)
        self.assertIsNone(proxy.ACTIVE_TICKET)

    async def test_stop_unknown_never_reopens_main_or_proxy_admission(self):
        Path(self.directory, 'fail-stop').touch()
        async with self.scoring() as response:
            self.assertEqual(response.status, 503)
            result = await response.json()
        self.assertTrue(result['awaiting_stop'])
        self.assertEqual(self.engine.release_count, 0)
        self.assertIsNotNone(self.engine.terminal_ticket)
        self.assertTrue(proxy.ACTIVE_TICKET['uncertain'])
        self.assertEqual(self.manager.releases, 0)
        async with self.scoring() as another:
            self.assertEqual(another.status, 503)

    async def test_registered_mlx_job_denies_ungated_independent_scoring(self):
        async def present(*_args):
            return 0, b'pid = 123'
        with patch.object(proxy, '_mlx_launchctl', present):
            async with self.scoring() as response:
                self.assertEqual(response.status, 503)
                self.assertIn('mlx_native_gate_not_qualified', (await response.json())['reason'])
        self.assertFalse(FakeKev.instances)
        self.assertEqual(self.manager.adoptions, 0)
        self.assertIsNone(proxy.ACTIVE_TICKET)

    async def test_terminal_release_failure_after_clean_stop_still_holds_seat(self):
        self.engine.fail_release = True
        async with self.scoring() as response:
            self.assertEqual(response.status, 503)
            result = await response.json()
        self.assertFalse(result['awaiting_stop'])
        self.assertTrue(result['awaiting_release'])
        self.assertEqual(FakeKev.instances[-1].stop_count, 1)
        self.assertEqual(self.manager.releases, 0)
        self.assertTrue(proxy.ACTIVE_TICKET['uncertain'])

    async def test_two_independent_calls_are_serial_not_overlapping(self):
        gate = asyncio.Event()
        async def slow(kev, key, payload, reservation, request_id=None):
            kev.process = object()
            kev.ready.set()
            kev.score_started.set()
            await gate.wait()
            return {'answers': {'next_action': {'choice': 'ask_user'}}}, 'fake-id'
        with patch.object(FakeKev, 'score', slow):
            first = asyncio.create_task(self.scoring())
            self.tasks.append(first)
            await until(lambda: bool(FakeKev.instances) and FakeKev.instances[0].score_started.is_set())
            second = asyncio.create_task(self.scoring())
            self.tasks.append(second)
            await asyncio.sleep(.05)
            self.assertEqual(self.engine.terminal_count, 1)
            self.assertEqual(len(FakeKev.instances), 1)
            gate.set()
            for task in (first, second):
                response = await asyncio.wait_for(task, 3)
                self.assertEqual(response.status, 200, await response.text())
                await response.read()
        self.assertEqual(self.engine.terminal_count, 2)
        self.assertEqual(self.engine.release_count, 2)
        self.assertEqual(self.manager.releases, 2)

    async def test_registered_but_stopped_mlx_does_not_deny_ds4_terminal_proof(self):
        async def stopped(*_args):
            return 0, b'state = waiting\n'
        with patch.object(proxy, '_mlx_launchctl', stopped):
            async with self.scoring() as response:
                self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.engine.terminal_count, 1)
        self.assertEqual(self.engine.release_count, 1)

    async def test_absent_pinned_main_engine_denies_without_start_or_eviction(self):
        with patch.object(self.manager, 'adopt', side_effect=RuntimeError('native engine absent')):
            async with self.scoring() as response:
                self.assertEqual(response.status, 503)
                self.assertIn('native engine absent', (await response.json())['reason'])
        self.assertFalse(FakeKev.instances)
        self.assertEqual(self.engine.terminal_count, 0)
        self.assertEqual(self.manager.releases, 1)
        self.assertIsNone(proxy.ACTIVE_TICKET)

    async def test_unpinned_coordinator_denies_both_idle_model_paths_before_native_control(self):
        bad_core = Path(self.directory, 'unqualified-core')
        bad_core.write_text('#!/bin/sh\necho "ELIGIBLE 1"\n')
        bad_core.chmod(0o700)
        self.engine.core = bad_core
        for releases, model in enumerate(('qwen3.8-flash-next', 'deepseek-v4.1-flash'), 1):
            self.manager.model = model
            async with self.scoring() as response:
                self.assertEqual(response.status, 503)
                self.assertIn('unqualified coordinator binary', (await response.json())['reason'])
            self.assertEqual(self.engine.terminal_count, 0)
            self.assertEqual(self.manager.releases, releases)
            self.assertIsNone(proxy.ACTIVE_TICKET)
            self.assertFalse(FakeKev.instances)

    async def test_terminal_receipt_failure_blocks_without_starting_kev(self):
        self.engine.fail_terminal = True
        async with self.scoring() as response:
            self.assertEqual(response.status, 503)
            self.assertIn('fake terminal evidence unknown', (await response.json())['reason'])
        self.assertEqual(FakeKev.instances, [])
        self.assertTrue(proxy.ACTIVE_TICKET['uncertain'])
        self.assertEqual(self.engine.release_count, 0)
        self.assertEqual(self.manager.releases, 0)

    async def test_active_main_not_yet_bound_cannot_enter_idle_kev(self):
        proxy.ACTIVE_REQUESTS = 1
        proxy.ACTIVE_TICKET = dict(request_id='binding', managed=True)
        async with self.scoring() as response:
            self.assertEqual(response.status, 503)
            self.assertIn('main_native_binding_pending', (await response.json())['reason'])
        self.assertEqual(self.engine.terminal_count, 0)
        self.assertFalse(FakeKev.instances)

    async def test_bad_auth_and_payload_never_take_native_seat(self):
        async with self.client.post(self.server.make_url('/v1/systemone'),
                                    json={'state': {}}, headers={'Authorization': 'Bearer wrong'}) as r:
            self.assertEqual(r.status, 401)
        async with self.client.post(self.server.make_url('/v1/systemone'),
                                    json={'state': []}, headers={'Authorization': 'Bearer test-independent'}) as r:
            self.assertEqual(r.status, 400)
        self.assertEqual(self.manager.adoptions, 0)

if __name__ == '__main__':
    unittest.main()
