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

HOME = Path('/Users/jack')
SERVICE = 'gui/501/com.dsv4.server'
ROOT = HOME/'research/bend'
MODELS = {
 'qwen3.8-flash-next': dict(mode='qwen', binary=HOME/'ds4/ds4-server',
   sha='23f9e6d99db3120cc24a32839ea57e6680fbae3de142b424a2780e8aa0494e32',
   args=['Qwen3.8-Flash-Next-Q4.gguf','--mtp','--ctx 500000']),
 'deepseek-v4.1-flash': dict(mode='ds41', binary=HOME/'ds4/ds4-server-v41-reservation',
   sha='a3897ee4f2a85f51a2b499ede9e4bbd13886ee0b5f9b1d52cd5ed04e5c7d512a',
   args=['DeepSeek-V4.1-Flash-Q2.gguf','--metal','--ssd-streaming','--power 100',
         '--ssd-streaming-cache-experts 64GB','--ctx 1000000',
         '--dir-steering-file /Users/jack/.dsv4/adapters/dealignai-writer-proxy.ds41dir',
         '--dir-steering-strength 1']),
}


def command(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True).stdout.strip()


def ctl(*args):
    return command('/bin/launchctl','asuser','501','/bin/launchctl',*args)


def service_pid():
    text=command('/bin/launchctl','print',SERVICE,check=False)
    match=re.search(r'^\s*pid = (\d+)',text,re.M)
    return int(match[1]) if match else None


def record(event, **data):
    row=dict(time=time.time(),event=event,**data)
    with (ROOT/'enablement-log.md').open('a') as out:
        out.write('\nDual-model supervised lifecycle: '+json.dumps(row)+'\n')
        out.flush(); os.fsync(out.fileno())


class ManagedSwitch:
    def __init__(self, inherited_lease=None):
        self.inherited_lease=inherited_lease # controller-owned only in isolated tests
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
        if not p: raise RuntimeError('startup engine missing; supervised recovery required')
        argv=command('/bin/ps','-p',str(p),'-o','command=')
        model=next((m for m,c in MODELS.items() if c['args'][0] in argv),None)
        if model is None: raise RuntimeError('unknown resident model')
        self.engine=self.binding(model)
        self.model=model

    async def start(self,model):
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
               policy='close/status -> SIGTERM -> exit -> fresh gate/settings -> start -> native verify/release')
        receipt=await self.engine.terminal()
        record('switch-old-drained',model=self.model,receipt=receipt)
        command('/bin/launchctl','kill','SIGTERM',SERVICE)
        while self.engine.alive(): await asyncio.sleep(.1) # never SIGKILL
        await self.start(model)
        record('switch-complete',model=model,seconds=time.monotonic()-before)

    async def prepare(self,model):
        if model not in MODELS or self.blocked: raise RuntimeError('managed model unavailable')
        await self.acquire()
        async def settle():
            if self.engine is None: self.adopt()
            if self.model!=model: await self.transition(model)
            self.engine=self.binding(model) # fresh request log offset; shared process ticket map
            return self.engine
        task=asyncio.create_task(settle())
        cancelled=False
        while not task.done():
            try: await asyncio.shield(task)
            except asyncio.CancelledError: cancelled=True
            except Exception: break
        try: engine=task.result()
        except BaseException as exc:
            self.blocked=repr(exc)
            record('switch-blocked',reason=self.blocked)
            raise
        if cancelled:
            self.release()
            raise asyncio.CancelledError()
        return engine
