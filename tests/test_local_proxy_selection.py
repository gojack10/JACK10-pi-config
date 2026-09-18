"""Offline only: no server, sockets, launchctl, or real model operations.
Run with any interpreter that has aiohttp, from the repo root:
  python -m unittest discover -s tests -p test_local_proxy_selection.py -v
"""
import asyncio
import importlib.util
import json
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

SOURCE = Path(__file__).resolve().parents[1] / "local-proxy.py"


def load_proxy():
    spec = importlib.util.spec_from_file_location("proxy_under_test", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SelectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.p = p = load_proxy()
        self.loaded = p.GLM_FLASH_MODEL_ID
        self.events = []
        self.fail_start = False
        self.busy = False

        async def detect(refresh=False):
            return self.loaded

        async def stop():
            self.events.append("stop")
            self.loaded = None

        def desired(mode):
            self.events.append("desired:" + mode)
            self.desired = p._model_id_from_mode(mode)

        async def start():
            self.events.append("start")
            if not self.fail_start:
                self.loaded = self.desired

        async def wait(model):
            return self.loaded == model

        mocks = {
            "detect_ds4_loaded_model": detect,
            "ds4_v1_ready": AsyncMock(return_value=True),
            "ds4_is_busy": AsyncMock(side_effect=lambda: self.busy),
            "stop_dsv4": stop,
            "start_dsv4": start,
            "_write_ds4_desired_model_sync": desired,
            "wait_for_ds4_model": wait,
            "omlx_unload_all": AsyncMock(),
        }
        for name, value in mocks.items():
            self.enterContext(patch.object(p, name, value))
        # Fail closed if any unmocked production I/O escapes these tests.
        self.enterContext(patch.object(p, "ClientSession", side_effect=AssertionError("network forbidden")))
        self.enterContext(patch.object(p.asyncio, "create_subprocess_exec", side_effect=AssertionError("process forbidden")))
        self.enterContext(patch.object(p.subprocess, "check_output", side_effect=AssertionError("process forbidden")))

    async def test_exact_routes_and_unknowns(self):
        p = self.p
        for mid in (p.GLM_FLASH_MODEL_ID, p.QWEN_NEXT_MODEL_ID):
            self.assertEqual(p.get_backend_name(mid), "ds4")
        for mid in ("typo", "", None, [], "qwen", p.DS4_FLASH_MODEL_ID, p.DS4_PRO_MODEL_ID):
            with self.assertRaises(p.web.HTTPBadRequest):
                p.get_backend_name(mid)
        self.assertEqual(p.ds4_static_model(p.QWEN_NEXT_MODEL_ID)["context_length"], 500000)
        self.assertEqual(p.ds4_static_model(p.GLM_FLASH_MODEL_ID)["context_length"], 500000)
        body = json.dumps({"model": p.QWEN_NEXT_MODEL_ID, "reasoning_effort": "xhigh"}).encode()
        self.assertEqual(p.maybe_prepare_chat_body("ds4", body), body)

    async def test_batching_and_switch_waits_for_entire_request(self):
        p = self.p
        await p.begin_request("ds4", p.GLM_FLASH_MODEL_ID)
        await p.begin_request("ds4", p.GLM_FLASH_MODEL_ID)
        pending = asyncio.create_task(p.begin_request("ds4", p.QWEN_NEXT_MODEL_ID))
        await asyncio.sleep(0)
        self.assertFalse(pending.done())
        self.assertEqual(self.events, [])
        await p.finish_request("ds4")
        await asyncio.sleep(0)
        self.assertFalse(pending.done())
        await p.finish_request("ds4")
        await pending
        self.assertEqual(self.events, ["stop", "desired:qwen", "start"])
        await p.finish_request("ds4")
        self.assertEqual(self.loaded, p.QWEN_NEXT_MODEL_ID)  # No automatic restore.
        self.assertEqual(p.DS4_ACTIVE_REQUESTS, 0)
        await p.begin_request("ds4", p.QWEN_NEXT_MODEL_ID)
        await p.finish_request("ds4")
        self.assertEqual(self.events, ["stop", "desired:qwen", "start"])
        await p.begin_request("ds4", p.GLM_FLASH_MODEL_ID)
        await p.finish_request("ds4")
        self.assertEqual(self.events[-3:], ["stop", "desired:glm", "start"])

    async def test_failed_qwen_never_forwards_or_restores(self):
        p = self.p
        self.fail_start = True
        request = type("Request", (), {"read": AsyncMock(return_value=json.dumps({"model": p.QWEN_NEXT_MODEL_ID}).encode())})()
        with self.assertRaises(p.web.HTTPServiceUnavailable) as error:
            await p.handle_chat(request)
        self.assertIn("no fallback", error.exception.text)
        self.assertEqual(self.events, ["stop", "desired:qwen", "start"])
        self.assertIsNone(self.loaded)
        self.assertEqual(p.ACTIVE_REQUESTS, 0)
        self.assertEqual(p.DS4_ACTIVE_REQUESTS, 0)

    async def test_cancelled_waiter_does_not_release_active_request(self):
        p = self.p
        await p.begin_request("ds4", p.GLM_FLASH_MODEL_ID)
        waiter = asyncio.create_task(p.begin_request("ds4", p.QWEN_NEXT_MODEL_ID))
        await asyncio.sleep(0)
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        self.assertEqual(p.DS4_ACTIVE_REQUESTS, 1)
        self.assertEqual(self.events, [])
        await p.finish_request("ds4")

    async def test_external_busy_waits_without_stop(self):
        p = self.p
        self.busy = True
        task = asyncio.create_task(p.begin_request("ds4", p.QWEN_NEXT_MODEL_ID))
        await asyncio.sleep(0.01)
        self.assertEqual(self.events, [])
        self.busy = False
        await task
        await p.finish_request("ds4")
        self.assertEqual(self.events, ["stop", "desired:qwen", "start"])

    async def test_idle_unload_does_not_select_glm(self):
        p = self.p
        self.loaded = p.QWEN_NEXT_MODEL_ID
        p.DS4_LAST_REQUEST_AT = p.time.monotonic() - p.DS4_IDLE_TIMEOUT - 1
        ticks = 0

        async def tick(_):
            nonlocal ticks
            ticks += 1
            if ticks > 1:
                raise asyncio.CancelledError

        with patch.object(p.asyncio, "sleep", tick):
            with self.assertRaises(asyncio.CancelledError):
                await p.ds4_idle_check_loop()
        self.assertEqual(self.events, ["stop"])
        self.assertIsNone(self.loaded)

    async def test_handler_keeps_reservation_until_backend_response(self):
        p = self.p
        entered, release = asyncio.Event(), asyncio.Event()

        class Response:
            status = 200
            content_type = "application/json"
            async def __aenter__(self):
                entered.set()
                return self
            async def __aexit__(self, *args):
                pass
            async def read(self):
                await release.wait()
                return b'{}'

        class Session:
            def __init__(self, **kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            def post(self, *args, **kwargs):
                return Response()

        request = type("Request", (), {
            "read": AsyncMock(return_value=json.dumps({"model": p.GLM_FLASH_MODEL_ID}).encode()),
            "headers": {},
            "transport": type("Transport", (), {"is_closing": lambda _: False})(),
        })()
        with patch.object(p, "ClientSession", Session):
            response = asyncio.create_task(p.handle_chat(request))
            await entered.wait()
            switch = asyncio.create_task(p.begin_request("ds4", p.QWEN_NEXT_MODEL_ID))
            await asyncio.sleep(0)
            self.assertFalse(switch.done())
            self.assertEqual(self.events, [])
            release.set()
            await response
            await switch
            await p.finish_request("ds4")
        self.assertEqual(self.events, ["stop", "desired:qwen", "start"])


class FailClosedTests(unittest.IsolatedAsyncioTestCase):
    async def test_unreadable_stats_are_busy(self):
        p = load_proxy()
        with patch.object(p, "ClientSession", side_effect=RuntimeError("unreachable")):
            self.assertTrue(await p.ds4_is_busy())

    async def test_failed_shutdown_prevents_replacement(self):
        p = load_proxy()
        proc = type("Process", (), {"returncode": 1, "communicate": AsyncMock(return_value=(b"", b"denied"))})()
        with patch.object(p.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)):
            with self.assertRaises(p.web.HTTPServiceUnavailable):
                await p.stop_dsv4()

    async def test_process_detection_is_port_specific_and_fail_closed(self):
        p = load_proxy()
        prefix = "123 /Users/jack/dsv4-qwen38-integration/ds4-server -m /tmp/Qwen3.8-Flash-Next-Q4.gguf --port "
        glm = "124 /Users/jack/dsv4-glm-metal/ds4-server -m /tmp/GLM-5.3-Flash-Q2.gguf --port 8001"
        for text, expected in ((prefix + "8001", p.QWEN_NEXT_MODEL_ID), (prefix + "8009", None), (glm, p.GLM_FLASH_MODEL_ID)):
            with patch.object(p.subprocess, "check_output", return_value=text):
                self.assertEqual(p._detect_ds4_loaded_model_sync(), expected)
        with patch.object(p.subprocess, "check_output", return_value="123 /tmp/ds4-server -m unknown --port 8001"):
            with self.assertRaises(RuntimeError):
                p._detect_ds4_loaded_model_sync()


class TelemetryTests(unittest.IsolatedAsyncioTestCase):
    async def stats(self, resident, rows, after=None):
        p = load_proxy()
        other = {"id": p.GLM_FLASH_MODEL_ID, "generating": [{"id": "other-backend"}]}

        class Response:
            status = 200
            def __init__(self, models):
                self.models = models
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            async def json(self):
                return {"active_models": {"models": self.models}}

        class Session:
            def __init__(self, **kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            def get(self, url, **kwargs):
                return Response(rows if url == p.BACKENDS['ds4']['admin'] + '/api/stats'
                                else [other] if url == p.BACKENDS['omlx']['admin'] + '/api/stats' else [])

        detector = AsyncMock(side_effect=resident if isinstance(resident, Exception)
                             else [resident, resident if after is None else after])
        with patch.object(p, 'ClientSession', Session), \
             patch.object(p, 'detect_ds4_loaded_model', detector), \
             patch.object(p.subprocess, 'check_output', side_effect=AssertionError('process forbidden')), \
             patch.object(p.asyncio, 'create_subprocess_exec', side_effect=AssertionError('process forbidden')):
            request = type('Request', (), {'headers': {}})()
            response = await p.handle_admin_stats(request)
        return json.loads(response.text)['active_models']['models'], detector

    async def test_actual_resident_id_for_glm_and_qwen_with_legacy_and_duplicate_ids(self):
        for resident in ('glm-5.3-flash', 'qwen3.8-flash-next'):
            for ids in (['tunnel-model'], ['tunnel-model'] * 2,
                        ['glm-5.3-flash', 'qwen3.8-flash-next']):
                with self.subTest(resident=resident, ids=ids):
                    activity = {'prefilling': [{'request_id': 'p', 'processed_tokens': 42}],
                                'generating': [{'request_id': 'g', 'tokens_per_second': 12.5}]}
                    rows = [{'id': ids[0], 'prefilling': [], 'generating': []}]
                    rows += [{'id': mid, **activity} for mid in ids]
                    models, detector = await self.stats(resident, rows)
                    self.assertEqual(models[0], {'id': resident, **activity})
                    self.assertEqual(sum(m['id'] == resident for m in models), 1)
                    self.assertEqual(rows[0]['id'], ids[0])  # Do not mutate backend data.
                    self.assertEqual(detector.await_count, 2)
                    for call in detector.await_args_list:
                        self.assertEqual(call.kwargs, {'refresh': True})

    async def test_unknown_or_changing_resident_omits_ds4_not_other_backends(self):
        rows = [{'id': 'tunnel-model', 'generating': [{'id': 'ds4'}]}]
        for resident, after in ((None, None), (RuntimeError('ambiguous'), None),
                                ('qwen3.8-flash-next', 'glm-5.3-flash'),
                                ('qwen3.8-flash-next', RuntimeError('inspection failed'))):
            with self.subTest(resident=resident, after=after):
                models, _ = await self.stats(resident, rows, after)
                self.assertEqual(models, [{'id': 'glm-5.3-flash',
                                           'generating': [{'id': 'other-backend'}]}])


class WrapperTests(unittest.TestCase):
    def test_wrapper_argv_without_exec_or_model_load(self):
        source = Path('/Users/jack/.dsv4/dsv4-server-wrapper.sh').read_text()
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / '.dsv4').mkdir()
            script = 'mock_exec() { printf "%s\\n" "$@"; exit 0; }\n' + source.replace('HOME_DIR="/Users/jack"', f'HOME_DIR="{home}"').replace('exec "', 'mock_exec "')
            for mode, model, ctx in [('qwen', 'qwen3.8-flash-next', '500000'), ('glm', 'glm-5.3-flash', '500000')]:
                (home / '.dsv4/desired-model').write_text(mode)
                result = subprocess.run(['/bin/sh', '-c', script], capture_output=True, text=True, check=True)
                args = result.stdout.splitlines()
                self.assertEqual(args[args.index('--ctx') + 1], ctx)
                self.assertEqual((home / '.dsv4/active-model.intent').read_text().strip(), model)
                self.assertNotIn('--kv-disk-dir', args)
                self.assertNotIn('--vision', args)
                self.assertNotIn('--ssd-streaming', args)
                if mode == 'qwen':
                    self.assertEqual(args[0], str(home / 'dsv4-qwen38-integration/ds4-server'))
                    self.assertIn(str(home / 'projects/ds4/gguf/Qwen3.8-Flash-Next-Q4.gguf'), args)
                else:
                    self.assertEqual(args[0], str(home / 'dsv4-glm-metal/ds4-server'))
                    self.assertIn('--mtp', args)
                    self.assertEqual(args[args.index('--batched-session') + 1], '4')
            (home / '.dsv4/desired-model').write_text('typo')
            result = subprocess.run(['/bin/sh', '-c', script], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')


if __name__ == "__main__":
    unittest.main()
