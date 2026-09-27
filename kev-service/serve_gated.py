"""Private cp313 Kev/TypeSafe HTTP service with in-process, never-reopened MLX stop.

Run only under the shared GPU lease. The upstream FastAPI app owns the public API;
private routes carry the qualified independent control/observer protocol.
"""
import argparse
import asyncio
import hashlib
import os
import queue
import socket
import threading
import time
from pathlib import Path

from fastapi import Header, HTTPException
import mlx.core as mx
import uvicorn
from kev import serve as upstream
from kev.checkpoint import Checkpoint, LoadOptions
from kev.device import default_device
from kev.api import SystemOneRequest, to_record
from kev.model import SERVE_MAX_STATE, SERVE_MAX_BRANCH
from gate_bridge import LiveGate, StopRequested, receive, send

assert os.environ.get('HF_HUB_OFFLINE') == '1' and os.environ.get('KEV_TRIAL_LEASE') == '1'
assert os.environ.get('MLX_NATIVE_GATE') == '1' and os.environ.get('KEV_CONTROL_KEY')
source_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
assert source_sha256 == os.environ['KEV_SOURCE_SHA256'], 'Kev served source differs from proxy pin'
RUN = 'jaredpalmer/kev-4b@485ace8703592fcf405488b262449990824cfed1'
BASE = '1001bb4d826a52d1f399e183466143f4da7b741b'
TICKET = 418
mx.set_memory_limit(16 * 1024**3)
mx.set_cache_limit(256 * 1024**2)
obs, observer = socket.socketpair()
ctrl, controller = socket.socketpair()
for s in (obs, ctrl):
    s.settimeout(10)
gate = LiveGate(mx, 'private-kev-http', TICKET, observer, controller)
hello = receive(obs.makefile('rb'))
hello['source_sha256'] = source_sha256
assert receive(ctrl.makefile('rb'))['incarnation'] == hello['incarnation']
channel_locks = (threading.Lock(), threading.Lock())
http_server = None


def command(index, row):
    s = (obs, ctrl)[index]
    with channel_locks[index]:
        reader = s.makefile('rb')
        try:
            send(s, row)
            return receive(reader)
        finally:
            reader.close()


def authenticate(x_kev_control_key):
    import hmac
    if not hmac.compare_digest(x_kev_control_key or '', os.environ['KEV_CONTROL_KEY']):
        raise HTTPException(403, 'private control key required')


@upstream.app.get('/_kev/identity')
def identity(x_kev_control_key: str | None = Header(default=None)):
    authenticate(x_kev_control_key)
    return hello


@upstream.app.get('/_kev/memory')
def memory(x_kev_control_key: str | None = Header(default=None)):
    authenticate(x_kev_control_key)
    return {'pid': os.getpid(), 'mlx_active_bytes': mx.get_active_memory(),
            'mlx_cache_bytes': mx.get_cache_memory(), 'mlx_peak_bytes': mx.get_peak_memory()}


@upstream.app.post('/_kev/encode')
def encode_diagnostic(req: SystemOneRequest, x_kev_control_key: str | None = Header(default=None)):
    authenticate(x_kev_control_key)
    s = upstream.app.state.server
    rec, meta = to_record(upstream.prepare(req))
    try:
        enc = s.model.encode(s.tok, rec, max_state=SERVE_MAX_STATE, max_branch=SERVE_MAX_BRANCH)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {'tokens': len(enc['ids']), 'state_tokens': enc['seg'].count(0),
            'state_truncated': enc['state_truncated'], 'questions': [m['id'] for m in meta]}


@upstream.app.post('/_kev/sample')
async def sample(row: dict, x_kev_control_key: str | None = Header(default=None)):
    authenticate(x_kev_control_key)
    return await asyncio.to_thread(command, 0, row)


@upstream.app.post('/_kev/stop')
async def stop(row: dict, x_kev_control_key: str | None = Header(default=None)):
    authenticate(x_kev_control_key)
    return await asyncio.to_thread(command, 1, row)


@upstream.app.post('/_kev/exit')
async def exit_held(row: dict, x_kev_control_key: str | None = Header(default=None)):
    authenticate(x_kev_control_key)
    answer = await asyncio.to_thread(command, 1, row)
    if answer['ok']:
        http_server.should_exit = True
    return answer


@upstream.app.post('/_kev/test-error')
async def test_error(x_kev_control_key: str | None = Header(default=None)):
    authenticate(x_kev_control_key)
    if os.environ.get('KEV_TEST_FAILURE') != '1':
        raise HTTPException(404)
    def error():
        x = mx.ones((64, 64), mx.float32)
        mx.eval(x @ x)  # accounted successful Metal work before poisoning this process
        kernel = mx.fast.metal_kernel(name='kev_http_bad_shader', input_names=[],
            output_names=['out'], source='out[0] = deliberately_undefined_symbol;')
        bad = kernel(inputs=[], output_shapes=[(1,)], output_dtypes=[mx.float32],
                     grid=(1, 1, 1), threadgroup=(1, 1, 1))
        try:
            mx.async_eval(bad)
        except RuntimeError as exc:
            gate.finish('failed')  # cannot publish clean after a native error
            if mx.metal.native_gate_status()['closed'] != 1:
                try: mx.metal.native_gate_close(5.0)
                except RuntimeError: pass  # failed/unclean, never an eligible receipt
            return {'compile_error': str(exc), 'phase': gate.phase, 'error': gate.error}
        raise RuntimeError('bad shader unexpectedly compiled')
    return await asyncio.to_thread(error)


