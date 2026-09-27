"""Opt-in retained-owner controller. No public caller can submit native observations.

The checked CLI is the only policy authority. Adapters establish physical facts;
unknown physical state always retains the ordinary admission barrier.
"""
import asyncio
import hashlib
import json
import os
import secrets
import socket
import subprocess
import time
from pathlib import Path
from aiohttp import ClientSession, ClientTimeout, web

MAX_WAIT = 90
NATIVE_SERIALS = {}
# Private candidate only. The live module has no switch supervisor installed.
MANAGED_ENGINE_PREPARER = None
MANAGED_ENGINE_RELEASER = None


async def prepare_main(model_id):
    # Called under the proxy admission condition, AFTER queueing. Binding an
    # engine before that wait races the preceding request's model switch.
    if MANAGED_ENGINE_PREPARER is not None:
        return await MANAGED_ENGINE_PREPARER(model_id)
    if model_id != 'qwen3.8-flash-next':
        raise RuntimeError('managed switch supervisor unavailable')
    return FileEngine('ds4', os.environ['LOCAL_PROXY_DS4_GATE'],
                      int(os.environ['LOCAL_PROXY_DS4_PID']),
                      os.environ['LOCAL_PROXY_DS4_LOG'], os.environ['LOCAL_PROXY_DS4_BINARY'])


def ms(origin_ns):
    # Bend's runtime overflows on large absolute monotonic times; each owner
    # has an immutable origin shared with the challenged native observer.
    return max(1, (time.monotonic_ns() - origin_ns) // 1_000_000)


def private_file(path):
    path = Path(path)
    st = path.lstat()
    if not path.is_file() or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise RuntimeError(f"untrusted control file {path}")
    return path


def publish(directory, name, content):
    directory = Path(directory)
    st = directory.lstat()
    if not directory.is_dir() or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise RuntimeError("untrusted control directory")
    tmp = directory / ("." + name + "." + secrets.token_hex(8))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, directory / name)
    finally:
        tmp.unlink(missing_ok=True)


async def until(read, description, seconds=MAX_WAIT):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = read()
        if result is not None:
            return result
        await asyncio.sleep(.02)
    raise RuntimeError(f"{description} not established; hold retained")


def eligible(core, facts):
    if type(facts) is not dict or set(facts) != {'fresh', 'closed', 'drained', 'clean'}:
        raise RuntimeError('incomplete eligibility evidence')
    if any(type(v) is not bool for v in facts.values()):
        raise RuntimeError('unknown eligibility fact')
    result = subprocess.run([str(core), '--gpu', 'off', *(str(int(facts[k])) for k in
                             ('fresh', 'closed', 'drained', 'clean'))],
                            capture_output=True, timeout=5)
    if result.returncode != 0 or result.stderr or result.stdout != b'ELIGIBLE 1\n':
        raise RuntimeError('native evidence ineligible')


def clean_native(native, ticket=None):
    return (type(native) is dict and all(type(native.get(k)) is int and native[k] == 1
            for k in ('enabled', 'coverage', 'closed', 'clean')) and
            all(type(native.get(k)) is int and native[k] == 0
                for k in ('failed', 'errors', 'outstanding')) and
            type(native.get('submitted')) is int and native['submitted'] >= 0 and
            type(native.get('completed')) is int and native['submitted'] == native['completed'] and
            (ticket is None or type(native.get('ticket')) is int and native['ticket'] == ticket))


