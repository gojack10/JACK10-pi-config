"""CPU-only boundary/lifecycle checks. No model load, secrets or live services."""
import asyncio
import importlib.util
import json
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import managed_switch as ms
import swap_policy
import startlux_runtime as sr

ROOT = Path(__file__).resolve().parents[1]
ID, UPSTREAM = sr.MODEL_ID, sr.UPSTREAM_ID


def load_proxy():
    spec = importlib.util.spec_from_file_location('startlux_proxy_test', ROOT / 'local-proxy.py')
    proxy = importlib.util.module_from_spec(spec)
    with patch.dict(os.environ, {'LOCAL_LLM_PROXY_API_KEY': 'cpu-test-key'}):
        spec.loader.exec_module(proxy)
    return proxy


class FakeStartLux:
    def __init__(self, state, trace):
        self.state, self.trace = state, trace

    def probe(self):
        return (100, 'fresh') if self.state['resident'] == ID else None

    def qualify(self):
        self.trace.append('qualified')

    async def ready(self, identity):
        return identity == (100, 'fresh')

    async def start(self):
        self.trace.append('start-startlux')
        self.state['resident'] = ID

    async def stop(self):
        self.trace.append('stop-startlux')
        self.state['resident'] = None


class ManagedTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.state, self.trace = {'resident': 'deepseek-v4.1-flash'}, []
        self.startlux = FakeStartLux(self.state, self.trace)
        self.manager = ms.ManagedSwitch(inherited_lease=object(), startlux=self.startlux)
        self.enterContext(patch.object(swap_policy, 'SWAP', swap_policy.SwapPolicy()))
        self.enterContext(patch.object(ms, 'service_pid', side_effect=lambda: 500 if self.state['resident'] in ms.MODELS else None))
        self.enterContext(patch.object(ms, 'mlx_lane_busy', return_value=False))
        self.enterContext(patch.object(swap_policy, 'port_listening', return_value=False))
        self.engine = SimpleNamespace(hold=None, terminal_ticket=None)

        def adopt(manager):
            manager.model, manager.engine = self.state['resident'], self.engine
            swap_policy.SWAP.adopt(manager.model)

        async def stop_ds4(manager):
            self.trace.append('native-drain+ds4-exit')
            self.state['resident'], manager.engine = None, None

        async def start_ds4(manager, model):
            self.trace.append('fresh-ds4-' + model)
            self.state['resident'] = manager.model = model
            manager.engine = self.engine

        self.enterContext(patch.object(ms.ManagedSwitch, 'adopt', adopt))
        self.enterContext(patch.object(ms.ManagedSwitch, 'stop_ds4_for_startlux', stop_ds4))
        self.enterContext(patch.object(ms.ManagedSwitch, 'start', start_ds4))
        self.enterContext(patch.object(ms.ManagedSwitch, 'binding', lambda manager, model: self.engine))
        self.enterContext(patch.object(ms, 'record'))

    async def prepare(self, model):
        result = await self.manager.prepare_with_startlux(model)
        self.manager.release()
        return result

    async def test_reuse_round_trip_and_order(self):
        await self.prepare(ID)
        await self.prepare(ID)
        self.assertEqual(self.trace.count('start-startlux'), 1)
        await self.prepare('qwen3.8-flash-next')
        await self.prepare(ID)
        self.assertEqual(self.trace, ['qualified', 'native-drain+ds4-exit', 'start-startlux',
            'qualified', 'stop-startlux', 'fresh-ds4-qwen3.8-flash-next',
            'qualified', 'native-drain+ds4-exit', 'start-startlux'])
        self.assertEqual(swap_policy.SWAP.state, '1/5/0/0/0')

    async def test_mlx_warm_reuse_and_serial_cross_engine_switches(self):
        state, trace = self.state, self.trace
        class MLX:
            model = None
            def probe(engine):
                return (200, 'mlx') if state['resident'] in ms.MLX_MODELS else None
            def qualify(engine):
                pass
            async def start(engine, model):
                assert state['resident'] is None, 'overlapping engines'
                trace.append('load-' + model)
                state['resident'] = engine.model = model
            async def stop(engine):
                trace.append('drain+exit-' + engine.model)
                state['resident'] = None
        self.manager.mlx = MLX()
        def bind(manager, model):
            return manager.mlx if model in ms.MLX_MODELS else self.engine
        with patch.object(ms.ManagedSwitch, 'binding', bind), \
             patch.object(ms, 'service_pid', side_effect=lambda: 500 if state['resident'] in ms.MODELS else None):
            for model in ('qwen3.8-27b-uncensored', 'qwen3.8-27b-uncensored', 'gemma-4-31b-mlx', ID):
                await self.prepare(model)
        self.assertEqual(trace, ['native-drain+ds4-exit', 'load-qwen3.8-27b-uncensored',
            'drain+exit-qwen3.8-27b-uncensored', 'load-gemma-4-31b-mlx',
            'qualified', 'drain+exit-gemma-4-31b-mlx', 'start-startlux'])

    async def test_uncertain_stop_refuses_next_start(self):
        with patch.object(ms.ManagedSwitch, 'stop_ds4_for_startlux', AsyncMock(side_effect=RuntimeError('unknown drain'))):
            with self.assertRaisesRegex(RuntimeError, 'unknown drain'):
                await self.prepare(ID)
        self.assertNotIn('start-startlux', self.trace)
        self.assertTrue(swap_policy.SWAP.state.startswith('3/'))
        self.assertIsNotNone(self.manager.blocked)
        self.assertIsNotNone(self.manager.lease)

    async def test_failed_start_retains_lease_and_refuses_successor(self):
        with patch.object(self.startlux, 'start', AsyncMock(side_effect=RuntimeError('failed load'))):
            with self.assertRaisesRegex(RuntimeError, 'failed load'):
                await self.prepare(ID)
        self.assertIsNotNone(self.manager.blocked)
        self.assertIsNotNone(self.manager.lease)
        self.assertTrue(swap_policy.SWAP.state.startswith('3/'))
        with self.assertRaisesRegex(RuntimeError, 'unavailable'):
            await self.manager.prepare_with_startlux('qwen3.8-flash-next')
        self.assertNotIn('fresh-ds4-qwen3.8-flash-next', self.trace)

    async def test_foreign_lane_refuses_without_effect(self):
        with patch.object(ms, 'mlx_lane_busy', return_value=True):
            with self.assertRaises(ms.LaneUnproven):
                await self.prepare(ID)
        self.assertEqual(self.state['resident'], 'deepseek-v4.1-flash')
        self.assertNotIn('start-startlux', self.trace)
        self.assertIsNone(self.manager.blocked)

    async def test_cancel_during_switch_settles_before_release(self):
        entered, proceed = asyncio.Event(), asyncio.Event()
        original = FakeStartLux.start
        async def delayed(engine):
            entered.set()
            await proceed.wait()
            await original(engine)
        with patch.object(FakeStartLux, 'start', delayed):
            task = asyncio.create_task(self.manager.prepare_startlux())
            await entered.wait()
            task.cancel()
            self.assertIsNotNone(self.manager.lease)
            proceed.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(self.state['resident'], ID)
        self.assertEqual(swap_policy.SWAP.state, '1/5/0/0/0')
        self.assertIsNone(self.manager.lease)


