"""Private, proxy-owned Winnow decision server. No chat route or independent launcher."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

from aiohttp import ClientSession, ClientTimeout
import swap_policy

ROOT = Path('/Users/jack/winnow-inference')
BINARY = ROOT / '.build/bin/winnow-server'
MODEL = ROOT / 'models/gguf/Winnow-12B-Q8_0.gguf'
PORT = 8091
MODEL_ID = 'winnow-12b'
UPSTREAM_ID = 'Winnow-12B'
KEY_FILE = Path(__file__).resolve().parent / '.proxy-key'
LOG_FILE = Path('/Users/jack/.dsv4/winnow-server.log')
TIMEOUT = 900


class WinnowRuntime:
    def __init__(self):
        self.binary_digest = None
        self.model_digest = None
        self.model_stat = None
        self.process = None

    def qualify(self):
        revision = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
        if revision != '77d14580c6732ca2f3745750c1dc1fd446d8bcee':
            raise RuntimeError('unqualified Winnow source revision')
        manifest = json.loads((ROOT / 'manifests/models.json').read_text())['release']['model']
        if manifest['sha256'] != 'b710efc4c0d048ee61eed92c5fef5ce323a4d17e7c51f9f0533cc72ae50818ea' or MODEL.stat().st_size != manifest['bytes']:
            raise RuntimeError('unqualified Winnow model manifest/size')
        binary = hashlib.sha256(BINARY.read_bytes()).hexdigest()
        if binary != 'c1ed4df6908f374607d8f91620c084b39743a25e1490344c8df67ac8dc83e2c6':
            raise RuntimeError('unqualified Winnow Metal executable')
        if self.binary_digest is not None and binary != self.binary_digest:
            raise RuntimeError('Winnow binary changed after qualification')
        self.binary_digest = binary
        stat = MODEL.stat()
        identity = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
        if self.model_stat != identity:
            digest = hashlib.sha256(MODEL.read_bytes()).hexdigest()
            if digest != manifest['sha256']:
                raise RuntimeError('unqualified Winnow GGUF digest')
            self.model_digest, self.model_stat = digest, identity
        if not KEY_FILE.is_file() or KEY_FILE.stat().st_mode & 0o077:
            raise RuntimeError('Winnow API key file missing or public')

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
            if args and (args[0] == str(BINARY) or ('--port' in args and args[args.index('--port') + 1:][:1] == [str(PORT)])):
                found.append((int(parts[0]), args))
        return found

    def probe(self):
        found = self.processes()
        if len(found) > 1:
            raise RuntimeError('multiple processes occupy Winnow lane')
        if not found:
            if swap_policy.port_listening(PORT):
                raise RuntimeError('foreign listener on Winnow port')
            return None
        pid, args = found[0]
        if args[0] != str(BINARY) or '--model' not in args or \
           args[args.index('--model') + 1:][:1] != [str(MODEL)] or \
           '--api-key-file' not in args or \
           args[args.index('--api-key-file') + 1:][:1] != [str(KEY_FILE)] or \
           args.count('--port') != 1 or args[args.index('--port') + 1:][:1] != [str(PORT)] or \
           '--host' not in args or args[args.index('--host') + 1:][:1] != ['127.0.0.1']:
            raise RuntimeError('Winnow process identity/arguments unqualified')
        return (pid, subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'lstart='], text=True).strip())

    def alive(self, identity):
        pid, started = identity
        return bool(started and subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='],
                         capture_output=True, text=True).stdout.strip() == started)

    async def ready(self, identity):
        try:
            async with ClientSession(timeout=ClientTimeout(total=5)) as session:
                async with session.get(f'http://127.0.0.1:{PORT}/v1/models',
                         headers={'Authorization': 'Bearer ' + KEY_FILE.read_text().strip()}) as response:
                    data = await response.json()
                    return response.status == 200 and self.alive(identity) and \
                        {m.get('id') for m in data.get('data', [])} == {UPSTREAM_ID}
        except Exception:
            return False

    async def start(self):
        await asyncio.to_thread(self.qualify)
        if self.probe() is not None:
            raise RuntimeError('Winnow already resident before start')
        argv = [sys.executable, str(ROOT / 'scripts/serve.py'), '--profile', 'apple-silicon',
                '--text-only', '--context', '65536', '--port', str(PORT),
                '--api-key-file', str(KEY_FILE)]
        log_fd = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            process = self.process = await asyncio.create_subprocess_exec(*argv, cwd=str(ROOT),
                       stdin=subprocess.DEVNULL, stdout=log_fd,
                       stderr=log_fd, start_new_session=True)
        finally:
            os.close(log_fd)
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            if process.returncode is not None:
                raise RuntimeError(f'Winnow exited during start: {process.returncode}')
            found = self.processes()
            if len(found) == 1 and found[0][0] == process.pid and \
               found[0][1][0] != str(BINARY) and str(ROOT / 'scripts/serve.py') in found[0][1]:
                await asyncio.sleep(1)  # Python launcher has not exec'd the pinned binary yet.
                continue
            identity = self.probe()
            if identity and identity[0] == process.pid and await self.ready(identity):
                return identity
            await asyncio.sleep(1)
        raise RuntimeError('Winnow readiness timeout; process identity unproven')

    async def stop(self):
        identity = self.probe()
        if identity is None:
            raise RuntimeError('Winnow disappeared before stop proof')
        os.kill(identity[0], 15)  # SIGTERM only; never force-kill an uncertain GPU workload.
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if not self.alive(identity):
                if self.process and self.process.pid == identity[0]:
                    await self.process.wait()
                    self.process = None
                if self.probe() is None:
                    return
                raise RuntimeError('Winnow replaced during stop')
            await asyncio.sleep(.25)
        raise RuntimeError('Winnow did not exit after SIGTERM')
