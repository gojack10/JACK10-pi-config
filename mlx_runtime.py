"""Proxy-owned serial MLX worker. Warm cache; fresh stream-sync before swaps."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import signal
import subprocess
import tempfile
import time

from aiohttp import ClientSession, ClientTimeout
from native_files import private_file, publish
import swap_policy

HOME = Path.home()
ROOT = Path(__file__).resolve().parent
PYTHON = HOME / '.local/share/uv/tools/mlx-lm/bin/python'
PORT = 8000
MODELS = {
    'qwen3.8-27b-uncensored': HOME / '.mlx-lm/models/Qwen3.8-27B-Uncensored-8bit',
    'gemma-4-31b-mlx': HOME / '.mlx-lm/models/mlx-community/gemma-4-31b-it-8bit',
}


class MLXRuntime:
    def __init__(self):
        self.process = self.identity = self.model = self.control = None
        self.serial = 0
        self.ticket = None
        self.headers = None
        self.verified = {}

    def qualify(self):
        pin = json.loads((ROOT / 'mlx-service/pin.json').read_text())
        for relative, expected in pin.items():
            path = PYTHON.parent.parent / relative
            stat = path.stat()
            identity = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
            if self.verified.get(relative) != identity:
                with path.open('rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                        raise RuntimeError('MLX runtime changed; qualification required: ' + relative)
                self.verified[relative] = identity

    def processes(self):
        rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,command='], text=True).splitlines()
        found = []
        for row in rows:
            parts = row.split(None, 1)
            if len(parts) != 2:
                continue
            try:
                args = shlex.split(parts[1])
            except ValueError:
                continue
            if args and (str(ROOT / 'mlx_serial.py') in args or 'mlx_lm.server' in args or
                         Path(args[0]).name == 'mlx_lm.server' or
                         ('--port' in args and args[args.index('--port') + 1:][:1] == [str(PORT)])):
                found.append(int(parts[0]))
        return found

    def alive(self):
        return self.identity is not None and subprocess.run(
            ['/bin/ps', '-p', str(self.identity[0]), '-o', 'lstart='],
            capture_output=True, text=True).stdout.strip() == self.identity[1]

    def probe(self):
        pids = self.processes()
        if self.identity is None:
            if pids or swap_policy.port_listening(PORT):
                raise RuntimeError('Retained or foreign MLX worker; maintenance recovery required')
            return None
        if pids != [self.identity[0]] or not self.alive():
            raise RuntimeError('MLX worker identity lost or replaced')
        return self.identity

    async def ready(self):
        path = self.control / 'terminal-engine'
        if not path.exists():
            return False
        engine = json.loads(private_file(path).read_text())
        if engine.get('pid') != self.identity[0] or not engine.get('engine'):
            raise RuntimeError('MLX native worker identity mismatch')
        async with ClientSession(timeout=ClientTimeout(total=3)) as session:
            async with session.get(f'http://127.0.0.1:{PORT}/v1/models') as response:
                models = (await response.json())['data']
                return response.status == 200 and str(MODELS[self.model].resolve()) in {m['id'] for m in models}

    async def start(self, model):
        await asyncio.to_thread(self.qualify)
        if self.probe() is not None:
            raise RuntimeError('MLX worker already loaded')
        self.control = Path(tempfile.mkdtemp(prefix='mlx-serial-', dir=HOME / '.dsv4'))
        publish(self.control, 'key', secrets.token_hex(32))
        key = private_file(self.control / 'key').read_text()
        self.headers = {'Authorization': 'Bearer ' + key}
        env = dict(os.environ, MLX_CONTROL_DIR=str(self.control), MLX_KEY_FILE=str(self.control / 'key'),
                   HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
        with (HOME / '.mlx-lm/mlx-lm.log').open('ab') as log:
            self.process = await asyncio.create_subprocess_exec(str(PYTHON), str(ROOT / 'mlx_serial.py'),
                '--model', str(MODELS[model].resolve()), '--host', '127.0.0.1', '--port', str(PORT),
                env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        self.identity = (self.process.pid, subprocess.check_output(
            ['/bin/ps', '-p', str(self.process.pid), '-o', 'lstart='], text=True).strip())
        self.model, self.serial, self.ticket = model, 0, None
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            if not self.alive():
                raise RuntimeError('MLX worker exited during load')
            try:
                if await self.ready():
                    return self
            except (OSError, asyncio.TimeoutError):
                pass
            await asyncio.sleep(.2)
        raise RuntimeError('MLX worker readiness unknown')

    async def command(self, action, ticket):
        self.probe()
        identity = json.loads(private_file(self.control / 'terminal-engine').read_text())
        self.serial += 1
        command = dict(**identity, serial=self.serial, ticket=ticket, action=action)
        publish(self.control, 'terminal', json.dumps(command))
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if not self.alive():
                raise RuntimeError('MLX exited before native completion acknowledgement')
            path = self.control / 'terminal-ack'
            if path.exists():
                ack = json.loads(private_file(path).read_text())
                if all(ack.get(k) == v for k, v in command.items()):
                    return ack
            await asyncio.sleep(.02)
        raise RuntimeError('MLX native completion unknown; admission retained')

    async def terminal(self):
        if self.ticket is not None:
            raise RuntimeError('MLX native gate already held')
        ticket = self.serial + 1
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            first = await self.command('close', ticket)
            if first.get('ok') is True:
                self.ticket = ticket
                fresh = await self.command('status', ticket)
                if all(fresh.get(k) is True for k in ('ok', 'admission_closed', 'synchronized')):
                    return fresh
                break
            if first.get('admission_closed') is not False:
                break
            await asyncio.sleep(.05)
        raise RuntimeError('MLX worker did not prove native completion')

    async def release_terminal(self):
        if self.ticket is None:
            raise RuntimeError('No MLX terminal hold')
        ack = await self.command('release', self.ticket)
        if ack.get('ok') is not True or ack.get('admission_closed') is not False:
            raise RuntimeError('MLX terminal release unknown')
        self.ticket = None

    async def stop(self):
        self.probe()
        if self.ticket is None:
            await self.terminal()
        os.kill(self.identity[0], signal.SIGTERM)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if not self.alive():
                await self.process.wait()
                if self.processes() or swap_policy.port_listening(PORT):
                    raise RuntimeError('MLX exit incomplete or foreign listener')
                self.identity = self.process = self.model = self.ticket = None
                return
            await asyncio.sleep(.1)
        raise RuntimeError('MLX did not exit after SIGTERM; no forced kill')
