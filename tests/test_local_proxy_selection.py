"""Offline only: no server, sockets, launchctl, or real model operations.
Run from the repo root:
  uv run --with aiohttp python -m unittest discover -s tests -p test_local_proxy_selection.py -v
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
        self.enterContext(patch.object(p.swap_policy, "SWAP", p.swap_policy.SwapPolicy()))
        self.enterContext(patch.object(p.swap_policy, "port_listening", return_value=False))
        self.enterContext(patch.object(p.WINNOW, "probe", return_value=None))
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
            self.desired = {"glm": p.GLM_FLASH_MODEL_ID, "qwen": p.QWEN_NEXT_MODEL_ID,
                            "ds41": p.DS41_MODEL_ID}[mode]

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
            "stop_mlx": AsyncMock(),
            "mlx_resident_model": AsyncMock(return_value=None),
            "mlx_service_loaded": AsyncMock(return_value=False),
        }
        for name, value in mocks.items():
            self.enterContext(patch.object(p, name, value))
        # Fail closed if any unmocked production I/O escapes these tests.
        self.enterContext(patch.object(p, "ClientSession", side_effect=AssertionError("network forbidden")))
        self.enterContext(patch.object(p.asyncio, "create_subprocess_exec", side_effect=AssertionError("process forbidden")))
        self.enterContext(patch.object(p.subprocess, "check_output", side_effect=AssertionError("process forbidden")))

    async def test_exact_routes_and_unknowns(self):
        p = self.p
        for mid in (p.GLM_FLASH_MODEL_ID, p.QWEN_NEXT_MODEL_ID, p.DS41_MODEL_ID):
            self.assertEqual(p.get_backend_name(mid), "ds4")
        for mid in ("typo", "", None, [], "qwen", p.DS4_FLASH_MODEL_ID, p.DS4_PRO_MODEL_ID):
            with self.assertRaises(p.web.HTTPBadRequest):
                p.get_backend_name(mid)
        self.assertEqual(p.ds4_static_model(p.QWEN_NEXT_MODEL_ID)["context_length"], 500000)
        self.assertEqual(p.ds4_static_model(p.GLM_FLASH_MODEL_ID)["context_length"], 500000)
        body = json.dumps({"model": p.QWEN_NEXT_MODEL_ID, "reasoning_effort": "xhigh"}).encode()
        self.assertEqual(p.maybe_prepare_chat_body("ds4", body), body)

    async def test_all_mlx_checkpoints_route_and_rewrite(self):
        p = self.p
        self.assertEqual(set(p.MLX_MODEL_PATHS), set(p.MLX_MODEL_METADATA))
        for mid in p.MLX_MODEL_IDS:
            self.assertEqual(p.get_backend_name(mid), "mlx")
            body = json.dumps({"model": mid, "messages": []}).encode()
            self.assertEqual(json.loads(p.maybe_prepare_chat_body("mlx", body))["model"],
                             p.mlx_model_path(mid))
        # Native context on every checkpoint; no YaRN scaling anywhere.
        self.assertEqual({c["context_length"] for c in p.MLX_MODEL_METADATA.values()}, {262144})
        # An unknown id must never fall through to the mlx backend.
        with self.assertRaises(p.web.HTTPBadRequest):
            p.mlx_model_path("qwen3.8-27b-uncensored-typo")
        with self.assertRaises(p.web.HTTPBadRequest):
            p.get_backend_name("qwen3.8-27b-uncensored-typo")

    async def test_mlx_switch_evicts_then_publishes_one_checkpoint(self):
        p = self.p
        self.loaded = None
        events, desired = [], []
        resident = {"id": "gemma-4-31b-mlx"}

        async def fake_resident():
            return resident["id"]

        async def fake_stop():
            events.append("stop")
            resident["id"] = None

        def fake_desired(path):
            events.append("desired")
            desired.append(path)

        async def fake_start():
            events.append("start")
            resident["id"] = next(m for m in p.MLX_MODEL_IDS
                                  if p.mlx_model_path(m) == desired[-1])

        with patch.object(p, "mlx_service_loaded", AsyncMock(return_value=True)), \
             patch.object(p, "mlx_resident_model", fake_resident), \
             patch.object(p, "stop_mlx", fake_stop), \
             patch.object(p, "start_mlx", fake_start), \
             patch.object(p, "_write_mlx_desired_sync", fake_desired):
            await p.ensure_mlx_model("qwen3.8-27b-uncensored")
            self.assertEqual(events, ["stop", "desired", "start"])
            self.assertEqual(resident["id"], "qwen3.8-27b-uncensored")
            # Already resident: a second request must not disturb the job.
            await p.ensure_mlx_model("qwen3.8-27b-uncensored")
            self.assertEqual(events, ["stop", "desired", "start"])

    async def test_mlx_switch_fails_loud_on_wrong_resident_checkpoint(self):
        p = self.p
        with patch.object(p, "mlx_resident_model", AsyncMock(return_value=None)), \
             patch.object(p, "stop_mlx", AsyncMock()), \
             patch.object(p, "start_mlx", AsyncMock()), \
             patch.object(p, "_write_mlx_desired_sync", lambda path: None):
            with self.assertRaises(p.web.HTTPServiceUnavailable):
                await p.ensure_mlx_model("qwen3.8-27b-uncensored")

    async def test_mlx_start_bootstraps_then_kickstarts(self):
        p = self.p
        calls = []
        polls = {"n": 0}

        async def launchctl(*args, timeout=15):
            calls.append(args[0])
            return 0, b""

        async def resident():
            polls["n"] += 1
            return "gemma-4-31b-mlx" if polls["n"] > 1 else None

        with patch.object(p, "_mlx_launchctl", launchctl), \
             patch.object(p, "mlx_resident_model", resident), \
             patch.object(p.asyncio, "sleep", AsyncMock()):
            await p.start_mlx()
        # RunAtLoad=false: registration alone must not be mistaken for a start.
        self.assertEqual(calls, ["bootstrap", "kickstart"])

    async def test_mlx_start_fails_loud_when_kickstart_is_refused(self):
        p = self.p

        async def launchctl(*args, timeout=15):
            return (0, b"") if args[0] == "bootstrap" else (1, b"Could not start job")

        with patch.object(p, "_mlx_launchctl", launchctl), \
             patch.object(p, "mlx_resident_model", AsyncMock(return_value=None)):
            with self.assertRaises(p.web.HTTPServiceUnavailable):
                await p.start_mlx()

    async def test_mlx_lifecycle_is_owned_by_the_proxy(self):
        p = self.p
        ensure = AsyncMock()
        with patch.object(p, "ensure_mlx_model", ensure):
            await p.prepare_non_ds4_backend("mlx", "gemma-4-31b-mlx")
        ensure.assert_awaited_with("gemma-4-31b-mlx")
        self.assertEqual(p.stop_mlx.await_count, 0)
        await p.prepare_non_ds4_backend("tunnel", p.DS4_FLASH_MODEL_ID)
        p.stop_mlx.assert_awaited()

    async def test_strict_serialization_and_switch_waits_for_entire_request(self):
        p = self.p
        await p.begin_request("ds4", p.GLM_FLASH_MODEL_ID)
        same = asyncio.create_task(p.begin_request("ds4", p.GLM_FLASH_MODEL_ID))
        pending = asyncio.create_task(p.begin_request("ds4", p.QWEN_NEXT_MODEL_ID))
        await asyncio.sleep(0)
        self.assertFalse(same.done())
        self.assertFalse(pending.done())
        self.assertEqual(p.ACTIVE_REQUESTS, 1)
        self.assertEqual(self.events, [])
        await p.finish_request("ds4")
        await asyncio.wait_for(same, 2)
        self.assertFalse(pending.done())
        self.assertEqual(p.ACTIVE_REQUESTS, 1)
        self.assertEqual(self.events, [])
        await p.finish_request("ds4")
        await asyncio.wait_for(pending, 2)
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

    async def test_qwen_deepseek_round_trip(self):
        p = self.p
        self.loaded = p.QWEN_NEXT_MODEL_ID
        for model, mode in ((p.DS41_MODEL_ID, "ds41"), (p.QWEN_NEXT_MODEL_ID, "qwen")):
            await p.begin_request("ds4", model)
            self.assertEqual(self.loaded, model)
            self.assertEqual(self.events[-3:], ["stop", "desired:" + mode, "start"])
            await p.finish_request("ds4")

    async def test_failed_qwen_never_forwards_or_restores(self):
        p = self.p
        self.fail_start = True
        request = type("Request", (), {"headers": {}, "transport": type("Transport", (), {"is_closing": lambda self: False})(), "read": AsyncMock(return_value=json.dumps({"model": p.QWEN_NEXT_MODEL_ID}).encode())})()
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

    async def test_same_model_checks_engine_idle_before_admission(self):
        p = self.p
        entered, release = asyncio.Event(), asyncio.Event()
        async def idle():
            entered.set()
            await release.wait()
        with patch.object(p, "wait_for_ds4_idle", idle):
            task = asyncio.create_task(p.begin_request("ds4", self.loaded))
            await asyncio.wait_for(entered.wait(), 2)
            self.assertEqual(p.ACTIVE_REQUESTS, 0)
            self.assertFalse(task.done())
            release.set()
            await asyncio.wait_for(task, 2)
        await p.finish_request("ds4")
        self.assertEqual(self.events, [])

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

    async def test_mlx_idle_unload_waits_for_quiescence(self):
        p = self.p
        self.loaded = None
        resident = {"id": "gemma-4-31b-mlx"}
        ticks = 0

        async def fake_resident():
            return resident["id"]

        async def fake_stop():
            # Real stop_mlx() owns this timer reset.
            resident["id"] = None
            p.MLX_LAST_REQUEST_AT = 0.0

        async def tick(_):
            nonlocal ticks
            ticks += 1
            if ticks > 1:
                raise asyncio.CancelledError

        p.MLX_LAST_REQUEST_AT = p.time.monotonic() - p.MLX_IDLE_TIMEOUT - 1
        with patch.object(p, "mlx_service_loaded", AsyncMock(return_value=True)), \
             patch.object(p, "mlx_resident_model", fake_resident), \
             patch.object(p, "stop_mlx", fake_stop), \
             patch.object(p.asyncio, "sleep", tick):
            with self.assertRaises(asyncio.CancelledError):
                await p.mlx_idle_check_loop()
        self.assertIsNone(resident["id"])
        self.assertEqual(p.MLX_LAST_REQUEST_AT, 0.0)

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


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_stop_waits_for_service_removal_and_process_exit(self):
        for registered, resident in ((True, False), (False, True)):
            with self.subTest(registered=registered, resident=resident):
                p = load_proxy()
                calls = []
                prints = 0

                async def launchctl(*args, **kwargs):
                    nonlocal prints
                    calls.append(args[1])
                    present = args[1] == "print" and registered and prints == 0
                    if args[1] == "print":
                        prints += 1
                    missing = args[1] == "print" and not present
                    return type("Process", (), {
                        "returncode": 113 if missing else 0,
                        "communicate": AsyncMock(return_value=(b"", b"Could not find service" if missing else b"")),
                    })()

                detector = AsyncMock(side_effect=[p.QWEN_NEXT_MODEL_ID, None] if resident else [None])
                with patch.object(p.asyncio, "create_subprocess_exec", launchctl), \
                     patch.object(p, "detect_ds4_loaded_model", detector), \
                     patch.object(p.asyncio, "sleep", AsyncMock()) as sleep:
                    await p.stop_dsv4()
                self.assertEqual(calls, ["bootout", "print", "print"])
                sleep.assert_awaited_once_with(0.25)
                self.assertIsNone(p.DS4_LOADED_MODEL_ID)

    async def test_shutdown_keeps_90_second_bound(self):
        p = load_proxy()
        proc = type("Process", (), {"returncode": 0, "communicate": AsyncMock(return_value=(b"", b""))})()
        timeout = asyncio.timeout
        with patch.object(p.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)), \
             patch.object(p.asyncio, "timeout", side_effect=lambda _: timeout(0.01)) as bound:
            with self.assertRaises(p.web.HTTPServiceUnavailable) as error:
                await p.stop_dsv4()
        bound.assert_called_once_with(90)
        self.assertIn("TimeoutError", error.exception.text)

    async def test_unreadable_service_state_prevents_replacement(self):
        p = load_proxy()
        ok = type("Process", (), {"returncode": 0, "communicate": AsyncMock(return_value=(b"", b""))})()
        denied = type("Process", (), {"returncode": 1, "communicate": AsyncMock(return_value=(b"", b"denied"))})()
        with patch.object(p.asyncio, "create_subprocess_exec", AsyncMock(side_effect=[ok, denied])), \
             patch.object(p, "detect_ds4_loaded_model", AsyncMock(return_value=None)):
            with self.assertRaises(p.web.HTTPServiceUnavailable) as error:
                await p.stop_dsv4()
        self.assertIn("shutdown failed; no replacement started", error.exception.text)
        self.assertIn("denied", error.exception.text)

    async def test_failed_start_does_not_wait_for_model_timeout(self):
        p = load_proxy()
        proc = type("Process", (), {"returncode": 1, "communicate": AsyncMock(return_value=(b"", b"not loaded"))})()
        with patch.object(p.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)), \
             patch.object(p.asyncio, "sleep", AsyncMock()):
            with self.assertRaises(p.web.HTTPServiceUnavailable):
                await p.start_dsv4()


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
        ds41 = "125 /Users/jack/dsv4-v41-engram/ds4-server -m /tmp/DeepSeek-V4.1-Flash-Q2.gguf --port 8001"
        for text, expected in ((prefix + "8001", p.QWEN_NEXT_MODEL_ID), (prefix + "8009", None),
                               (glm, p.GLM_FLASH_MODEL_ID), (ds41, p.DS41_MODEL_ID)):
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
                                else [other] if url == p.BACKENDS['tunnel']['admin'] + '/api/stats' else [])

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
    def test_mlx_wrapper_argv_without_model_load(self):
        source = Path.home() / ".mlx-lm/mlx-server.sh"
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / ".mlx-lm").mkdir()
            (home / ".local/bin").mkdir(parents=True)
            checkpoint = home / ".mlx-lm/models/Qwen3.8-27B-Uncensored-8bit"
            checkpoint.mkdir(parents=True)
            fake = home / ".local/bin/mlx_lm.server"
            fake.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            fake.chmod(0o755)
            template = source.read_text()
            real_executable = "/Users/jack/.local/bin/mlx_lm.server"
            self.assertIn(real_executable, template)
            wrapper = home / "mlx-server.sh"
            wrapper.write_text(template.replace(real_executable, str(fake)))
            source = wrapper
            env = {"HOME": str(home), "PATH": "/bin:/usr/bin"}
            desired = home / ".mlx-lm/desired-model"
            desired.write_text(str(checkpoint) + "\n")
            result = subprocess.run(["/bin/sh", str(source)], capture_output=True,
                                    text=True, check=True, env=env)
            args = result.stdout.splitlines()
            self.assertEqual(args[args.index("--model") + 1], str(checkpoint))
            self.assertEqual(args[args.index("--port") + 1], "8000")
            # Memory-only posture: the wrapper adds no cache or vision flags.
            for flag in ("--kv-disk-dir", "--paged-ssd-cache-dir", "--vision", "--kv-bits"):
                self.assertNotIn(flag, args)
            for bad in ("", "typo", str(home / ".mlx-lm/models/Missing")):
                desired.write_text(bad + "\n")
                refused = subprocess.run(["/bin/sh", str(source)], capture_output=True,
                                         text=True, env=env)
                with self.subTest(desired=bad):
                    self.assertNotEqual(refused.returncode, 0)
                    self.assertEqual(refused.stdout, "")
            desired.unlink()
            refused = subprocess.run(["/bin/sh", str(source)], capture_output=True,
                                     text=True, env=env)
            self.assertNotEqual(refused.returncode, 0)

    def test_wrapper_argv_without_exec_or_model_load(self):
        source = Path('/Users/jack/.dsv4/dsv4-server-wrapper.sh').read_text()
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / '.dsv4').mkdir()
            script = 'mock_exec() { printf "%s\\n" "$@"; exit 0; }\n' + source.replace('HOME_DIR="/Users/jack"', f'HOME_DIR="{home}"').replace('exec "', 'mock_exec "')
            for mode, model, ctx in [('qwen', 'qwen3.8-flash-next', '500000'), ('ds41', 'deepseek-v4.1-flash', '1000000')]:
                (home / '.dsv4/desired-model').write_text(mode)
                result = subprocess.run(['/bin/sh', '-c', script], capture_output=True, text=True, check=True)
                args = result.stdout.splitlines()
                self.assertEqual(args[args.index('--ctx') + 1], ctx)
                self.assertEqual((home / '.dsv4/active-model.intent').read_text().strip(), model)
                self.assertNotIn('--kv-disk-dir', args)
                self.assertNotIn('--vision', args)
                if mode == 'qwen':
                    self.assertNotIn('--ssd-streaming', args)
                    self.assertEqual(args[0], str(home / 'ds4/ds4-server'))
                    self.assertIn('export DS4_QWEN4_YARN_FACTOR=2', source)
                    self.assertIn(str(home / 'projects/ds4/gguf/Qwen3.8-Flash-Next-Q4.gguf'), args)
                    # V4.1 steering is model-bound; Qwen must never receive DS41DIR flags.
                    self.assertNotIn('--dir-steering-file', args)
                    self.assertNotIn('--dir-steering-strength', args)
                else:
                    # Production executes from the canonical ~/ds4 checkout, and shaders
                    # load relative to cwd, so chdir must name the same tree.
                    self.assertEqual(args[0], str(home / 'ds4/ds4-server-v41-reservation'))
                    self.assertEqual(args[args.index('--chdir') + 1], str(home / 'ds4'))
                    self.assertIn(str(home / 'dsv4-qwen38-integration/gguf/DeepSeek-V4.1-Flash-Q2.gguf'), args)
                    self.assertIn('--ssd-streaming', args)
                    self.assertEqual(args[args.index('--ssd-streaming-cache-experts') + 1], '64GB')
                    self.assertIn('--dir-steering-file', args)
                    self.assertEqual(args[args.index('--dir-steering-strength') + 1], '1')
            (home / '.dsv4/desired-model').write_text('typo')
            result = subprocess.run(['/bin/sh', '-c', script], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')


if __name__ == "__main__":
    unittest.main()
