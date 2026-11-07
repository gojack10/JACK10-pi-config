"""Serialized DS4 streaming and native completion. No paused main or borrower."""
import asyncio
import hashlib
import json
import logging
import os
import secrets
import subprocess
import time
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, web
from native_files import private_file, publish

MAX_WAIT = 90
MAIN_TASK = None  # Native cleanup survives a disconnected HTTP waiter.


async def until(read, description, seconds=MAX_WAIT):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = read()
        if result is not None:
            return result
        await asyncio.sleep(.02)
    raise RuntimeError(f'{description} not established; admission retained')


class FileEngine:
    """One qualified DS4 process. Reused until that process exits or changes."""
    def __init__(self, control, pid, log, binary, *, expected_sha,
                 terminal_only=False, shutdown_only=False):
        self.control, self.pid = Path(control), int(pid)
        self.log, self.binary = Path(log), Path(binary)
        self.terminal_only, self.shutdown_only = terminal_only, shutdown_only
        self.ticket = 0
        self.terminal_ticket = None
        self.binding = None
        self.log_offset = 0
        self.started = subprocess.run(['/bin/ps', '-p', str(self.pid), '-o', 'lstart='],
            capture_output=True, text=True, check=True).stdout.strip()
        if not self.started:
            raise RuntimeError('native process start unknown')
        engine = json.loads(private_file(self.control / 'terminal-engine').read_text())
        if engine.get('pid') != self.pid or engine.get('supported') != 1:
            raise RuntimeError('DS4 native gate not qualified')
        self.incarnation = engine['engine']
        if hashlib.sha256(self.binary.read_bytes()).hexdigest() != expected_sha:
            raise RuntimeError('DS4 build pin mismatch')
        command = subprocess.run(['/bin/ps', '-p', str(self.pid), '-o', 'command='],
                                 capture_output=True, text=True, check=True).stdout.strip()
        if not command.startswith(str(self.binary) + ' '):
            raise RuntimeError('native PID is not the pinned binary')
        # Ordinary adoption cannot reconstruct an earlier controller's ownership.
        # Maintenance may issue a fresh one-way shutdown, but never reopen it.
        for name in ('terminal-ack', 'ack'):
            path = self.control / name
            if not path.exists():
                continue
            if not shutdown_only:
                raise RuntimeError('old control receipts without process-lifetime controller')
            row = json.loads(private_file(path).read_text())
            if row.get('pid') != self.pid:
                raise RuntimeError('Foreign shutdown receipt')
            for field in ('serial', 'ticket'):
                value = row.get(field, 0)
                if not str(value).isascii() or not str(value).isdecimal():
                    raise RuntimeError('Invalid shutdown receipt serial')
                self.ticket = max(self.ticket, int(value))

    def begin_request(self):
        """Reset request-local evidence, not process qualification or serials."""
        if self.shutdown_only or self.terminal_ticket is not None:
            raise RuntimeError('native admission is closed')
        self.binding = None
        self.log_offset = self.log.stat().st_size

    @staticmethod
    def fields(line):
        return dict(item.split('=', 1) for item in line.split()[1:] if '=' in item)

    def _binding(self, request_id):
        prefix = 'FREEZE_REQUEST ' if self.terminal_only else 'FREEZE_BIND '
        with self.log.open() as stream:
            stream.seek(self.log_offset)
            rows = [self.fields(line) for line in stream if line.startswith(prefix)]
        rows = [row for row in rows if row.get('request') == request_id]
        if len(rows) != 1 or int(rows[0]['pid']) != self.pid:
            return None
        return dict(rows[0], engine=self.incarnation)

    async def bind(self, request_id):
        self.binding = await until(lambda: self._binding(request_id), 'native request binding')
        return self.binding

    def alive(self):
        return subprocess.run(['/bin/ps', '-p', str(self.pid), '-o', 'lstart='],
            capture_output=True, text=True).stdout.strip() == self.started

    def receipt(self, predicate):
        path = self.control / 'terminal-ack'
        if not path.exists():
            return None
        row = json.loads(private_file(path).read_text())
        return row if predicate(row) else None

    async def terminal(self):
        if self.terminal_ticket is not None:
            raise RuntimeError('native gate already closed')
        # A disconnect can beat reader/job cleanup. Only the native all-zero
        # busy rejection is retryable; it is not evidence of completion.
        engine = self.incarnation
        number = self.ticket + 1
        ticket = number
        self.control.joinpath('terminal-ack').unlink(missing_ok=True)
        def cmd(serial, action):
            self.ticket = serial
            publish(self.control, 'terminal', f'{self.pid} {engine} {serial} {ticket} {action}\n')
        def match(serial, action):
            return self.receipt(lambda r: r.get('pid') == self.pid and
                r.get('engine') == engine and r.get('serial') == str(serial) and
                r.get('ticket') == str(ticket) and r.get('action') == action)
        def close_when_idle():
            nonlocal number
            ack = match(number, 'close')
            if ack is None or ack.get('ok') == 1:
                return ack
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
            ('ok', 'admission_closed', 'closed', 'clean')) and all(type(fresh.get(k)) is int and fresh[k] == 0
            for k in ('failed', 'outstanding', 'retired')) and fresh.get('submitted') == fresh.get('completed') == first.get('submitted') and \
            fresh.get('keepalive_submitted') == fresh.get('keepalive_completed')
        if not good or not self.alive():
            raise RuntimeError('unclean native terminal; admission retained')
        self.terminal_ticket = ticket
        return fresh

    async def release_terminal(self):
        if self.shutdown_only:
            raise RuntimeError('Shutdown-only recovery cannot reopen native admission')
        if self.terminal_ticket is None:
            raise RuntimeError('no terminal close to release')
        self.ticket += 1
        serial = self.ticket
        publish(self.control, 'terminal', f'{self.pid} {self.incarnation} {serial} {self.terminal_ticket} release\n')
        await until(lambda: self.receipt(lambda r: r.get('pid') == self.pid and
            r.get('engine') == self.incarnation and r.get('serial') == str(serial) and
            r.get('ticket') == str(self.terminal_ticket) and r.get('action') == 'release' and r.get('ok') == 1),
            'terminal release')
        self.terminal_ticket = None


