"""CPU-only Winnow admission/lifecycle checks; never launches a model."""
import asyncio
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

import swap_policy
import managed_switch as ms

ROOT = Path(__file__).resolve().parents[1]


def load_proxy():
    spec = importlib.util.spec_from_file_location('winnow_proxy_test', ROOT / 'local-proxy.py')
    proxy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(proxy)
    return proxy


class FakeWinnow:
    def __init__(self, state, trace):
        self.state, self.trace = state, trace

    def probe(self):
        return (100, 'fresh') if self.state['resident'] == 'winnow-12b' else None

    def qualify(self):
        self.trace.append('qualified')

    async def ready(self, identity):
        return identity == (100, 'fresh')

    async def start(self):
        self.trace.append('start-winnow')
        self.state['resident'] = 'winnow-12b'

    async def stop(self):
        self.trace.append('stop-winnow')
        self.state['resident'] = None


class ManagedTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.state = {'resident': 'deepseek-v4.1-flash'}
        self.trace = []
        self.winnow = FakeWinnow(self.state, self.trace)
        self.manager = ms.ManagedSwitch(inherited_lease=object(), winnow=self.winnow)
        self.enterContext(patch.object(swap_policy, 'SWAP', swap_policy.SwapPolicy()))
        self.enterContext(patch.object(ms, 'service_pid', side_effect=lambda: 500 if self.state['resident'] in ms.MODELS else None))
        self.enterContext(patch.object(ms, 'mlx_lane_busy', return_value=False))
        self.enterContext(patch.object(swap_policy, 'port_listening', return_value=False))

        class Engine:
            hold = terminal_ticket = None

        self.engine = Engine()

        def adopt(manager):
            manager.model = self.state['resident']
            manager.engine = self.engine
            swap_policy.SWAP.adopt(manager.model)

        async def stop_ds4(manager):
            self.trace.append('native-drain+ds4-exit')
            self.state['resident'] = None
            manager.engine = None

        async def start_ds4(manager, model):
            self.trace.append('fresh-ds4-' + model)
            self.state['resident'] = manager.model = model
            manager.engine = self.engine

        self.enterContext(patch.object(ms.ManagedSwitch, 'adopt', adopt))
        self.enterContext(patch.object(ms.ManagedSwitch, 'stop_ds4_for_winnow', stop_ds4))
        self.enterContext(patch.object(ms.ManagedSwitch, 'start', start_ds4))
        self.enterContext(patch.object(ms.ManagedSwitch, 'binding', lambda manager, model: self.engine))

    async def prepare(self, model):
        result = await self.manager.prepare_with_winnow(model)
        self.manager.release()
        return result

    async def test_reuse_round_trip_and_order(self):
        await self.prepare('winnow-12b')
        await self.prepare('winnow-12b')
        self.assertEqual(self.trace.count('start-winnow'), 1)
        await self.prepare('qwen3.8-flash-next')
        await self.prepare('winnow-12b')
        self.assertEqual(self.trace, ['qualified', 'native-drain+ds4-exit', 'start-winnow',
            'qualified', 'stop-winnow', 'fresh-ds4-qwen3.8-flash-next',
            'qualified', 'native-drain+ds4-exit', 'start-winnow'])
        self.assertEqual(swap_policy.SWAP.state, '1/5/0/0/0')

    async def test_uncertain_stop_refuses_next_start(self):
        async def broken(_manager):
            self.trace.append('failed-native-drain')
            raise RuntimeError('native receipt unknown')
        with patch.object(ms.ManagedSwitch, 'stop_ds4_for_winnow', broken):
            with self.assertRaisesRegex(RuntimeError, 'native receipt unknown'):
                await self.prepare('winnow-12b')
        self.assertNotIn('start-winnow', self.trace)
        self.assertTrue(swap_policy.SWAP.state.startswith('3/'))
        self.assertIsNotNone(self.manager.blocked)

    async def test_foreign_lane_refuses_without_effect(self):
        with patch.object(ms, 'mlx_lane_busy', return_value=True):
            with self.assertRaises(ms.LaneUnproven):
                await self.prepare('winnow-12b')
        self.assertEqual(self.state['resident'], 'deepseek-v4.1-flash')
        self.assertNotIn('start-winnow', self.trace)
        self.assertIsNone(self.manager.blocked)

    async def test_cancel_during_switch_finishes_physical_transition_before_release(self):
        entered, proceed = asyncio.Event(), asyncio.Event()
        original_start = FakeWinnow.start

        async def delayed_start(winnow):
            entered.set()
            await proceed.wait()
            await original_start(winnow)

        with patch.object(FakeWinnow, 'start', delayed_start):
            pending = asyncio.create_task(self.manager.prepare_winnow())
            await entered.wait()
            pending.cancel()
            proceed.set()
            with self.assertRaises(asyncio.CancelledError):
                await pending
        self.assertEqual(self.state['resident'], 'winnow-12b')
        self.assertEqual(swap_policy.SWAP.state, '1/5/0/0/0')
        self.assertIsNone(self.manager.lease)