class FileEngine:
    """One qualified native process, one request, one private control directory."""
    def __init__(self, kind, control, pid, log, binary=None, *, expected_sha=None):
        self.kind, self.control, self.pid = kind, Path(control), int(pid)
        self.log = Path(log)
        self.binary = Path(binary) if binary else None
        self.binding = None
        self.ticket = 0
        self.terminal_ticket = None
        self.hold = None
        self.pause_requested = False
        self.high_water = 0
        self.resume_run = None
        self.resume_ticket = None
        self.seen = 0
        self.incarnation = None
        self.log_offset = self.log.stat().st_size
        self.started = subprocess.run(['/bin/ps', '-p', str(self.pid), '-o', 'lstart='],
            capture_output=True, text=True, check=True).stdout.strip()
        if not self.started:
            raise RuntimeError('native process start unknown')
        if kind == 'ds4':
            engine = json.loads(private_file(self.control / 'terminal-engine').read_text())
            if engine.get('pid') != self.pid or engine.get('supported') != 1:
                raise RuntimeError('DS4 native gate not qualified')
            self.incarnation = engine['engine']
            # Production default stays pinned. An isolated supervisor must pin
            # its candidate bytes explicitly; a pin is NOT qualification evidence.
            expected_sha = expected_sha or '23f9e6d99db3120cc24a32839ea57e6680fbae3de142b424a2780e8aa0494e32'
            if not self.binary or hashlib.sha256(self.binary.read_bytes()).hexdigest() != expected_sha:
                raise RuntimeError('DS4 build pin mismatch')
            command = subprocess.run(['/bin/ps', '-p', str(self.pid), '-o', 'command='],
                                     capture_output=True, text=True, check=True).stdout.strip()
            if not command.startswith(str(self.binary) + ' '):
                raise RuntimeError('native PID is not the pinned binary')
        elif kind == 'mlx':
            if not (self.control / 'engine.jsonl').exists():
                raise RuntimeError('MLX gate not enabled')
        else:
            raise RuntimeError('unknown native main')
        self.serial_key = (kind, str(self.control), self.incarnation)
        if self.serial_key not in NATIVE_SERIALS and any((self.control / name).exists()
                for name in ('ack', 'ack.json', 'terminal-ack', 'terminal_ack.json')):
            raise RuntimeError('old control receipts without process-lifetime ticket map')
        self.ticket = NATIVE_SERIALS.setdefault(self.serial_key, 0)

    def lines(self):
        path = self.log if self.kind == 'ds4' else self.control / 'engine.jsonl'
        with path.open('r') as stream:
            if self.kind == 'ds4':
                stream.seek(self.log_offset)
            return stream.readlines()

    @staticmethod
    def fields(line):
        return dict(item.split('=', 1) for item in line.split()[1:] if '=' in item)

    def _binding(self, request_id):
        if self.kind == 'ds4':
            rows = [self.fields(line) for line in self.lines() if line.startswith('FREEZE_BIND ')
                    and self.fields(line).get('request') == request_id]
            if len(rows) != 1 or int(rows[0]['pid']) != self.pid:
                return None
            return dict(pid=self.pid, nonce=rows[0]['nonce'], session=rows[0]['session'],
                        request=request_id, engine=self.incarnation)
        rows = [json.loads(line) for line in self.lines() if line.strip()]
        # The isolated MLX start record does not echo the HTTP request ID. An
        # unambiguous serialized HTTP-to-cache binding is not available here.
        raise RuntimeError('MLX request_start has no client request-ID binding')
        if len(rows) != 1 or rows[0].get('pid') != self.pid:
            return None
        return rows[0]

    async def bind(self, request_id):
        if not request_id or any(c.isspace() for c in request_id):
            raise RuntimeError('invalid native request ID')
        self.binding = await until(lambda: self._binding(request_id), 'native request/cache binding')
        if self.kind == 'mlx':
            self.incarnation = self.binding['engine']
        return self.binding

    def receipt(self, name, predicate):
        path = self.control / name
        if not path.exists():
            return None
        row = json.loads(private_file(path).read_text())
        return row if predicate(row) else None

    async def wait_for_decode(self):
        # Useful prefill is not a failed pause. Publish no native hold request
        # and start no pause watchdog until this specific request decodes.
        # Unknown activity stays bounded; telemetry never grants GPU ownership.
        deadline = time.monotonic() + MAX_WAIT
        port = int(os.environ.get('LOCAL_PROXY_DS4_PORT', '8001'))
        async with ClientSession(timeout=ClientTimeout(total=5)) as session:
            while True:
                if not self.alive():
                    raise RuntimeError('main exited while KEV waited for decode')
                async with session.get(f'http://127.0.0.1:{port}/admin/api/stats') as response:
                    response.raise_for_status()
                    models = (await response.json())['active_models']['models']
                request_id = self.binding['request']
                if any(r.get('request_id') == request_id for m in models for r in m['generating']):
                    return
                if any(r.get('request_id') == request_id for m in models for r in m['prefilling']):
                    deadline = time.monotonic() + MAX_WAIT
                elif time.monotonic() >= deadline:
                    raise RuntimeError('main phase unknown while KEV waited for decode')
                await asyncio.sleep(.2)

    async def pause(self, ticket):
        if self.binding is None or self.hold is not None:
            raise RuntimeError('unbound or already held main')
        if self.kind == 'ds4':
            await self.wait_for_decode()
        self.ticket += 1
        NATIVE_SERIALS[self.serial_key] = self.ticket
        number = self.ticket
        self.control.joinpath('ack' if self.kind == 'ds4' else 'ack.json').unlink(missing_ok=True)
        if self.kind == 'ds4':
            self.pause_requested = True
            publish(self.control, 'request', f"{self.pid} {number} decode {self.binding['request']}\n")
            def current(r):
                return (r.get('ticket') == number and r.get('pid') == self.pid and
                        r.get('phase') == 'decode' and r.get('nonce') == self.binding['nonce'] and
                        r.get('session') == self.binding['session'])
            ack = await until(lambda: self.receipt('ack', current), 'DS4 pause')
            good = (type(ack.get('generated')) is int and ack['generated'] >= self.high_water and
                    type(ack.get('outstanding')) is int and ack['outstanding'] == 0 and
                    type(ack.get('submitted')) is int and ack['submitted'] == ack.get('completed') and
                    ack.get('checkpoint_valid') == 1)
            self.high_water = ack['generated'] if good else self.high_water
        else:
            publish(self.control, 'pause.json', json.dumps(dict(engine=self.incarnation,
                request_nonce=self.binding['request_nonce'], ticket=number, phase='decode', minimum=0)))
            def current(r):
                return r.get('engine') == self.incarnation and r.get('ticket') == number and \
                    r.get('phase') == 'decode' and r.get('identity', {}).get('request_nonce') == self.binding['request_nonce']
            ack = await until(lambda: self.receipt('ack.json', current), 'MLX pause')
            good = clean_native(ack.get('native')) and ack.get('compute_permission_granted') is False
            self.high_water = max(self.high_water, self._latest_ordinal())
        eligible(self.core, dict(fresh=bool(good and self.alive()), closed=bool(good),
                                 drained=bool(good), clean=bool(good)))
        if not good:
            raise RuntimeError('unclean native pause')
        self.hold = ack
        return ack

    def alive(self):
        # PID alone can be reused; preserve the recorded process incarnation.
        return subprocess.run(['/bin/ps', '-p', str(self.pid), '-o', 'lstart='],
            capture_output=True, text=True).stdout.strip() == self.started

    def _latest_ordinal(self):
        if self.kind == 'ds4':
            rows = [self.fields(line) for line in self.lines() if line.startswith('FREEZE_TOKEN ')]
            rows = [r for r in rows if r.get('nonce') == self.binding['nonce'] and
                    r.get('session') == self.binding['session'] and int(r['pid']) == self.pid and
                    (self.resume_ticket is None or r.get('resume_ticket') == str(self.resume_ticket))]
        else:
            rows = [json.loads(line) for line in self.lines() if line.strip()]
            rows = [r for r in rows if r.get('event') == 'token' and
                    r.get('request_nonce') == self.binding['request_nonce']]
        return max((int(r.get('ordinal', 0)) for r in rows), default=0)

    def progress(self):
        if self.resume_run is None or self.hold is not None:
            return False
        high = self._latest_ordinal()
        if high > self.high_water:
            self.high_water = high
            return True
        return False

    async def resume(self, run):
        ack = self.hold
        if ack is None or not self.alive():
            raise RuntimeError('lost native held identity')
        number = ack['ticket']
        if self.kind == 'ds4':
            publish(self.control, 'resume', f'{self.pid} {number}\n')
            def confirmed():
                lines = self.lines()
                state = [self.fields(line) for line in lines if line.startswith('FREEZE_STATE RESUME ')]
                epochs = [self.fields(line) for line in lines if line.startswith('FREEZE_EPOCH ')]
                gpu = any(line.startswith('FREEZE_GPU RESUME ') for line in lines)
                return True if gpu and any(r.get('ticket') == str(number) and r.get('unchanged') == '1' and
                    r.get('session') == self.binding['session'] for r in state) and any(
                    r.get('ticket') == str(number) and r.get('nonce') == self.binding['nonce'] and
                    r.get('generated') == str(self.high_water) for r in epochs) else None
        else:
            publish(self.control, 'resume.json', json.dumps(dict(engine=self.incarnation,
                request_nonce=self.binding['request_nonce'], ticket=number,
                native_ticket=ack['native']['ticket'])))
            def confirmed():
                rows = [json.loads(line) for line in self.lines() if line.strip()]
                return True if any(r.get('event') == 'resumed' and r.get('engine') == self.incarnation and
                   r.get('request_nonce') == self.binding['request_nonce'] and r.get('ticket') == number
                   for r in rows) else None
        await until(confirmed, 'native retained resume')
        self.hold = None
        self.pause_requested = False
        self.resume_ticket = number
        self.resume_run = run

    async def retire(self):
        ack = self.hold
        if ack is None or not self.alive():
            raise RuntimeError('no surviving held stack to retire')
        if self.kind == 'ds4':
            publish(self.control, 'retire', f"{self.pid} {ack['nonce']} {ack['ticket']} {self.binding['request']}\n")
            name = 'retire-ack'
            def match(r, serial):
                return r.get('kind') == 'cancelled-held' and r.get('pid') == self.pid and \
                    r.get('nonce') == ack['nonce'] and r.get('ticket') == ack['ticket'] and r.get('serial') == serial
            first = await until(lambda: self.receipt(name, lambda r: match(r, 0)), 'post-unwind retirement')
            publish(self.control, 'retire-status', f"{self.pid} {ack['nonce']} {ack['ticket']} 1\n")
            fresh = await until(lambda: self.receipt(name, lambda r: match(r, 1)), 'fresh retirement status')
            good = all(type(fresh.get(k)) is int and fresh[k] == 1 for k in ('stack_unwound','ok','closed','clean')) and \
                all(type(fresh.get(k)) is int and fresh[k] == 0 for k in ('failed','outstanding')) and \
                fresh.get('submitted') == fresh.get('completed') == first.get('submitted')
        else:
            publish(self.control, 'retire.json', json.dumps(dict(engine=self.incarnation,
                request_nonce=self.binding['request_nonce'], ticket=ack['ticket'], native_ticket=ack['native']['ticket'])))
            name = 'retire_ack.json'
            fresh = await until(lambda: self.receipt(name, lambda r: r.get('engine') == self.incarnation and
                r.get('request_nonce') == self.binding['request_nonce'] and r.get('ticket') == ack['ticket']),
                'MLX post-unwind retirement')
            good = fresh.get('ok') is True and clean_native(fresh.get('native'), ack['native']['ticket'])
        eligible(self.core, dict(fresh=bool(good and self.alive()), closed=bool(good),
                                 drained=bool(good), clean=bool(good)))
        self.hold = None
        return fresh

    async def terminal(self):
        if self.hold is not None:
            raise RuntimeError('held stack cannot be called terminal')
        if self.kind != 'ds4':
            raise RuntimeError('MLX HTTP terminal not qualified on this build')
        # A disconnect can beat reader/job cleanup. Native close explicitly
        # rejects that busy window; retry it without treating rejection as proof.
        engine = self.incarnation
        number = self.ticket + 1
        ticket = number
        self.control.joinpath('terminal-ack').unlink(missing_ok=True)
        def cmd(serial, action):
            publish(self.control, 'terminal', f'{self.pid} {engine} {serial} {ticket} {action}\n')
        def match(serial, action):
            return self.receipt('terminal-ack', lambda r: r.get('pid') == self.pid and
                r.get('engine') == engine and r.get('serial') == str(serial) and
                r.get('ticket') == str(ticket) and r.get('action') == action)
        def close_when_idle():
            nonlocal number
            ack = match(number, 'close')
            if ack is None or ack.get('ok') == 1:
                return ack
            # Only the native all-zero, still-open busy rejection is retryable.
            if ack.get('kind') != 'terminal' or any(type(ack.get(k)) is not int or ack[k] != 0
                    for k in ('ok', 'admission_closed', 'retired', 'closed', 'clean', 'failed',
                              'submitted', 'completed', 'outstanding', 'keepalive_submitted',
                              'keepalive_completed', 'keepalive_parked')) or not self.alive():
                raise RuntimeError('native terminal close rejected; admission retained')
            number += 1
            cmd(number, 'close')
            return None
        cmd(number, 'close')
        first = await until(close_when_idle, 'terminal close')
        cmd(number + 1, 'status')
        fresh = await until(lambda: match(number + 1, 'status'), 'terminal fresh status')
        good = fresh.get('kind') == 'terminal' and all(type(fresh.get(k)) is int and fresh[k] == 1 for k in
            ('ok','admission_closed','closed','clean')) and all(type(fresh.get(k)) is int and fresh[k] == 0
            for k in ('failed','outstanding','retired')) and fresh.get('submitted') == fresh.get('completed') == first.get('submitted') and \
            fresh.get('keepalive_submitted') == fresh.get('keepalive_completed')
        eligible(self.core, dict(fresh=bool(good and self.alive()), closed=bool(good),
                                 drained=bool(good), clean=bool(good)))
        self.ticket = number + 1
        NATIVE_SERIALS[self.serial_key] = self.ticket
        self.terminal_ticket = ticket
        return fresh

    async def release_terminal(self):
        if self.terminal_ticket is None:
            raise RuntimeError('no terminal close to release')
        serial = self.ticket + 1
        publish(self.control, 'terminal', f'{self.pid} {self.incarnation} {serial} {self.terminal_ticket} release\n')
        await until(lambda: self.receipt('terminal-ack', lambda r: r.get('pid') == self.pid and
            r.get('engine') == self.incarnation and r.get('serial') == str(serial) and
            r.get('ticket') == str(self.terminal_ticket) and r.get('action') == 'release' and r.get('ok') == 1),
            'terminal release')
        self.ticket = serial
        NATIVE_SERIALS[self.serial_key] = serial
        self.terminal_ticket = None


