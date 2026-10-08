"""Qualified DS4 model reloads. Called only inside the proxy admission condition.
A request owns the shared flock until its native terminal release. Unknown state
retains both barriers. Launchd keeps its existing wrapper/model settings.
"""
import asyncio
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

from aiohttp import ClientSession, ClientTimeout
import reservation_body as rb
import swap_policy

HOME = Path('/Users/jack')
SERVICE = 'gui/501/com.dsv4.server'
ROOT = HOME/'research/bend'
MODELS = {
 'qwen3.8-flash-next': dict(mode='qwen', binary=HOME/'ds4/ds4-server',
   sha='23f9e6d99db3120cc24a32839ea57e6680fbae3de142b424a2780e8aa0494e32',
   args=['Qwen3.8-Flash-Next-Q4.gguf','--mtp','--ctx 750000']),
 'deepseek-v4.1-flash': dict(mode='ds41', binary=HOME/'ds4/ds4-server-v41-reservation',
   sha='a3897ee4f2a85f51a2b499ede9e4bbd13886ee0b5f9b1d52cd5ed04e5c7d512a',
   args=['DeepSeek-V4.1-Flash-Q2.gguf','--metal','--ssd-streaming','--power 100',
         '--ssd-streaming-cache-experts 64GB','--ctx 1000000',
         '--dir-steering-file /Users/jack/.dsv4/adapters/dealignai-writer-proxy.ds41dir',
         '--dir-steering-strength 1']),
}


def command(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True).stdout.strip()


class LaneUnproven(RuntimeError):
    """A refused-before-effect transition: retryable, never blocks the manager."""


def ctl(*args):
    return command('/bin/launchctl','asuser','501','/bin/launchctl',*args)


def service_pid():
    text=command('/bin/launchctl','print',SERVICE,check=False)
    match=re.search(r'^\s*pid = (\d+)',text,re.M)
    return int(match[1]) if match else None


def mlx_lane_busy():
    """Managed DS4 swaps never stop the mlx lane. A loaded job or an occupied
    proxy-owned mlx port is a proven/unproven MLX engine, so a DS4 transition
    must fail closed rather than overlap it. Listening is not quiescence proof.
    """
    text=command('/bin/launchctl','print',f'gui/{os.getuid()}/com.mlx-lm.server',check=False)
    if re.search(r'^\s*pid = \d+\b', text, re.M): return True
    return swap_policy.port_listening(8000)


def record(event, **data):
    row=dict(time=time.time(),event=event,**data)
    with (ROOT/'enablement-log.md').open('a') as out:
        out.write('\nDual-model supervised lifecycle: '+json.dumps(row)+'\n')
        out.flush(); os.fsync(out.fileno())


