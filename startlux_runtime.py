"""Pinned proxy-owned StartLux MLX child; no chat backend or public launcher."""
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import shlex
import secrets
import subprocess
import tempfile
import time

from aiohttp import ClientSession, ClientTimeout
import swap_policy

SERVICE = Path(__file__).resolve().parent / 'startlux-service'
ROOT = Path.home() / '.local/share/startlux/source-83fe6c7'
PYTHON = SERVICE / '.venv/bin/python'
MODEL = Path.home() / '.local/share/startlux/models/016dd9459af81a1cd62011f849dba7ce52aff795'
MODEL_ID = 'startlux-4b-instant'
UPSTREAM_ID = 'StartLux-Decision-v1.1-4B-Instant-MLX-4bit'
PORT = 8091
CONTEXT = 64000
WORK_TOKENS = 256000
KEY_FILE = SERVICE.parent / '.proxy-key'
LOG_FILE = Path.home() / '.dsv4/startlux-server.log'
TIMEOUT = 900


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


class StartLuxRuntime:
    def __init__(self):
        self.process = None
        self.verified = {}
        self.identity = None  # never adopt a retained child after proxy restart
        self.key_file = None
        self.child_headers = None

    def qualify(self):
        pin = json.loads((SERVICE / 'pin.json').read_text())
        if (pin.get('schema') != 1 or pin['model']['revision'] != MODEL.name
                or pin['upstream']['commit'] != '83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01'
                or not {'.venv/bin/python', 'uv.lock', 'managed.py', 'managed.patch'} <= pin['environment'].keys()
                or not {'startlux_decide/managed.py', 'startlux_decide/backends/mlx.py'} <= pin['source'].keys()):
            raise RuntimeError('Unqualified StartLux pin manifest')
        for base, records in ((MODEL, pin['model']['files']), (SERVICE, pin['environment']), (ROOT, pin['source'])):
            for name, expected in records.items():
                path = base / name
                stat = path.stat()
                identity = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
                if self.verified.get(str(path)) != identity:
                    if digest(path) != expected['sha256']:
                        raise RuntimeError('Unqualified StartLux artifact: ' + name)
                    self.verified[str(path)] = identity
        if not KEY_FILE.is_file() or KEY_FILE.stat().st_mode & 0o077:
            raise RuntimeError('StartLux key file missing or public')

    def argv(self, key_file=None):
        return [str(PYTHON), '-I', '-m', 'startlux_decide.cli', 'serve', '--model', str(MODEL),
                '--backend', 'mlx', '--host', '127.0.0.1', '--port', str(PORT),
                '--name', UPSTREAM_ID, '--api-keys-file', str(key_file or self.key_file or KEY_FILE),
                '--max-inflight', '1', '--max-model-len', str(CONTEXT), '--no-images', '--think-mode', 'never']

    def prepare_auth(self):
        # The public proxy credential need not satisfy upstream's key-file format.
        # Keep upstream validation intact; use a private child-lifetime credential.
        if self.key_file is not None:
            raise RuntimeError('StartLux child authentication already initialized')
        token = secrets.token_hex(32)
        fd, name = tempfile.mkstemp(prefix='startlux-auth-', dir=LOG_FILE.parent)
        self.key_file = Path(name)
        with os.fdopen(fd, 'w') as stream:
            stream.write(token + '\n')
        self.child_headers = {'Authorization': 'Bearer ' + token}

    @staticmethod
    def processes():
        lines = subprocess.check_output(['/bin/ps', '-axo', 'pid=,command='], text=True).splitlines()
        found = []
        for line in lines:
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            try:
                args = shlex.split(parts[1])
            except ValueError:
                continue
            if args and ('startlux_decide.cli' in args or
                         ('--port' in args and args[args.index('--port') + 1:][:1] == [str(PORT)])):
                found.append((int(parts[0]), args))
        return found

    def probe(self):
        found = self.processes()
        if len(found) > 1:
            raise RuntimeError('Multiple processes occupy StartLux lane')
        if not found:
            if swap_policy.port_listening(PORT):
                raise RuntimeError('Foreign listener on StartLux port')
            return None
        pid, args = found[0]
        if args != self.argv():
            raise RuntimeError('StartLux process identity/arguments unqualified')
        identity = (pid, subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'lstart='], text=True).strip())
        if self.identity != identity:
            raise RuntimeError('Retained or foreign StartLux child; supervised recovery required')
        return identity

    def alive(self, identity):
        pid, started = identity
        return bool(started and subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='],
                       capture_output=True, text=True).stdout.strip() == started)

    async def preflight(self, payload):
        # All bad input is rejected before admission, hence before any GPU switch.
        # Runs only the pinned tokenizer + upstream rendering, never MLX imports.
        await asyncio.to_thread(self.qualify)
        def check():
            env = dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1')
            p = subprocess.run([str(PYTHON), '-I', '-m', 'startlux_decide.managed', str(MODEL)],
                               input=json.dumps(payload), capture_output=True, text=True, timeout=60, env=env)
            if p.returncode == 2:
                raise ValueError('Invalid or oversized managed StartLux request')
            if p.returncode or json.loads(p.stdout).get('valid') is not True:
                raise RuntimeError('StartLux tokenizer preflight unavailable')
        await asyncio.to_thread(check)

    @staticmethod
    def validate_response(payload, result):
        """Contract validation only; decision probabilities stay upstream-owned."""
        def number(value, low=0, high=1):
            return type(value) in (int, float) and low <= value <= high and math.isfinite(value)
        def require(valid):
            if not valid:
                raise ValueError('Invalid response')
        try:
            require(result['model'] == UPSTREAM_ID)
            require(set(result['answers']) == set(payload['questions']))
            for key, question in payload['questions'].items():
                answer = result['answers'][key]
                typ = question.get('type', 'choice')
                require(answer['type'] == typ)
                if typ == 'noul':
                    require(number(answer['noul']))
                    continue
                probabilities = answer['probabilities']
                criteria = question['criteria']
                ids = set(criteria) if typ == 'choice' else set(map(str, range(len(criteria))))
                require(set(probabilities) == ids and all(number(p) for p in probabilities.values()))
                require(abs(sum(probabilities.values()) - 1) < 1e-6 and number(answer['confidence']))
                if typ == 'choice':
                    require(answer['choice'] in ids)
                    require(probabilities[answer['choice']] >= max(probabilities.values()) - 1e-6)
                    if 'none_probability' in answer:
                        require(number(answer['none_probability']))
                else:
                    require(number(answer['score'], high=len(criteria) - 1))
                    require(set(answer['legend']) == ids)
            usage = result['usage']
            require(type(usage['input_tokens']) is int and 0 < usage['input_tokens'] <= WORK_TOKENS)
            require(type(usage['output_tokens']) is int and usage['output_tokens'] == 0)
        except (AssertionError, KeyError, TypeError, AttributeError, ValueError):
            raise RuntimeError('StartLux response identity/questions/typed answer mismatch') from None

    async def ready(self, identity):
        try:
            async with ClientSession(timeout=ClientTimeout(total=5)) as session:
                async with session.get(f'http://127.0.0.1:{PORT}/health',
                     headers=self.child_headers) as response:
                    data = await response.json()
                    engine = data.get('engine', {})
                    check = engine.get('prompt_attention_check') or {}
                    return (response.status == 200 and self.alive(identity) and self.probe() == identity
                            and data.get('model') == UPSTREAM_ID and data.get('kind') == 'instant'
                            and data.get('prompt_attention') == 'bidirectional' and not data.get('images')
                            and engine.get('name') == 'mlx' and math.isfinite(check.get('first_position_change', 0))
                            and check.get('first_position_change', 0) > 0
                            and check.get('layers') == 32 and check.get('full_attention_layers') == 8
                            and data.get('context_length') == CONTEXT)
        except Exception:
            return False

    async def start(self):
        await asyncio.to_thread(self.qualify)
        if self.probe() is not None:
            raise RuntimeError('StartLux already resident before start')
        self.prepare_auth()
        log_fd = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            env = dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1')
            self.process = await asyncio.create_subprocess_exec(*self.argv(), cwd=str(ROOT), env=env,
                stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd, start_new_session=True)
        finally:
            os.close(log_fd)
        pid = self.process.pid
        self.identity = (pid, subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'lstart='], text=True).strip())
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            if self.process.returncode is not None:
                raise RuntimeError('StartLux exited during startup')
            identity = self.probe()
            if identity and await self.ready(identity):
                return identity
            await asyncio.sleep(1)
        raise RuntimeError('StartLux readiness timeout; GPU ownership remains unproven')

    async def stop(self):
        identity = self.probe()
        if identity is None:
            raise RuntimeError('StartLux disappeared before stop proof')
        os.kill(identity[0], 15)  # never SIGKILL; unknown completion remains closed
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if not self.alive(identity):
                if self.process and self.process.pid == identity[0]:
                    await self.process.wait()
                    self.process = None
                if self.probe() is None:
                    self.identity = None
                    if self.key_file is not None:
                        self.key_file.unlink()
                        self.key_file = None
                        self.child_headers = None
                    return
                raise RuntimeError('StartLux replaced during stop')
            await asyncio.sleep(.25)
        raise RuntimeError('StartLux did not exit after SIGTERM')
