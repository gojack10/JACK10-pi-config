"""Maintenance command behavior, without launchd or a model."""
from types import SimpleNamespace
import unittest
import urllib.error
from unittest.mock import patch

import local_ai


class MaintenanceTests(unittest.TestCase):
    def test_stop_requires_confirmed_engine_shutdown_before_stopping_panel(self):
        events = []
        def request(*args):
            events.append('engines-off')
            return {'status': 'maintenance', 'engines': 'off'}
        def ctl(*args):
            events.append(args[0])
            return SimpleNamespace(returncode=0)
        with patch.object(local_ai, 'proxy_pid', return_value=123), \
             patch.object(local_ai, 'panel_off', return_value=True), \
             patch.object(local_ai, 'request', request), patch.object(local_ai, 'ctl', ctl), \
             patch.object(local_ai, 'engines_off'), patch('builtins.print'):
            local_ai.stop()
        self.assertEqual(events, ['engines-off', 'bootout'])
        with patch.object(local_ai, 'proxy_pid', return_value=123), \
             patch.object(local_ai, 'request', side_effect=RuntimeError('busy')), \
             patch.object(local_ai, 'ctl') as ctl:
            with self.assertRaisesRegex(RuntimeError, 'busy'):
                local_ai.stop()
            ctl.assert_not_called()

    def test_start_waits_for_a_newly_launched_panel_without_restarting_it(self):
        with patch.object(local_ai, 'proxy_pid', return_value=123), \
             patch.object(local_ai, 'request', side_effect=[
                 urllib.error.URLError(ConnectionRefusedError()), {'status': 'ok'}]) as request, \
             patch.object(local_ai.time, 'sleep'), patch.object(local_ai, 'ctl') as ctl, \
             patch('builtins.print'):
            local_ai.start()
        self.assertEqual(request.call_count, 2)
        ctl.assert_not_called()

    def test_start_opens_reception_without_requesting_a_model(self):
        calls = []
        def request(path, method='GET'):
            calls.append((path, method))
            return {'status': 'maintenance'}
        with patch.object(local_ai, 'proxy_pid', return_value=None), \
             patch.object(local_ai, 'engines_off'), patch.object(local_ai, 'request', request), \
             patch.object(local_ai, 'ctl', return_value=SimpleNamespace(returncode=0)), \
             patch('builtins.print'):
            local_ai.start()
        self.assertEqual(calls, [('/health', 'GET'), ('/admin/api/resume', 'POST')])