class ManagedSwitch:
    def __init__(self, inherited_lease=None, winnow=None):
        self.inherited_lease=inherited_lease # controller-owned only in isolated tests
        self.winnow=winnow
        self.lease=None
        self.model=self.engine=None
        self.blocked=None

    async def acquire(self):
        if self.lease is not None: raise RuntimeError('second lease owner')
        if self.inherited_lease is not None:
            self.lease=self.inherited_lease
            return
        lease=open('/tmp/gpu-lease.lock','a+')
        try:
            while True:
                try:
                    fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
                    self.lease=lease
                    return
                except BlockingIOError: await asyncio.sleep(.1)
        except BaseException:
            lease.close(); raise

    def release(self):
        if self.lease is None: return
        if self.blocked: raise RuntimeError('unknown owner cannot release GPU lease')
        if self.lease is not self.inherited_lease: self.lease.close()
        self.lease=None

    def binding(self, model):
        config=MODELS[model]
        p=service_pid()
        if not p: raise RuntimeError('managed engine absent')
        argv=command('/bin/ps','-p',str(p),'-o','command=')
        if not all(arg in argv for arg in config['args']):
            raise RuntimeError('unqualified model settings')
        e=rb.FileEngine('ds4',ctl('getenv','DS4_FREEZE_DIR'),p,HOME/'.dsv4/dsv4.log',
                        config['binary'],expected_sha=config['sha'])
        e.core=ROOT/'coordinator/liveness-evidence-20260925/coordinator-cpu'
        return e

    def adopt(self):
        p=service_pid()
        if not p:
            swap_policy.SWAP.adopt_empty()
            raise RuntimeError('startup engine missing; supervised recovery required')
        argv=command('/bin/ps','-p',str(p),'-o','command=')
        model=next((m for m,c in MODELS.items() if c['args'][0] in argv),None)
        if model is None:
            swap_policy.SWAP.adopt_unknown()
            raise RuntimeError('unknown resident model')
        try:
            self.engine=self.binding(model)
        except BaseException:
            swap_policy.SWAP.adopt_unknown()
            raise
        self.model=model
        swap_policy.SWAP.adopt(model)

    async def start(self,model):
        if subprocess.run(['/bin/launchctl','print',SERVICE],capture_output=True).returncode != 0:
            ctl('bootstrap','gui/501',str(HOME/'Library/LaunchAgents/com.dsv4.server.plist'))
        control=Path(tempfile.mkdtemp(prefix='reservation-dual-',dir=HOME/'.dsv4'))
        ctl('setenv','DS4_FREEZE_DIR',str(control))
        (HOME/'.dsv4/desired-model').write_text(MODELS[model]['mode']+'\n')
        command('/bin/launchctl','kickstart',SERVICE)
        deadline=time.monotonic()+900
        async with ClientSession(timeout=ClientTimeout(total=2)) as session:
            while time.monotonic()<deadline:
                try:
                    async with session.get('http://127.0.0.1:8001/v1/models') as r:
                        if r.status==200 and (control/'terminal-engine').exists(): break
                except Exception: pass
                await asyncio.sleep(.2)
            else: raise RuntimeError('new engine readiness timeout')
        self.engine=self.binding(model)
        receipt=await self.engine.terminal()
        await self.engine.release_terminal()
        self.model=model
        # Bindings for diagnostics/future explicitly supervised proxy restart.
        for k,v in dict(LOCAL_PROXY_DS4_GATE=str(control),LOCAL_PROXY_DS4_PID=str(self.engine.pid),
                        LOCAL_PROXY_DS4_BINARY=str(MODELS[model]['binary'])).items(): ctl('setenv',k,v)
        record('switch-ready',model=model,pid=self.engine.pid,gate=str(control),receipt=receipt)

    async def transition(self,model):
        if self.engine.hold is not None or self.engine.terminal_ticket is not None:
            raise RuntimeError('held or terminal owner cannot switch')
        before=time.monotonic()
        record('switch-plan',old=self.model,new=model,pid=self.engine.pid,
               policy='checked stop-then-start: close/status -> SIGTERM -> exit -> fresh gate/settings -> start -> native verify/release')
        try:
            receipt=await self.engine.terminal()
        except BaseException:
            try: swap_policy.SWAP.stop_unknown()
            except swap_policy.SwapPolicyError as exc: record('switch-policy-blocked',reason=str(exc))
            raise
        record('switch-old-drained',model=self.model,receipt=receipt)
        try:
            command('/bin/launchctl','kill','SIGTERM',SERVICE)
            while self.engine.alive(): await asyncio.sleep(.1) # never SIGKILL
        except BaseException:
            try: swap_policy.SWAP.stop_unknown()
            except swap_policy.SwapPolicyError as exc: record('switch-policy-blocked',reason=str(exc))
            raise
        swap_policy.SWAP.stop_done()
        try:
            await self.start(model)
        except BaseException:
            try: swap_policy.SWAP.start_unknown()
            except swap_policy.SwapPolicyError as exc: record('switch-policy-blocked',reason=str(exc))
            raise
        swap_policy.SWAP.start_ready()
        record('switch-complete',model=model,seconds=time.monotonic()-before)

    async def observe_with_winnow(self):
        # A process/port mismatch is uncertainty, never an empty lane.
        resident = await asyncio.to_thread(self.winnow.probe)
        ds4_pid = service_pid()
        if (resident and ds4_pid) or (not ds4_pid and await asyncio.to_thread(swap_policy.port_listening, 8001)):
            swap_policy.SWAP.adopt_unknown()
            raise LaneUnproven('conflicting or foreign DS4/Winnow process')
        if resident:
            if not await self.winnow.ready(resident):
                swap_policy.SWAP.adopt_unknown()
                raise LaneUnproven('Winnow process exists but is not ready')
            self.model, self.engine = 'winnow-12b', None
            swap_policy.SWAP.adopt(self.model)
        elif ds4_pid:
            self.adopt()  # pinned DS4 binary, native control identity and argv
        else:
            self.model = self.engine = None
            swap_policy.SWAP.adopt_empty()

    async def stop_ds4_for_winnow(self):
        if not self.engine or self.engine.hold is not None or self.engine.terminal_ticket is not None:
            raise RuntimeError('DS4 native owner not safely stoppable')
        await self.engine.terminal()  # fresh native drain, not HTTP idle telemetry
        ctl('bootout', SERVICE)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            gone = subprocess.run(['/bin/launchctl', 'print', SERVICE], capture_output=True).returncode != 0
            if gone and not self.engine.alive() and not swap_policy.port_listening(8001):
                self.engine = None
                return
            await asyncio.sleep(.25)
        raise RuntimeError('DS4 exit/port/service not proven after bootout')

    async def prepare_with_winnow(self, model):
        if model not in (*MODELS, 'winnow-12b') or self.blocked:
            raise RuntimeError('managed model unavailable')
        await self.acquire()
        async def settle():
            await self.observe_with_winnow()
            if model == 'winnow-12b':
                try:
                    await asyncio.to_thread(self.winnow.qualify)
                except Exception as exc:
                    raise LaneUnproven(f'Winnow artifact qualification failed before switch: {exc}') from exc
            action, resident = swap_policy.SWAP.admit(model, qualified=True)
            if action == 'reuse':
                if model == 'winnow-12b' and await asyncio.to_thread(mlx_lane_busy):
                    raise LaneUnproven('mlx lane busy or unproven; Winnow admission refused')
                return self.winnow if model == 'winnow-12b' else self.binding(model)
            if action not in ('stop', 'start'):
                raise LaneUnproven(f'swap policy refused {model}: {action}')
            if await asyncio.to_thread(mlx_lane_busy):
                if action == 'stop': swap_policy.SWAP.abort()
                raise LaneUnproven('mlx lane busy or unproven; no transition issued')
            if action == 'stop':
                try:
                    if resident == 'winnow-12b':
                        await self.winnow.stop()  # process exit proves native work gone
                    elif resident in MODELS:
                        await self.stop_ds4_for_winnow()
                    else:
                        swap_policy.SWAP.abort()
                        raise LaneUnproven(f'unmanaged resident {resident}')
                except LaneUnproven:
                    raise
                except BaseException:
                    swap_policy.SWAP.stop_unknown()
                    raise
                swap_policy.SWAP.stop_done()
            try:
                if model == 'winnow-12b':
                    await self.winnow.start()
                    self.engine = None
                    self.model = model
                else:
                    await self.start(model)  # fresh DS4 gate, binary, PID and native receipt
            except BaseException:
                swap_policy.SWAP.start_unknown()
                raise
            swap_policy.SWAP.start_ready()
            return self.winnow if model == 'winnow-12b' else self.engine
        task = asyncio.create_task(settle())
        cancelled = False
        while not task.done():
            try: await asyncio.shield(task)
            except asyncio.CancelledError: cancelled = True
            except Exception: break
        try: engine = task.result()
        except LaneUnproven:
            self.release()
            raise
        except BaseException as exc:
            self.blocked = repr(exc)
            record('switch-blocked', reason=self.blocked)
            raise
        if cancelled:
            self.release()
            raise asyncio.CancelledError()
        return engine

    async def prepare_winnow(self):
        return await self.prepare_with_winnow('winnow-12b')

    async def prepare(self,model):
        if self.winnow is not None:
            return await self.prepare_with_winnow(model)
        if model not in MODELS or self.blocked: raise RuntimeError('managed model unavailable')
        await self.acquire()
        async def settle():
            if self.engine is None: self.adopt()
            action,resident=swap_policy.SWAP.admit(model,qualified=model in MODELS)
            if action=='reuse':
                pass  # checked policy: identity match, no transition
            elif action=='stop':
                if await asyncio.to_thread(mlx_lane_busy):
                    swap_policy.SWAP.abort()  # authorized stop, never issued
                    raise LaneUnproven('mlx lane busy or unproven; no DS4 transition issued')
                await self.transition(model)
            else:
                raise RuntimeError(f'swap policy {action} for {model}; no transition issued')
            self.engine=self.binding(model) # fresh request log offset; shared process ticket map
            return self.engine
        task=asyncio.create_task(settle())
        cancelled=False
        while not task.done():
            try: await asyncio.shield(task)
            except asyncio.CancelledError: cancelled=True
            except Exception: break
        try: engine=task.result()
        except LaneUnproven as exc:
            self.release()
            record('switch-lane-unproven',reason=repr(exc))
            raise
        except BaseException as exc:
            self.blocked=repr(exc)
            record('switch-blocked',reason=self.blocked)
            raise
        if cancelled:
            self.release()
            raise asyncio.CancelledError()
        return engine