class RuntimeTests(unittest.TestCase):
    def test_child_auth_is_private_and_independent_of_public_key_format(self):
        runtime = sr.StartLuxRuntime()
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(sr, 'LOG_FILE', Path(directory)/'server.log'), \
             patch.object(sr, 'KEY_FILE', SimpleNamespace(read_text=Mock(side_effect=AssertionError('public key read')))):
            runtime.prepare_auth()
            token = runtime.key_file.read_text().strip()
            self.assertEqual(len(token), 64)
            self.assertEqual(runtime.key_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(runtime.child_headers, {'Authorization':'Bearer '+token})
            self.assertEqual(runtime.argv()[runtime.argv().index('--api-keys-file')+1], str(runtime.key_file))
            self.assertNotIn(token, runtime.argv())
            with self.assertRaisesRegex(RuntimeError, 'already initialized'):
                runtime.prepare_auth()

    def test_identity_is_not_a_port_guess_or_retained_adoption(self):
        runtime = sr.StartLuxRuntime()
        with patch.object(runtime, 'processes', return_value=[(99, ['/tmp/foreign', '--port', str(sr.PORT)])]):
            with self.assertRaisesRegex(RuntimeError, 'unqualified'):
                runtime.probe()
        with patch.object(runtime, 'processes', return_value=[(99, runtime.argv())]), \
             patch.object(sr.subprocess, 'check_output', return_value='fresh\n'):
            with self.assertRaisesRegex(RuntimeError, 'Retained'):
                runtime.probe()
            runtime.identity = (99, 'fresh')
            self.assertEqual(runtime.probe(), runtime.identity)

    def test_foreign_listener_is_not_empty(self):
        runtime = sr.StartLuxRuntime()
        with patch.object(runtime, 'processes', return_value=[]), patch.object(swap_policy, 'port_listening', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'Foreign listener'):
                runtime.probe()


class RuntimeLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.runtime = sr.StartLuxRuntime()
        self.identity = (99, 'incarnation')
        self.runtime.identity = self.identity
        self.runtime.child_headers = {'Authorization':'Bearer offline-child-fixture'}

    async def test_readiness_requires_native_attention_and_owned_incarnation(self):
        data = dict(model=UPSTREAM, kind='instant', prompt_attention='bidirectional', images=False,
                    context_length=64000, engine=dict(name='mlx', prompt_attention_check=dict(
                        first_position_change=.01, layers=32, full_attention_layers=8)))
        response = SimpleNamespace(status=200, json=AsyncMock(return_value=data))
        session = Mock()
        session.get.return_value.__aenter__ = AsyncMock(return_value=response)
        session.get.return_value.__aexit__ = AsyncMock(return_value=False)
        context = Mock()
        context.__aenter__ = AsyncMock(return_value=session)
        context.__aexit__ = AsyncMock(return_value=False)
        with patch.object(sr, 'ClientSession', return_value=context), \
             patch.object(sr, 'KEY_FILE', SimpleNamespace(read_text=lambda: 'offline-fixture')), \
             patch.object(self.runtime, 'alive', return_value=True), \
             patch.object(self.runtime, 'probe', return_value=self.identity):
            self.assertTrue(await self.runtime.ready(self.identity))
            self.assertEqual(session.get.call_args.kwargs['headers'], self.runtime.child_headers)
            for changes in ({'model':'Winnow-12B'}, {'kind':'auto'}, {'images':True},
                            {'context_length':262144}, {'engine':{'name':'mlx'}},
                            {'prompt_attention':'causal'}):
                with patch.dict(data, changes):
                    self.assertFalse(await self.runtime.ready(self.identity))
            with patch.object(self.runtime, 'probe', return_value=(100, 'replacement')):
                self.assertFalse(await self.runtime.ready(self.identity))

    async def test_start_timeout_retains_child_identity_without_kill_or_release(self):
        process = SimpleNamespace(pid=99, returncode=None)
        with patch.object(self.runtime, 'qualify'), patch.object(self.runtime, 'probe', return_value=None), \
             patch.object(self.runtime, 'prepare_auth'), \
             patch.object(sr.os, 'open', return_value=123), patch.object(sr.os, 'close'), \
             patch.object(sr.os, 'kill') as kill, \
             patch.object(sr.subprocess, 'check_output', return_value='incarnation'), \
             patch.object(sr.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as start, \
             patch.object(sr, 'time', SimpleNamespace(monotonic=Mock(side_effect=[0, 901]))):
            with self.assertRaisesRegex(RuntimeError, 'readiness timeout'):
                await self.runtime.start()
        start.assert_awaited_once()
        kill.assert_not_called()
        self.assertIs(self.runtime.process, process)
        self.assertEqual(self.runtime.identity, self.identity)

    async def test_graceful_exit_proves_gone_and_only_sigterm(self):
        process = SimpleNamespace(pid=99, wait=AsyncMock())
        self.runtime.process = process
        self.runtime.key_file = Mock()
        credential = self.runtime.key_file
        with patch.object(self.runtime, 'probe', side_effect=[self.identity, None]), \
             patch.object(self.runtime, 'alive', return_value=False), patch.object(sr.os, 'kill') as kill:
            await self.runtime.stop()
        kill.assert_called_once_with(99, 15)
        process.wait.assert_awaited_once()
        credential.unlink.assert_called_once_with()
        self.assertIsNone(self.runtime.key_file)
        self.assertIsNone(self.runtime.child_headers)
        self.assertIsNone(self.runtime.identity)

    async def test_timeout_or_replacement_does_not_claim_exit(self):
        with patch.object(self.runtime, 'probe', return_value=self.identity), \
             patch.object(self.runtime, 'alive', return_value=True), patch.object(sr.os, 'kill') as kill, \
             patch.object(sr, 'time', SimpleNamespace(monotonic=Mock(side_effect=[0, 91]))):
            with self.assertRaisesRegex(RuntimeError, 'did not exit'):
                await self.runtime.stop()
        kill.assert_called_once_with(99, 15)
        self.assertEqual(self.runtime.identity, self.identity)
        with patch.object(self.runtime, 'probe', side_effect=[self.identity, (100, 'replacement')]), \
             patch.object(self.runtime, 'alive', return_value=False), patch.object(sr.os, 'kill'):
            with self.assertRaisesRegex(RuntimeError, 'replaced'):
                await self.runtime.stop()
        self.assertEqual(self.runtime.identity, self.identity)

    async def test_preflight_invalid_and_failure_are_not_native_completion(self):
        payload = {'model': ID}
        with patch.object(self.runtime, 'qualify'), patch.object(sr.subprocess, 'run') as run:
            run.return_value = SimpleNamespace(returncode=2, stdout='{}')
            with self.assertRaises(ValueError): await self.runtime.preflight(payload)
            run.return_value = SimpleNamespace(returncode=1, stdout='')
            with self.assertRaises(RuntimeError): await self.runtime.preflight(payload)
            run.return_value = SimpleNamespace(returncode=0, stdout='{"valid":true}')
            await self.runtime.preflight(payload)
            self.assertIn('-I', run.call_args.args[0])
        self.assertEqual(self.runtime.identity, self.identity)


class ResponseTests(unittest.TestCase):
    def test_upstream_typed_answers_and_bad_shapes(self):
        questions = {'c': {'type':'choice','criteria':{'a':None,'b':None}},
                     's': {'type':'score','criteria':['low','high']}, 'n': {'type':'noul'}}
        answers = {'c': {'type':'choice','choice':'a','confidence':.4,'probabilities':{'a':.7,'b':.3}},
                   's': {'type':'score','score':.3,'confidence':.4,'probabilities':{'0':.7,'1':.3},
                         'legend':{'0':'low','1':'high'}}, 'n':{'type':'noul','noul':.7}}
        result = {'model':UPSTREAM,'answers':answers,'usage':{'input_tokens':100,'output_tokens':0}}
        sr.StartLuxRuntime.validate_response({'questions':questions}, result)
        for key, changes in (('c',{'choice':None}), ('c',{'confidence':float('nan')}),
                             ('c',{'probabilities':{'a':1}}), ('s',{'score':20}),
                             ('n',{'noul':True}), ('n',{'noul':float('inf')})):
            with patch.dict(answers[key], changes):
                with self.assertRaises(RuntimeError):
                    sr.StartLuxRuntime.validate_response({'questions':questions}, result)


class BodyReadTests(unittest.IsolatedAsyncioTestCase):
    """Preserves the inherited EOF/fragmentation/1MiB regression coverage."""
    LIMIT = 1024 * 1024

    def setUp(self):
        self.proxy = load_proxy()
        self.proxy.INDEPENDENT_SWITCH = object()
        self.preflight = self.enterContext(patch.object(self.proxy.STARTLUX, 'preflight', AsyncMock()))
        self.begin = self.enterContext(patch.object(self.proxy, 'begin_request', AsyncMock()))
        self.finish = self.enterContext(patch.object(self.proxy, 'finish_request', AsyncMock()))
        self.session = self.enterContext(patch.object(self.proxy, 'ClientSession'))
        self.session.return_value.__aenter__.return_value = self.session.return_value
        self.upstream = self.session.return_value.post.return_value.__aenter__.return_value
        self.upstream.status, self.upstream.content_type = 200, 'application/json'
        self.upstream.read = AsyncMock(return_value=json.dumps({'model': UPSTREAM, 'answers': {'answer': {'type': 'noul', 'noul': .9}}, 'usage': {'input_tokens': 100, 'output_tokens': 0}}).encode())
        self.post = self.session.return_value.post
        self.parse = self.enterContext(patch.object(self.proxy, 'parse_json_body', wraps=self.proxy.parse_json_body))
        self.enterContext(patch.object(self.proxy, 'client_disconnected', return_value=False))
        self.enterContext(patch.object(self.proxy.subprocess, 'run', side_effect=AssertionError('process forbidden')))
        self.enterContext(patch.object(self.proxy.subprocess, 'check_output', side_effect=AssertionError('process forbidden')))
        self.enterContext(patch.object(self.proxy.asyncio, 'create_subprocess_exec', side_effect=AssertionError('process forbidden')))

    def request(self):
        from aiohttp import StreamReader
        return SimpleNamespace(headers=dict(self.proxy.AUTH_HEADERS), content=StreamReader(Mock(_reading_paused=False), limit=self.LIMIT * 2))

    def body(self, size=None, **changes):
        payload = {'model': ID, 'state': {'text': 'complete'}, 'questions': {'answer': {'type': 'noul', 'instructions': 'ready?'}}}
        payload.update(changes)
        body = json.dumps(payload, ensure_ascii=False).encode()
        if size is not None:
            payload['state']['text'] += 'x' * (size - len(body))
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.assertEqual(len(body), size)
        return body

    async def call(self, body):
        request = self.request()
        request.content.feed_data(body)
        request.content.feed_eof()
        return await self.proxy.handle_systemone(request)

    async def assert_rejected(self, body, status, message):
        with self.assertRaises(self.proxy.web.HTTPException) as caught:
            await self.call(body)
        self.assertEqual(caught.exception.status, status)
        self.assertIn(message, caught.exception.text)
        self.begin.assert_not_awaited()
        self.session.assert_not_called()
        self.finish.assert_not_awaited()

    async def test_large_fragmented_body_waits_for_eof(self):
        body = self.body(600_000, state={'text': 'fragmented é body'})
        request = self.request()
        request.content.feed_data(body[:1])
        pending = asyncio.create_task(self.proxy.handle_systemone(request))
        try:
            start = 1
            for end in (1, 17, body.index('é'.encode()) + 1, 262144, len(body) - 1, len(body)):
                request.content.feed_data(body[start:end])
                start = end
                await asyncio.sleep(0)
                self.assertFalse(pending.done())
                self.parse.assert_not_called()
                self.begin.assert_not_awaited()
            request.content.feed_eof()
            self.assertEqual((await pending).status, 200)
            self.assertEqual(self.parse.call_args.args[0], body)
            self.assertEqual(self.post.call_args.kwargs['json'], {**json.loads(body), 'model': UPSTREAM})
        finally:
            if not pending.done(): pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)

    async def test_exact_one_mib_body_is_accepted_before_independent_token_preflight(self):
        body = self.body(self.LIMIT)
        self.assertEqual((await self.call(body)).status, 200)
        self.assertEqual(self.parse.call_args.args[0], body)
        self.preflight.assert_awaited_once()

    async def test_fragmented_oversize_stops_at_limit_plus_one(self):
        request = self.request()
        body = self.body(self.LIMIT + 1)
        request.content.feed_data(body[:17])
        task = asyncio.create_task(self.proxy.handle_systemone(request))
        try:
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            request.content.feed_data(body[17:] + b'unread suffix')
            with self.assertRaises(self.proxy.web.HTTPRequestEntityTooLarge): await task
            self.parse.assert_not_called()
            self.begin.assert_not_awaited()
            self.session.assert_not_called()
            request.content.feed_eof()
            self.assertEqual(await request.content.read(), b'unread suffix')
        finally:
            if not task.done(): task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_invalid_json_is_not_model_error(self):
        for body in (b'{"model":"startlux-4b-instant",', b'', b'\xff'):
            await self.assert_rejected(body, 400, 'Invalid JSON body')

    async def test_wrong_model_is_distinct(self):
        await self.assert_rejected(self.body(model='winnow-12b'), 400, 'Explicit model startlux-4b-instant required')

    async def test_non_object_json_is_distinct(self):
        await self.assert_rejected(b'[]', 400, 'Expected JSON object')

    async def test_state_and_named_questions_required(self):
        for changes in ({'state': None}, {'questions': {}}, {'questions': []}):
            await self.assert_rejected(self.body(**changes), 400, 'StartLux requires state and named questions')

    async def test_authentication_precedes_read(self):
        request = self.request()
        request.headers = {}
        with self.assertRaises(self.proxy.web.HTTPUnauthorized): await self.proxy.handle_systemone(request)
        self.parse.assert_not_called()
        self.begin.assert_not_awaited()

    async def test_bad_preflight_precedes_admission(self):
        self.preflight.side_effect = ValueError('oversized')
        await self.assert_rejected(self.body(), 400, 'oversized')

    async def test_unknown_completion_retains_gpu_seat(self):
        for status, body in ((500, {'error': 'failure'}), (200, 'not JSON'), (200, {'model': 'other', 'answers': {'answer': {}}}), (200, {'model': UPSTREAM, 'answers': {}}), (200, {'model': UPSTREAM, 'answers': {'answer': {}}})):
            self.upstream.status = status
            self.upstream.read.return_value = json.dumps(body).encode() if isinstance(body, dict) else body.encode()
            try: await self.call(self.body())
            except (RuntimeError, ValueError): pass
            self.assertTrue(self.finish.call_args.kwargs['uncertain'])

    async def test_cancelled_forward_is_uncertain_not_gpu_completion(self):
        self.upstream.read.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.call(self.body())
        self.assertTrue(self.finish.call_args.kwargs['uncertain'])

    async def test_disconnect_does_not_skip_drain(self):
        with patch.object(self.proxy, 'client_disconnected', return_value=True):
            self.assertEqual((await self.call(self.body())).status, 200)
        self.upstream.read.assert_awaited_once()
        self.assertFalse(self.finish.call_args.kwargs['uncertain'])
        self.assertTrue(self.finish.call_args.kwargs['release_chat'])

    async def test_response_identity_and_decision_only_advertisement(self):
        self.proxy.STARTLUX.child_headers = {'Authorization':'Bearer offline-child-fixture'}
        self.assertEqual((await self.call(self.body())).status, 200)
        self.assertEqual(self.post.call_args.kwargs['headers'], self.proxy.STARTLUX.child_headers)
        self.begin.assert_awaited_once()
        self.assertEqual(self.begin.call_args.args[:2], ('startlux', ID))
        result = await self.proxy.handle_systemone_models(self.request())
        model = json.loads(result.body)['data'][0]
        self.assertEqual((model['id'], model['name'], model['context_length']), (ID, UPSTREAM, 64000))
        with self.assertRaises(self.proxy.web.HTTPBadRequest): self.proxy.get_backend_name(ID)


if __name__ == '__main__': unittest.main()
