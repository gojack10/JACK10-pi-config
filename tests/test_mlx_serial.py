"""CPU-only checks of the admission/completion contract; no model imports."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from types import SimpleNamespace
from mlx_serial import SerialGate, validate_model
from native_files import publish


class GateTests(unittest.TestCase):
    def test_configured_default_draft_means_none_but_extra_engines_are_rejected(self):
        provider = SimpleNamespace(_model_map={'default_model': '/selected'},
            _adapter_map={'default_model': None}, _draft_model_map={'default_model': None},
            is_distributed=False)
        model = SimpleNamespace(model='/selected', draft='default_model', adapter=None)
        validate_model(provider, model, '/selected')
        for field, value in (('draft', '/extra-engine'), ('model', '/other'), ('adapter', '/adapter')):
            with self.subTest(field=field):
                changed = SimpleNamespace(**(vars(model) | {field: value}))
                with self.assertRaises(ValueError):
                    validate_model(provider, changed, '/selected')

    def test_warm_reuse_and_closed_admission_until_matching_release(self):
        with tempfile.TemporaryDirectory() as directory:
            sync = Mock()
            gate = SerialGate(directory, sync)
            gate.poll()
            identity = json.loads((Path(directory) / 'terminal-engine').read_text())
            def command(serial, ticket, action):
                publish(directory, 'terminal', json.dumps(dict(**identity, serial=serial, ticket=ticket, action=action)))
                gate.poll()
                return json.loads((Path(directory) / 'terminal-ack').read_text())
            for serial in (1, 4):
                gate.admit()
                with self.assertRaises(RuntimeError):
                    gate.admit()
                gate.finished()
                self.assertTrue(command(serial, serial, 'close')['synchronized'])
                with self.assertRaises(RuntimeError):
                    gate.admit()
                self.assertTrue(command(serial + 1, serial, 'status')['ok'])
                self.assertTrue(command(serial + 2, serial, 'release')['ok'])
            self.assertEqual(sync.call_count, 3)  # startup + two native closes

    def test_active_worker_and_stale_commands_never_grant_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            gate = SerialGate(directory, Mock())
            gate.poll()
            gate.admit()
            command = dict(**gate.identity(), serial=1, ticket=1, action='close')
            publish(directory, 'terminal', json.dumps(command))
            gate.poll()
            self.assertFalse(json.loads((Path(directory) / 'terminal-ack').read_text())['ok'])
            gate.finished()
            gate.poll()  # same serial cannot be replayed after finishing
            self.assertFalse(gate.closed)
            publish(directory, 'terminal', json.dumps(dict(command, engine='stale', serial=2)))
            gate.poll()
            self.assertFalse(gate.closed)

    def test_failed_native_sync_keeps_admission_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            gate = SerialGate(directory, Mock())
            gate.poll()
            gate.synchronize.side_effect = RuntimeError('GPU completion unknown')
            publish(directory, 'terminal', json.dumps(dict(**gate.identity(), serial=1, ticket=1, action='close')))
            gate.poll()
            receipt = json.loads((Path(directory) / 'terminal-ack').read_text())
            self.assertFalse(receipt['ok'])
            self.assertTrue(receipt['admission_closed'])
            with self.assertRaises(RuntimeError):
                gate.admit()