class GatedServer(upstream.Server):
    def submit(self, rec):
        with gate.mu:  # enqueue and stop acceptance share one admission boundary
            if gate.stop_requested.is_set():
                raise HTTPException(503, 'Kev gate stopped; restart this process for more work')
            return super().submit(rec)

    def _run(self, encs):
        # Upstream calls torch.mps.synchronize even on its MLX backend. Keep
        # this private serving scope entirely inside the qualified MLX gate.
        keys, cached, keep = self.prefix_cache.plan(encs)
        mx.synchronize()
        t = time.perf_counter()
        ps, prefixes = self.model.probs_batch(encs, cached, keep)
        mx.synchronize()
        dt = round((time.perf_counter() - t) * 1000, 1)
        self.prefix_cache.store(keys, cached, prefixes)
        self.batches += 1; self.batched_requests += len(encs)
        return [([q.tolist() for q in p], {'tokens': len(enc['ids']), 'state_tokens': enc['seg'].count(0),
                'latency_ms': dt, 'prefix_cache_hit': c is not None})
                for enc, p, c in zip(encs, ps, cached)]

    def _work(self):
        # Same upstream queue/batch lifecycle, with the stop/drain on this model
        # thread, including the idle case. Never close a native gate on an HTTP thread.
        while not self.stopping.is_set():
            if gate.stop_requested.is_set() and gate.phase not in ('held', 'stop-unknown'):
                while True:
                    try: _, done = self.queue.get_nowait()
                    except queue.Empty: break
                    done.set_exception(HTTPException(503, 'Kev stopped before scoring'))
                    self.queue.task_done()
                gate.finish('cancelled-at-region-boundary')
            try:
                batch = [self.queue.get(timeout=0.05)]
            except queue.Empty:
                continue
            while len(batch) < upstream.MAX_BATCH:
                try: batch.append(self.queue.get_nowait())
                except queue.Empty: break
            try:
                with self.lock:
                    results = self._run([enc for enc, _ in batch])
            except StopRequested:
                results = [HTTPException(503, 'Kev stopped during scoring')] * len(batch)
            except Exception as exc:
                gate.stop_requested.set()  # a failed scorer never admits another GPU region
                results = [exc] * len(batch)
            for (_, done), result in zip(batch, results):
                (done.set_exception if isinstance(result, Exception) else done.set_result)(result)
                self.queue.task_done()


def main():
    global http_server
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=18748)
    ap.add_argument('--negative', action='store_true')
    args = ap.parse_args()
    if not args.negative:
        assert default_device() == 'mps'
        def load():
            ck = Checkpoint(RUN)
            assert ck.meta.base == 'Qwen/Qwen3.5-4B-Base' and ck.meta.base_revision == BASE
            opts = LoadOptions(backend='auto')  # upstream serve.main default; reject fallback below
            tok, model = ck.load('mps', opts)
            assert ck.backend('mps', opts) == model.backend == 'mlx'
            return ck, tok, model
        try:
            ck, tok, model = gate.region_call('load', load)
        except BaseException:
            gate.finish('startup-failed')
            gate.exit_requested.set()
            gate.wait_held()  # no signal or orphaned control threads on load failure
            raise
        original_batch = model.probs_batch
        def gated_batch(encs, prefixes, keep):
            ps, retained = [], []
            for enc, cached, retain in zip(encs, prefixes, keep):
                prefix = cached if cached is not None else gate.region_call('score-prefix', lambda: model.prefix(enc))
                probs = gate.region_call('score-branches', lambda: model.probs_with_prefix(enc, prefix))
                ps.append(probs)
                retained.append(prefix if retain else None)
            return ps, retained
        model.probs_batch = gated_batch
        upstream.app.state.server = GatedServer(ck, tok, model, 'mps')
        print(f'LOADED pid={os.getpid()} backend={model.backend} dtype={model.dtype} core={mx.__file__} original_batch={original_batch.__qualname__}', flush=True)
    else:
        print(f'NEGATIVE pid={os.getpid()} core={mx.__file__}', flush=True)
    http_server = uvicorn.Server(uvicorn.Config(upstream.app, host='127.0.0.1', port=args.port, log_level='info'))
    try:
        http_server.run()
    finally:
        if not args.negative:
            upstream.app.state.server.close()
        if gate.phase not in ('held', 'stop-unknown'):
            gate.finish('server-exit')
        # /_kev/exit is normal; an unexpected graceful shutdown also joins
        # both control threads, but is never interpreted as a stop receipt.
        gate.exit_requested.set()
        gate.wait_held()
        print(f'FINAL pid={os.getpid()} phase={gate.phase} proof={gate.proof} error={gate.error}', flush=True)


if __name__ == '__main__':
    main()
