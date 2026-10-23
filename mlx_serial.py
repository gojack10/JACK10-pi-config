"""Serial mlx-lm serving with an idle-worker GPU completion handshake.

The gate runs on mlx-lm's only submitting thread, after generation and cache
updates. It synchronizes that worker's stream before acknowledging a close.
No retained borrowing, fabricated GPU counters, or patched MLX library.
"""
import json
import os
from pathlib import Path
import secrets
import threading

from native_files import private_file, publish


class SerialGate:
    def __init__(self, directory, synchronize):
        self.directory = Path(directory)
        self.synchronize = synchronize
        self.lock = threading.RLock()
        self.engine = secrets.token_hex(16)
        self.serial = self.ticket = 0
        self.closed = self.failed = False
        self.active = False
        self.initialized = False

    def identity(self):
        return dict(pid=os.getpid(), engine=self.engine)

    def admit(self):
        with self.lock:
            if not self.initialized or self.closed or self.failed or self.active:
                raise RuntimeError('MLX admission closed or occupied')
            self.active = True

    def finished(self):
        with self.lock:
            self.active = False

    def poll(self):
        # Called only by the serial generation worker between requests.
        with self.lock:
            if not self.initialized:
                self.synchronize()
                publish(self.directory, 'terminal-engine', json.dumps(self.identity()))
                self.initialized = True
            path = self.directory / 'terminal'
            if not path.exists():
                return self.closed
            command = json.loads(private_file(path).read_text())
            if (not isinstance(command, dict) or
                    any(command.get(k) != v for k, v in self.identity().items()) or
                    type(command.get('serial')) is not int or command['serial'] <= self.serial or
                    type(command.get('ticket')) is not int or command['ticket'] <= 0 or
                    command.get('action') not in ('close', 'status', 'release')):
                return self.closed
            self.serial = command['serial']
            action, ticket = command['action'], command['ticket']
            ok = False
            if action == 'close' and not self.active and not self.closed and not self.failed:
                self.closed = True
                self.ticket = ticket
                try:
                    self.synchronize()
                    ok = True
                except Exception:
                    self.failed = True
            elif self.closed and ticket == self.ticket and not self.failed:
                if action == 'status':
                    ok = True
                elif action == 'release':
                    self.closed = False
                    ok = True
            publish(self.directory, 'terminal-ack', json.dumps(dict(
                **self.identity(), serial=self.serial, ticket=ticket, action=action,
                ok=ok, admission_closed=self.closed, synchronized=ok and not self.failed)))
            return self.closed


def validate_model(provider, model, checkpoint):
    """Apply upstream's aliases before checking the one-checkpoint boundary."""
    selected = provider._model_map.get(model.model, model.model)
    adapter = provider._adapter_map.get(model.model, model.adapter)
    draft = provider._draft_model_map.get(model.draft, model.draft)
    if (str(Path(selected).resolve()) != checkpoint or draft is not None or
            adapter is not None or provider.is_distributed):
        raise ValueError('Only the selected, single-device MLX model is permitted')


def main():
    import sys
    import time
    import mlx.core as mx
    from mlx_lm import server

    directory = os.environ['MLX_CONTROL_DIR']
    checkpoint = str(Path(sys.argv[sys.argv.index('--model') + 1]).resolve())
    key = private_file(os.environ['MLX_KEY_FILE']).read_text().strip()
    if not key:
        raise RuntimeError('Missing private MLX credential')

    class SerialGenerator(server.ResponseGenerator):
        def __init__(self, *args, **kwargs):
            self.gate = SerialGate(directory, lambda: mx.synchronize(mx.default_stream(mx.default_device())))
            super().__init__(*args, **kwargs)

        def _is_batchable(self, args):
            return False

        def _next_request(self, timeout=None):
            if self.gate.poll():
                time.sleep(.02)
                return None
            return super()._next_request(timeout=.1)

        def generate(self, request, args, *rest, **kwargs):
            validate_model(self.model_provider, args.model, checkpoint)
            self.gate.admit()
            return super().generate(request, args, *rest, **kwargs)

        def _serve_single(self, request, stream):
            try:
                return super()._serve_single(request, stream)
            finally:
                self.gate.finished()

    class PrivateHandler(server.APIHandler):
        def do_POST(self):
            if self.headers.get('Authorization') != 'Bearer ' + key:
                self.send_error(401)
                return
            super().do_POST()

    # Keep upstream tokenization, tools, streaming and prompt-cache behavior.
    def run(host, port, model_provider, **kwargs):
        if mx.distributed.init().size() != 1:
            raise RuntimeError('Managed MLX requires one device')
        generator = SerialGenerator(model_provider, server.LRUPromptCache(model_provider.cli_args.prompt_cache_size))
        server._run_http_server(host, port, generator, handler_class=PrivateHandler)

    server.run = run
    server.main()


if __name__ == '__main__':
    main()