class KevHTTP:
    """One qualified, one-shot private service process per checked StartKev."""
    SOURCE = Path(__file__).parent / 'kev-service/serve_gated.py'
    SOURCE_SHA256 = '59a62a7adba0ba4d31686541629eeb92dc74487ed983a11fcd1bbf137c189d3f'
    VENV = Path('/Users/jack/research/bend/kev-service-work/venv/bin/python')
    ROOT = Path('/Users/jack/research/bend')

    def __init__(self, directory):
        self.directory = Path(directory)
        self.process = None
        self.identity = None
        self.api_key = secrets.token_urlsafe(24)
        self.control_key = secrets.token_urlsafe(24)
        self.observe_serial = 0
        self.control_serial = 0
        self.previous = None
        self.sequence = 0
        self.ready = asyncio.Event()
        self.port = None
        self.key = None
        pinned = ((self.SOURCE, self.SOURCE_SHA256),
                  (self.VENV.parent.parent / 'lib/python3.13/site-packages/mlx/core.cpython-313-darwin.so',
                   'ffe1b55ee5537069606996085ef414a92f0a5fb9ddf80082f475a508e198a913'),
                  (self.VENV.parent.parent / 'lib/python3.13/site-packages/mlx/lib/libmlx.dylib',
                   'c0cb74546cd231cb81309956a142c7de5972b5de7a07ab7902db795192fb6552'))
        if any(hashlib.sha256(path.read_bytes()).hexdigest() != sha for path, sha in pinned):
            raise RuntimeError('unqualified Kev service/native build')

    async def http(self, method, path, body=None, control=False, request_id=None):
        headers = {'x-kev-control-key': self.control_key} if control else \
                  {'authorization': 'Bearer ' + self.api_key}
        if request_id:
            headers['x-typesafe-request-id'] = request_id
        if body is not None:
            headers['content-type'] = 'application/json'
        async with ClientSession(timeout=ClientTimeout(total=10 if control else None)) as session:
            async with session.request(method, f'http://127.0.0.1:{self.port}{path}',
                                       json=body, headers=headers) as response:
                data = await response.json()
                return response.status, data, response.headers.get('x-typesafe-request-id')

    def challenge(self, action, control=False):
        if control:
            self.control_serial += 1
            n = self.control_serial
        else:
            self.observe_serial += 1
            n = self.observe_serial
        return dict(key=self.identity['key'], incarnation=self.identity['incarnation'],
                    ticket=self.identity['ticket'], challenge=n, action=action)

    async def score(self, key, payload, reservation, request_id=None):
        if self.process is not None or reservation.engine.hold is None or not reservation.engine.alive():
            raise RuntimeError('borrower already dispatched or main native hold/identity lost')
        self.key = key
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        # Recovery metadata is private and journaled before GPU-capable launch;
        # a lost HTTP waiter must not erase who owns this process/control key.
        fd = os.open(self.directory / 'control.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as manifest:
            json.dump(dict(core_key=key, api_key=self.api_key, control_key=self.control_key), manifest)
            manifest.flush()
            os.fsync(manifest.fileno())
        with socket.socket() as port:
            port.bind(('127.0.0.1', 0))
            self.port = port.getsockname()[1]
        env = dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                   MLX_NATIVE_GATE='1', KEV_TRIAL_LEASE='1', KEV_SOURCE_SHA256=self.SOURCE_SHA256,
                   KEV_API_KEY=self.api_key,
                   KEV_CONTROL_KEY=self.control_key,
                   MLX_NATIVE_GATE_LOG=str(self.directory / 'native.jsonl'),
                   PYTHONPATH=str(self.ROOT / 'two-gaps-work/kev') + ':' +
                              str(self.ROOT / 'kev-handoff/upstream-kev'))
        log = (self.directory / 'service.log').open('wb')
        self.process = await asyncio.create_subprocess_exec(str(self.VENV), str(self.SOURCE),
            '--port', str(self.port),
            env=env, stdout=log, stderr=subprocess.STDOUT)
        self.log = log
        with (self.directory / 'control.json').open('a') as manifest:
            manifest.write('\n' + json.dumps(dict(wrapper_pid=self.process.pid, port=self.port)) + '\n')
            manifest.flush()
            os.fsync(manifest.fileno())
        try:
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                if self.process.returncode is not None:
                    raise RuntimeError('borrower died before service ready')
                try:
                    status, identity, _ = await self.http('GET', '/_kev/identity', control=True)
                    if status == 200 and identity.get('kind') == 'hello' and identity.get('ticket') == 418 and \
                        identity.get('key') == 'private-kev-http' and type(identity.get('pid')) is int and \
                        identity['pid'] == self.process.pid and identity.get('source_sha256') == self.SOURCE_SHA256:
                        self.identity = identity
                        self.previous = identity['baseline']
                        self.ready.set()
                        break
                except Exception:
                    await asyncio.sleep(.1)
            if not self.ready.is_set():
                raise RuntimeError('borrower startup unknown; retain owner')
            status, answer, response_id = await self.http('POST', '/v1/systemone', payload, request_id=request_id)
            if status != 200:
                raise RuntimeError(f'borrower score HTTP {status}: {answer!r}')
            return answer, response_id
        finally:
            # This is not stop evidence. The independently scheduled checked
            # StopKev effect owns stop/drain and eventual cooperative exit.
            pass

    async def sample(self, key):
        if not self.ready.is_set():
            return None
        if key != self.key or self.process.returncode is not None:
            raise RuntimeError('borrower process died or key changed')
        sent = time.monotonic_ns()
        question = self.challenge('sample')
        status, row, _ = await self.http('POST', '/_kev/sample', question, True)
        received = time.monotonic_ns()
        if status != 200 or row.get('ok') is not True or row.get('challenge') != question['challenge'] or \
                any(row.get(k) != self.identity[k]
                for k in ('pid','key','incarnation','ticket')):
            raise RuntimeError('unbound native activity')
        snapshot = row.get('snapshot', {})
        native = snapshot.get('native', {})
        previous = self.previous
        if not (type(snapshot.get('lower_ns')) is int and type(snapshot.get('upper_ns')) is int and
                sent <= snapshot['lower_ns'] <= snapshot['upper_ns'] <= received and
                native.get('enabled') == native.get('coverage') == 1 and
                native.get('closed') == native.get('failed') == native.get('errors') == 0 and
                all(type(native.get(k)) is int and native[k] >= 0 for k in
                    ('submitted','completed','outstanding')) and
                native['submitted'] - native['completed'] == native['outstanding'] and
                native['submitted'] >= previous['native']['submitted'] and
                native['completed'] >= previous['native']['completed']):
            raise RuntimeError('stale or unhealthy native activity')
        self.previous = snapshot
        if native['submitted'] == previous['native']['submitted'] and \
           native['completed'] == previous['native']['completed']:
            return None  # heartbeat and frozen outstanding cannot renew.
        self.sequence += 1
        return self.sequence, max(1, (previous['lower_ns'] - self.origin_ns) // 1_000_000)

    async def stop(self, key):
        if key != self.key or not self.ready.is_set() or self.process.returncode is not None:
            raise RuntimeError('borrower death or no-work stop unestablished')
        question = self.challenge('stop', True)
        status, answer, _ = await self.http('POST', '/_kev/stop', question, True)
        if status != 200 or answer.get('challenge') != question['challenge'] or answer.get('ok') is not True:
            raise RuntimeError('native stop denied')
        proof = None
        deadline = time.monotonic() + MAX_WAIT
        while time.monotonic() < deadline:
            question = self.challenge('sample')
            sent = time.monotonic_ns()
            _, row, _ = await self.http('POST','/_kev/sample', question, True)
            received = time.monotonic_ns()
            snap = row.get('snapshot', {})
            if not (type(snap.get('lower_ns')) is int and type(snap.get('upper_ns')) is int and
                    sent <= snap['lower_ns'] <= snap['upper_ns'] <= received):
                raise RuntimeError('stale stop observation')
            if row.get('challenge') != question['challenge'] or any(row.get(k) != self.identity[k]
                for k in ('pid','key','incarnation','ticket')):
                raise RuntimeError('stale or foreign stop sample')
            if row.get('phase') == 'stop-unknown':
                raise RuntimeError('native stop unknown')
            if row.get('phase') == 'held':
                proof = row
                break
            await asyncio.sleep(.1)
        if proof is None or proof.get('eligible_stop') is not True or proof.get('pid') != self.identity['pid'] or \
                proof.get('incarnation') != self.identity['incarnation'] or proof.get('ticket') != 418:
            raise RuntimeError('no fresh challenged stop receipt')
        native = proof.get('snapshot', {}).get('native')
        held = proof.get('proof', {})
        good = (held.get('stack_unwound') is True and clean_native(native, held.get('native', {}).get('ticket')) and
                all(native.get(k) == held['native'].get(k) for k in
                    ('ticket','submitted','completed','outstanding','errors','failed')))
        facts = dict(fresh=bool(good), closed=bool(good), drained=bool(good), clean=bool(good))
        if not good:
            raise RuntimeError('unclean borrower stop')
        # No physical restart: the one-shot service can only exit after its held receipt.
        status, answer, _ = await self.http('POST','/_kev/exit', self.challenge('exit', True), True)
        if status != 200 or answer.get('ok') is not True:
            raise RuntimeError('cooperative borrower exit denied')
        await asyncio.wait_for(self.process.wait(), 30)
        self.log.close()
        return dict(facts=facts, raw=proof)


class Reservation:
    """Supervisor lives independently of the HTTP waiter; one seat stays occupied."""
    def __init__(self, checked, engine, borrower, owner, journal, request_id, block=None,
                 abort_main=None):
        self.engine, self.borrower = engine, borrower
        self.abort_main = abort_main
        self.core = checked(owner, journal)
        self.engine.core = checked.__init__.__globals__['COORDINATOR']
        self.owner = self.core.owner
        self.request_id = request_id
        self.origin_ns = time.monotonic_ns()
        self.block = block or (lambda: None)
        self.lock = asyncio.Lock()
        self.lifecycle = 'active'
        self.blocked = None
        self.current = None
        self.calls = {}
        self.tasks = set()
        self.cancelled = False
        self.hold_ticket = None
        self.pause_task = None
        self.last_sample = None
        self.deadline = None
        self.returned = []
        self.terminal_receipt = None
        self.main_done = False
        self.cancel_pending = False
        self.released = asyncio.Event()

    def now(self):
        return ms(self.origin_ns)

    def record(self, kind, receipt):
        with self.core.journal.open('a') as log:
            log.write(json.dumps(dict(physical=kind, receipt=receipt), default=str) + '\n')
            log.flush()
            os.fsync(log.fileno())

    def task(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    def fail(self, exc):
        self.blocked = repr(exc)
        self.lifecycle = 'blocked'
        self.block()

    async def event(self, wire, fact=None):
        async with self.lock:
            if self.blocked:
                raise RuntimeError('held owner blocked: ' + self.blocked)
            try:
                action = self.core.apply(wire, effect_id=f'version-{self.core.version}')
                fields = list(map(int, action.split('/')))
                tag = fields[0]
                lengths = {0:1, 1:7, 2:9, 3:9, 4:9, 5:6, 6:8, 8:2}
                if (tag in lengths and len(fields) != lengths[tag]) or (tag not in lengths and tag != 7):
                    raise RuntimeError('unknown checked directive')
                if tag == 1:
                    self.hold_ticket = action[2:]
                    self.lifecycle = 'awaiting-pause'
                    self.pause_task = self.task(self.pause(self.hold_ticket))
                elif tag == 2:
                    key = '/'.join(map(str, fields[1:8]))
                    call = fields[7]
                    if not key.startswith(self.hold_ticket + '/') or call not in self.calls or \
                            fact is None or fact.get('kind') != 'pause' or fact.get('ticket') != self.hold_ticket:
                        raise RuntimeError('StartKev without a fresh matching pause')
                    self.current = key
                    if isinstance(self.borrower, KevHTTP) and self.borrower.process is not None:
                        self.borrower = KevHTTP(self.borrower.directory.parent / ('borrow-' + str(call)))
                    self.lifecycle = 'held'
                    self.deadline = fields[8]
                    self.task(self.score(key, self.calls[call]))
                    self.task(self.watch(key))
                elif tag == 3:
                    if '/'.join(map(str, fields[1:8])) != self.current:
                        raise RuntimeError('foreign WatchKev')
                    self.deadline = fields[8]
                elif tag == 4:
                    key = '/'.join(map(str, fields[1:8]))
                    if key != self.current:
                        raise RuntimeError('foreign StopKev')
                    self.lifecycle = 'awaiting-stop'
                    record = self.calls[fields[7]]
                    if fields[8] != 0 and not record['future'].done():
                        record['future'].set_exception(RuntimeError(
                            'borrower timed out' if fields[8] == 2 else 'borrower failed; awaiting native stop'))
                    self.task(self.stop(key))
                elif tag == 5:
                    if fields[1:5] != list(map(int, self.owner.split('/'))) or self.current is None or \
                            fact is None or fact.get('kind') != 'stop':
                        raise RuntimeError('ResumeMain without stopped borrower')
                    self.lifecycle = 'resume-pending'
                    self.task(self.resume(fields[5]))
                elif tag == 6:
                    self.fail('native stop unknown')
                elif tag == 7:
                    if fields[1:5] != list(map(int, self.owner.split('/'))) or len(fields) < 6:
                        raise RuntimeError('invalid EndMain')
                    self.returned.extend(fields[6:])
                    for call in fields[6:]:
                        if call in self.calls and not self.calls[call]['future'].done():
                            self.calls[call]['future'].set_exception(RuntimeError('returned to outer scheduler without main'))
                    self.lifecycle = 'retiring'
                    self.task(self.retire())
                elif tag == 8:
                    self.returned.append(fields[1])
                    if fields[1] in self.calls and not self.calls[fields[1]]['future'].done():
                        self.calls[fields[1]]['future'].set_exception(RuntimeError('returned to outer scheduler without main'))
                return action
            except Exception as exc:
                self.fail(exc)
                raise

    async def pause(self, ticket):
        try:
            receipt = await self.engine.pause(ticket)
            self.record('main-pause', receipt)
            if ticket != self.hold_ticket:
                raise RuntimeError('superseded native pause')
            await self.event('4/' + ticket + '/' + str(self.now()), dict(kind='pause', ticket=ticket, receipt=receipt))
        except Exception as exc:
            self.fail(exc)

    async def enqueue(self, call, payload, request_id=None):
        if self.blocked or self.cancelled or self.lifecycle in ('retiring', 'retired-gate-closed', 'retired-terminal-closed') or \
                call in self.calls or sum(not r['future'].done() for r in self.calls.values()) >= 64:
            # ponytail: bounded linear scan; index pending calls if throughput matters.
            raise RuntimeError('borrow admission unavailable')
        self.calls[call] = dict(payload=payload, request_id=request_id,
                                future=asyncio.get_running_loop().create_future(),
                                cancelled=False, launched=False)
        await self.event(f'0/{call}')
        try:
            return await asyncio.shield(self.calls[call]['future'])
        except asyncio.CancelledError:
            self.calls[call]['cancelled'] = True
            raise

    async def cancel_borrower(self, call):
        record = self.calls.get(call)
        if not record:
            return
        record['cancelled'] = True
        if record['launched'] and self.current and self.current.endswith('/' + str(call)) and \
                self.lifecycle == 'held':
            await self.event(f'6/{self.current}/1/{self.now()}')

    async def cancel_main(self):
        if not self.cancelled:
            self.cancelled = True
            waiting_prefill = (self.lifecycle == 'awaiting-pause' and
                               getattr(self.engine, 'pause_requested', True) is False)
            if (self.abort_main is not None and self.engine.hold is None and
                    (self.lifecycle == 'active' or waiting_prefill)):
                # No borrower owns compute and no pause is pending. Close the
                # DS4 socket now; never wait for decode just to cancel prefill.
                # MainFinished still requires the post-unwind terminal receipt.
                self.lifecycle = 'cancelling'
                if self.pause_task:
                    self.pause_task.cancel()
                self.abort_main()
                return
            if self.lifecycle == 'resume-pending':
                self.cancel_pending = True  # reconcile committed resume before cancellation drain.
            else:
                await self.event('1/' + self.owner)

    async def score(self, key, record):
        try:
            if record['cancelled']:
                record['error'] = 'borrower caller cancelled before launch'
                await self.event(f'6/{key}/1/{self.now()}')
                return
            record['launched'] = True
            if isinstance(self.borrower, KevHTTP):
                self.borrower.origin_ns = self.origin_ns
            if isinstance(self.borrower, KevHTTP):
                result = await self.borrower.score(key, record['payload'], self, record['request_id'])
            else:
                result = await self.borrower.score(key, record['payload'], self)
            record['result'] = result
            await self.event(f'6/{key}/0/{self.now()}')
        except Exception as exc:
            record['error'] = repr(exc)
            try:
                await self.event(f'6/{key}/1/{self.now()}')
            except Exception as error:
                self.fail(error)

    async def watch(self, key):
        while key == self.current and not self.blocked and self.lifecycle == 'held':
            try:
                due = self.deadline
                if self.now() >= due:
                    await self.event(f'9/{self.now()}')
                    continue
                sample = await asyncio.wait_for(self.borrower.sample(key), timeout=min(1, max(.01, (due-self.now())/1000)))
                if sample is not None and key == self.current and self.now() < self.deadline:
                    self.last_sample = sample
                    await self.event(f'10/{key}/{sample[0]}/{sample[1]}')
                else:
                    await asyncio.sleep(.1)
            except asyncio.TimeoutError:
                continue
            except Exception as exc:
                try:
                    await self.event(f'6/{key}/1/{self.now()}')
                except Exception as error:
                    self.fail(error)
                return

    async def stop(self, key):
        try:
            record = self.calls[int(key.split('/')[-1])]
            if not record['launched'] and self.borrower.process is None:
                # Proven no-work: launch was suppressed under this sequencer,
                # not guessed from a dead process or an empty HTTP list.
                proof = dict(facts=dict(fresh=True, closed=True, drained=True, clean=True), raw='never-dispatched')
            else:
                proof = await self.borrower.stop(key)
            eligible(self.engine.core, proof['facts'])
            self.record('kev-stop', proof)
            await self.event('7/' + key, dict(kind='stop', receipt=proof))
            if not record['future'].done():
                if record.get('error'):
                    record['future'].set_exception(RuntimeError(record['error']))
                else:
                    record['future'].set_result(record['result'])
        except Exception as exc:
            try:
                await self.event('8/' + key)
            except Exception as error:
                self.fail(error)
            self.fail(exc)
            record = self.calls[int(key.split('/')[-1])]
            if not record['future'].done():
                record['future'].set_exception(RuntimeError('awaiting-stop: ' + repr(exc)))

    async def resume(self, run):
        try:
            await self.engine.resume(run)
            self.record('main-resume', dict(run=run, ticket=getattr(self.engine, 'resume_ticket', None),
                                            high_water=self.engine.high_water))
            self.current = None
            self.lifecycle = 'active'
            if self.cancel_pending:
                self.cancel_pending = False
                await self.event('1/' + self.owner)
            else:
                self.task(self.observe_main(run))
        except Exception as exc:
            self.fail(exc)

    async def observe_main(self, run):
        while self.lifecycle == 'active' and not self.blocked and not self.main_done:
            if self.engine.progress():
                await self.event(f'2/{self.owner}/{run}')
                return
            await asyncio.sleep(.05)

    async def main_finished(self):
        self.main_done = True
        if self.pause_task and getattr(self.engine, 'pause_requested', True) is False:
            self.pause_task.cancel()  # EOF before a native pause was requested
        try:
            self.terminal_receipt = await self.engine.terminal()
            self.record('main-terminal', self.terminal_receipt)
            if self.lifecycle == 'awaiting-pause' and self.pause_task:
                self.pause_task.cancel()  # terminal won; no retaining ack can follow a closed idle stack.
            await self.event(f'3/{self.owner}/{self.core.state.split("/")[4]}')
        except Exception as exc:
            self.fail(exc)

    async def retire(self):
        try:
            if self.terminal_receipt is None:
                await self.engine.retire()
                # Irreversible retired native hold; ordinary admission must not reopen it.
                self.lifecycle = 'retired-gate-closed'
            else:
                await self.engine.release_terminal()
                self.record('main-terminal-release', dict(ticket=getattr(self.engine, 'terminal_ticket', None)))
                self.lifecycle = 'retired'
                self.released.set()
        except Exception as exc:
            self.fail(exc)


# These globals are opt-in private-port ownership only; ordinary proxy traffic
# continues through its original admission and finalizer when the flag is OFF.
LIVE = None
MAIN_TASK = None
CALL_COUNTER = secrets.randbits(40)


def status(request_id):
    reservation = LIVE
    if not reservation or request_id != reservation.request_id:
        return None  # no cross-request telemetry
    state = reservation.core.state.split('/')
    native = getattr(reservation.borrower, 'previous', None)
    counters = native.get('native', {}) if isinstance(native, dict) else {}
    observed_ms = max(1, (native['upper_ns'] - reservation.origin_ns)//1_000_000) if native else None
    return dict(reservation_id=reservation.owner, version=reservation.core.version,
        owner_request_id=reservation.request_id, lifecycle=reservation.lifecycle,
        phase=int(state[7]), run=int(state[4]), cancellation_pending=reservation.cancelled,
        borrower_key=reservation.current, borrower_state=reservation.lifecycle if reservation.current else None,
        accepted_calls=len(reservation.calls), returned_calls=list(reservation.returned),
        queue_depth=sum(not r['future'].done() and not r['launched'] for r in reservation.calls.values()),
        queue_position=None,
        last_native_work_ms=reservation.last_sample[1] if reservation.last_sample else None,
        last_native_work_kind='submitted_or_completed' if reservation.last_sample else None,
        native_outstanding=counters.get('outstanding'), last_observation_ms=observed_ms,
        sample_fresh=bool(observed_ms is not None and reservation.now() - observed_ms < 1000),
        next_deadline_ms=reservation.deadline, turn_limit_ms=(int(state[12]) if int(state[7]) == 6 else None),
        blocked_reason=reservation.blocked, physical_release_established=reservation.released.is_set())


def unavailable(request, reason):
    raise web.HTTPServiceUnavailable(text=json.dumps(dict(admitted=False,
        request_id=request.headers.get('X-Pi-Request-Id') or secrets.token_hex(12), reason=reason)),
        content_type='application/json')


async def handle_main(request, body, backend_name, model_id, checked,
                      begin_request, finish_request, condition, backend, mark_blocked):
    global LIVE, MAIN_TASK
    request_id = request.headers.get('X-Pi-Request-Id')
    try:
        payload = json.loads(body)
    except (ValueError, TypeError):
        raise web.HTTPBadRequest(text='Expected JSON request')
    control = os.getenv('LOCAL_PROXY_DS4_GATE')
    log = os.getenv('LOCAL_PROXY_DS4_LOG')
    binary = os.getenv('LOCAL_PROXY_DS4_BINARY')
    pid = os.getenv('LOCAL_PROXY_DS4_PID')
    port = os.getenv('LOCAL_PROXY_DS4_PORT')
    if (MANAGED_ENGINE_PREPARER is None and not all((control, log, binary, pid))) or \
       not port or backend != f'http://127.0.0.1:{port}/v1' or \
       os.getenv('LOCAL_PROXY_PRIVATE_LEASE') != '1':
        unavailable(request, 'native_reservation_adapter_unavailable')
    models = {'qwen3.8-flash-next'} if MANAGED_ENGINE_PREPARER is None else \
             {'qwen3.8-flash-next', 'deepseek-v4.1-flash'}
    if backend_name != 'ds4' or model_id not in models or \
       not isinstance(payload, dict) or payload.get('stream') is not True or \
       payload.get('temperature', 0) != 0 or not request_id or len(request_id) > 128 or \
       not all(c.isascii() and (c.isalnum() or c in '-_') for c in request_id):
        unavailable(request, 'unsupported_native_reservation_path')
    engine = await begin_request(backend_name, model_id, request, managed=True)
    control = str(engine.control)
    queue = asyncio.Queue(maxsize=128)
    disconnected = False
    holder = {'reservation': None, 'error': None, 'forwarding': False}

    async def disconnect():
        nonlocal disconnected
        disconnected = True
        if not holder['forwarding']:
            return  # not started yet, or already establishing terminal evidence
        if holder['reservation']:
            await holder['reservation'].cancel_main()
        else:
            forward_task.cancel()  # before native binding, no borrower can exist

    async def forward():
        global LIVE
        reservation = None
        try:
            try:
                holder['forwarding'] = True
                if disconnected:
                    raise asyncio.CancelledError()
                async with ClientSession(timeout=ClientTimeout(total=None, sock_connect=10)) as session:
                    headers = dict(Authorization=request.headers.get('Authorization') or
                                   'Bearer ' + (Path(__file__).parent / '.proxy-key').read_text().strip(),
                                   **{'X-Pi-Request-Id': request_id, 'Content-Type': 'application/json'})
                    async with session.post(backend + '/chat/completions', data=body, headers=headers) as upstream:
                        if upstream.status != 200 or upstream.content_type != 'text/event-stream':
                            raise RuntimeError(f'unqualified upstream response {upstream.status}/{upstream.content_type}')
                        binding = await engine.bind(request_id)
                        if LIVE is not None:
                            raise RuntimeError('second managed owner')
                        # Owner IDs are process-local random+monotone; physical identity is
                        # bound separately to PID/incarnation/request nonce/session.
                        base = secrets.randbits(40)
                        owner = (0, base, base + 1, base + 2)
                        journal = Path(control) / ('reservation-' + request_id + '.jsonl')
                        borrower = KevHTTP(Path(control) / ('borrow-' + request_id))
                        with journal.open('x') as evidence:
                            evidence.write(json.dumps(dict(owner=owner, request_id=request_id,
                                pid=engine.pid, started=engine.started, incarnation=engine.incarnation,
                                binding=binding)) + '\n')
                            evidence.flush()
                            os.fsync(evidence.fileno())
                        reservation = Reservation(checked, engine, borrower, owner, journal, request_id,
                                                  mark_blocked, abort_main=asyncio.current_task().cancel)
                        holder['reservation'] = LIVE = reservation
                        async for chunk in upstream.content.iter_any():
                            if not disconnected:
                                await queue.put(chunk)
            except asyncio.CancelledError:
                if not disconnected or (reservation and reservation.lifecycle != 'cancelling'):
                    raise
                # Closing the HTTP task signals native cancellation, NOT safe
                # release. Keep admission until post-unwind close/status below.
            finally:
                holder['forwarding'] = False
            if reservation:
                # EOF is not terminal evidence. The upstream reader must leave
                # before the serial worker can acknowledge an idle terminal close.
                if reservation.lifecycle == 'retiring' and reservation.terminal_receipt is None:
                    while reservation.lifecycle == 'retiring' and not reservation.blocked:
                        await asyncio.sleep(.05)
                if reservation.lifecycle == 'retired-gate-closed':
                    raise RuntimeError('retired gate needs supervised process lifecycle before new admission')
                if not reservation.blocked:
                    await reservation.main_finished()
                while not reservation.released.is_set() and not reservation.blocked:
                    await asyncio.sleep(.05)
                if reservation.blocked:
                    raise RuntimeError('retained main blocked: ' + reservation.blocked)
                LIVE = None
                await finish_request(backend_name, release_chat=disconnected)
            elif disconnected:
                # Cancelled before bind (possibly before HTTP headers). There is
                # no checked owner/borrower yet, but native work may have started.
                await engine.terminal()
                await engine.release_terminal()
                await finish_request(backend_name, release_chat=True)
        except Exception as exc:
            holder['error'] = repr(exc)
            if reservation:
                reservation.fail(exc)
            else:
                mark_blocked()
            # Never call the old finalizer in a way that frees a live cache.
            await finish_request(backend_name, uncertain=True)
        finally:
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(None)

    forward_task = MAIN_TASK = asyncio.create_task(forward())
    response = web.StreamResponse(headers={'Content-Type': 'text/event-stream',
                           'Cache-Control': 'no-cache', 'Connection': 'keep-alive'})
    try:
        await response.prepare(request)
        while True:
            if request.transport is None or request.transport.is_closing():
                await disconnect()
                break
            try:
                chunk = await asyncio.wait_for(queue.get(), .1)
            except asyncio.TimeoutError:
                continue
            if chunk is None:
                break
            await response.write(chunk)
        if not disconnected:
            await response.write_eof()
        return response
    except (ConnectionError, asyncio.CancelledError):
        await disconnect()
        raise
    # Only the supervised forward task can publish terminal release and free
    # admission, including when its HTTP reader was cancelled above.


async def handle_kev(request):
    global CALL_COUNTER
    if request.headers.get('Authorization') != 'Bearer ' + (
        os.getenv('LOCAL_LLM_PROXY_API_KEY') or (Path(__file__).parent / '.proxy-key').read_text().strip()):
        raise web.HTTPUnauthorized()
    if request.content_length is not None and request.content_length > 1024 * 1024:
        raise web.HTTPRequestEntityTooLarge(max_size=1024*1024, actual_size=request.content_length)
    try:
        payload = await request.json()
    except (ValueError, TypeError):
        raise web.HTTPBadRequest(text='Expected TypeSafe JSON')
    if not isinstance(payload, dict) or payload.get('model', 'jev-latest') not in ('jev-latest', 'kev-latest') or \
       not isinstance(payload.get('state'), dict):
        raise web.HTTPBadRequest(text='Unsupported TypeSafe scoring request')
    reservation = LIVE
    if reservation is None or reservation.blocked or reservation.lifecycle in ('retiring','retired'):
        unavailable(request, 'retained_owner_unavailable')
    CALL_COUNTER += 1
    call = CALL_COUNTER
    requested_id = request.headers.get('x-typesafe-request-id')
    if requested_id and (len(requested_id) > 128 or not all(c.isascii() and (c.isalnum() or c in '-_') for c in requested_id)):
        raise web.HTTPBadRequest(text='Invalid TypeSafe request ID')
    task = asyncio.create_task(reservation.enqueue(call, payload, requested_id))
    try:
        while not task.done():
            if request.transport is None or request.transport.is_closing():
                task.cancel()
                await reservation.cancel_borrower(call)
                unavailable(request, 'borrower_client_disconnected')
            await asyncio.sleep(.1)
        answer, request_id = await task
        return web.json_response(answer, headers={'x-typesafe-request-id': request_id or
            request.headers.get('x-typesafe-request-id', '')})
    except RuntimeError as exc:
        raise web.HTTPServiceUnavailable(text=json.dumps(dict(admitted=True,
            call=call, reason=str(exc),
            awaiting_stop=reservation.lifecycle in ('awaiting-stop', 'blocked'))),
            content_type='application/json') from exc


async def handle_kev_models(request):
    if request.headers.get('Authorization') != 'Bearer ' + (
        os.getenv('LOCAL_LLM_PROXY_API_KEY') or (Path(__file__).parent / '.proxy-key').read_text().strip()):
        raise web.HTTPUnauthorized()
    reservation = LIVE
    if not reservation or not isinstance(reservation.borrower, KevHTTP) or \
       not reservation.borrower.ready.is_set():
        unavailable(request, 'kev_service_not_ready')
    status, result, _ = await reservation.borrower.http('GET', '/v1/models')
    return web.json_response(result, status=status)