class RuntimeTests(unittest.TestCase):
    def test_process_identity_is_not_a_port_guess(self):
        from winnow_runtime import WinnowRuntime, BINARY, MODEL, PORT, KEY_FILE
        runtime = WinnowRuntime()
        with patch.object(runtime, 'processes', return_value=[(99, ['/tmp/foreign', '--port', str(PORT)])]):
            with self.assertRaisesRegex(RuntimeError, 'unqualified'):
                runtime.probe()
        args = [str(BINARY), '--model', str(MODEL), '--api-key-file', str(KEY_FILE),
                '--host', '127.0.0.1', '--port', str(PORT)]
        with patch.object(runtime, 'processes', return_value=[(99, args)]), \
             patch('winnow_runtime.subprocess.check_output', return_value='fresh\n'):
            self.assertEqual(runtime.probe(), (99, 'fresh'))


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_decision_only_identity_and_key(self):
        from aiohttp import ClientSession, web
        from aiohttp.test_utils import TestServer
        proxy = load_proxy()
        proxy.PROXY_API_KEY = 'cpu-test-key'
        proxy.AUTH_HEADERS = {'Authorization': 'Bearer cpu-test-key'}
        proxy.INDEPENDENT_SWITCH = object()
        events = []

        async def fake_begin(backend, model, request, managed=False):
            events.append((backend, model, managed))

        async def fake_finish(*args, **kwargs):
            events.append('finished')

        async def fake_upstream(request):
            payload = await request.json()
            self.assertEqual(payload['model'], 'Winnow-12B')
            self.assertEqual(request.headers['Authorization'], 'Bearer cpu-test-key')
            return web.json_response({'model': 'Winnow-12B', 'answers': {'answer': {'type': 'noul', 'noul': .9}}})

        upstream = web.Application()
        upstream.router.add_post('/v1/systemone', fake_upstream)
        server = TestServer(upstream)
        await server.start_server()
        proxy.WINNOW_PORT = server.port
        app = web.Application()
        app.router.add_post('/v1/systemone', proxy.handle_systemone)
        app.router.add_get('/v1/systemone/models', proxy.handle_systemone_models)
        app.router.add_post('/v1/chat/completions', proxy.handle_chat)
        front = TestServer(app)
        await front.start_server()
        try:
            with patch.object(proxy, 'begin_request', fake_begin), patch.object(proxy, 'finish_request', fake_finish):
                async with ClientSession() as session:
                    url = front.make_url('/v1/systemone')
                    payload = {'model': 'winnow-12b', 'state': {'ready': True},
                               'questions': {'answer': {'type': 'noul', 'instructions': 'ready?'}}}
                    async with session.post(url, json=payload) as result:
                        self.assertEqual(result.status, 401)
                    async with session.post(url, json={**payload, 'model': 'kev-latest'},
                            headers=proxy.AUTH_HEADERS) as result:
                        self.assertEqual(result.status, 400)
                    async with session.post(url, json=payload, headers=proxy.AUTH_HEADERS) as result:
                        self.assertEqual(result.status, 200)
                        self.assertEqual((await result.json())['model'], 'Winnow-12B')
                    async with session.get(front.make_url('/v1/systemone/models'), headers=proxy.AUTH_HEADERS) as result:
                        self.assertEqual([m['id'] for m in (await result.json())['data']], ['winnow-12b'])
                    with self.assertRaises(web.HTTPBadRequest):
                        proxy.get_backend_name('winnow-12b')  # never a chat model
            self.assertEqual(events, [('winnow', 'winnow-12b', True), 'finished'])
        finally:
            await front.close()
            await server.close()

    async def test_unverified_upstream_response_retains_gpu_seat(self):
        from aiohttp import ClientSession, web
        from aiohttp.test_utils import TestServer
        proxy = load_proxy()
        proxy.PROXY_API_KEY = 'cpu-test-key'
        proxy.AUTH_HEADERS = {'Authorization': 'Bearer cpu-test-key'}
        proxy.INDEPENDENT_SWITCH = object()
        state = {'busy': False, 'status': 500, 'body': {'error': 'native failure'}, 'forwards': 0}

        async def begin(*args, **kwargs):
            if state['busy']:
                raise web.HTTPServiceUnavailable(text='GPU seat held')

        async def finish(*args, uncertain=False, **kwargs):
            state['busy'] = uncertain

        async def upstream_handler(request):
            state['forwards'] += 1
            if isinstance(state['body'], dict):
                return web.json_response(state['body'], status=state['status'])
            return web.Response(text=state['body'], status=state['status'])

        upstream = web.Application()
        upstream.router.add_post('/v1/systemone', upstream_handler)
        server = TestServer(upstream)
        await server.start_server()
        proxy.WINNOW_PORT = server.port
        front = web.Application()
        front.router.add_post('/v1/systemone', proxy.handle_systemone)
        client = TestServer(front)
        await client.start_server()
        payload = {'model': 'winnow-12b', 'state': {'ready': True},
                   'questions': {'answer': {'type': 'noul', 'instructions': 'ready?'}}}
        try:
            with patch.object(proxy, 'begin_request', begin), patch.object(proxy, 'finish_request', finish):
                async with ClientSession() as session:
                    for status, body in [(500, {'error': 'native failure'}),
                                         (200, 'not JSON'),
                                         (200, {'model': 'other', 'answers': {'answer': {}}}),
                                         (200, {'model': 'Winnow-12B', 'answers': {}})]:
                        state.update(busy=False, status=status, body=body)
                        before = state['forwards']
                        async with session.post(client.make_url('/v1/systemone'), json=payload,
                                                headers=proxy.AUTH_HEADERS) as response:
                            self.assertGreaterEqual(response.status, 400)
                            await response.read()
                        self.assertTrue(state['busy'])
                        async with session.post(client.make_url('/v1/systemone'), json=payload,
                                                headers=proxy.AUTH_HEADERS) as response:
                            self.assertEqual(response.status, 503)
                        self.assertEqual(state['forwards'], before + 1)
        finally:
            await client.close()
            await server.close()


if __name__ == '__main__':
    unittest.main()