def unavailable(request, reason):
    raise web.HTTPServiceUnavailable(text=json.dumps(dict(admitted=False,
        request_id=request.headers.get('X-Pi-Request-Id') or secrets.token_hex(12), reason=reason)),
        content_type='application/json')


async def handle_main(request, body, backend_name, model_id,
                      begin_request, finish_request, backend, response_stream=None):
    global MAIN_TASK
    from managed_switch import MODELS
    request_id = request.headers.get('X-Pi-Request-Id')
    try:
        payload = json.loads(body)
    except (ValueError, TypeError):
        raise web.HTTPBadRequest(text='Expected JSON request')
    port = os.getenv('LOCAL_PROXY_DS4_PORT', '8001')
    if backend != f'http://127.0.0.1:{port}/v1':
        unavailable(request, 'native_reservation_adapter_unavailable')
    if backend_name != 'ds4' or model_id not in MODELS or \
       not isinstance(payload, dict) or payload.get('stream') is not True or \
       payload.get('temperature', 0) != 0 or not request_id or len(request_id) > 128 or \
       not all(c.isascii() and (c.isalnum() or c in '-_') for c in request_id):
        unavailable(request, 'unsupported_native_reservation_path')
    engine = await begin_request(backend_name, model_id, request, managed=True)
    queue = asyncio.Queue(maxsize=128)
    disconnected = forwarding = False

    def disconnect():
        nonlocal disconnected
        disconnected = True
        if forwarding:
            forward_task.cancel()  # Close upstream now, not the native cleanup task below.
        while not queue.empty():
            queue.get_nowait()

    async def forward():
        nonlocal forwarding
        terminal_output = b''
        try:
            try:
                engine.begin_request()
                forwarding = True
                if disconnected:
                    raise asyncio.CancelledError()
                async with ClientSession(timeout=ClientTimeout(total=None, sock_connect=10)) as session:
                    headers = dict(Authorization=request.headers.get('Authorization') or
                                   'Bearer ' + (Path(__file__).parent / '.proxy-key').read_text().strip(),
                                   **{'X-Pi-Request-Id': request_id, 'Content-Type': 'application/json'})
                    for name in ('X-Pi-Origin', 'X-Pi-Live-Answer'):
                        if value := request.headers.get(name):
                            headers[name] = value
                    async with session.post(backend + '/chat/completions', data=body, headers=headers) as upstream:
                        if upstream.status != 200 or upstream.content_type != 'text/event-stream':
                            raise RuntimeError(f'unqualified upstream response {upstream.status}/{upstream.content_type}')
                        await engine.bind(request_id)
                        async for chunk in upstream.content.iter_any():
                            if not disconnected:
                                output = response_stream.feed(chunk) if response_stream else chunk
                                if output:
                                    await queue.put(output)
                        if response_stream and not disconnected:
                            terminal_output = response_stream.finish()
            except asyncio.CancelledError:
                if not disconnected:
                    raise
            except Exception as error:
                if response_stream is None:
                    raise
                terminal_output = response_stream.fail(error)
            finally:
                forwarding = False
            # EOF and socket cancellation are not GPU completion. All models
            # use the same post-unwind native close/status/release sequence.
            await engine.terminal()
            await engine.release_terminal()
            await finish_request(backend_name, release_chat=disconnected or
                                 bool(response_stream and response_stream.release_chat))
            if terminal_output and not disconnected:
                await queue.put(terminal_output)
        except BaseException as error:
            logging.getLogger('local-proxy').exception('Native request %s remains blocked', request_id)
            if response_stream and not disconnected:
                await queue.put(response_stream.fail(error, terminal_failure=True))
            await finish_request(backend_name, uncertain=True)
        finally:
            await queue.put(None)

    forward_task = MAIN_TASK = asyncio.create_task(forward())
    response = web.StreamResponse(headers={'Content-Type': 'text/event-stream',
                           'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
                           'x-request-id': request_id})
    try:
        await response.prepare(request)
        if response_stream:
            await response.write(response_stream.start())
        last_write = time.monotonic()
        while True:
            if request.transport is None or request.transport.is_closing():
                disconnect()
                break
            try:
                chunk = await asyncio.wait_for(queue.get(), .1)
            except asyncio.TimeoutError:
                if response_stream and time.monotonic() - last_write >= 15:
                    # Codex times out between parsed SSE events, so comments
                    # alone cannot keep a long prefill or generation connected.
                    await response.write(b'event: ping\ndata: {"type":"ping"}\n\n')
                    last_write = time.monotonic()
                continue
            if chunk is None:
                break
            await response.write(chunk)
            last_write = time.monotonic()
        if not disconnected:
            await response.write_eof()
        return response
    except (ConnectionError, asyncio.CancelledError):
        disconnect()
        raise
