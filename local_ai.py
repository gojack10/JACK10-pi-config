"""Maintenance switch: local-ai stop | start | status. Never loads a model."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request

HOME = Path.home()
DOMAIN = f'gui/{os.getuid()}'
PROXY = DOMAIN + '/com.local.llm.proxy'
PLIST = HOME / 'Library/LaunchAgents/com.local.llm.proxy.plist'
MAINTENANCE_FILE = HOME / '.dsv4/maintenance'


def ctl(*args):
    return subprocess.run(['/bin/launchctl', *args], capture_output=True, text=True)


def proxy_pid():
    match = re.search(r'^\s*pid = (\d+)', ctl('print', PROXY).stdout, re.M)
    return int(match[1]) if match else None


def request(path, method='GET'):
    key = (HOME / '.pi/agent/.proxy-key').read_text().strip()
    req = urllib.request.Request('http://127.0.0.1:8002' + path, method=method,
                                 headers={'Authorization': 'Bearer ' + key})
    with urllib.request.urlopen(req, timeout=5 if path == '/health' else 300) as response:
        return json.load(response)


def engines_off():
    from managed_switch import service_pid, mlx_lane_busy
    from mlx_runtime import MLXRuntime
    from startlux_runtime import StartLuxRuntime
    import swap_policy
    if (service_pid() or mlx_lane_busy() or MLXRuntime().probe() or StartLuxRuntime().processes()
            or swap_policy.port_listening(8001) or swap_policy.port_listening(8091)):
        raise RuntimeError('Engines are not all off; complete maintenance stop first')


def panel_off():
    import swap_policy
    return proxy_pid() is None and not swap_policy.port_listening(8002)


def stop():
    if proxy_pid():
        result = request('/admin/api/maintenance', 'POST')
        if result != {'status': 'maintenance', 'engines': 'off'}:
            raise RuntimeError('Proxy did not confirm complete maintenance shutdown')
    else:
        engines_off()
        MAINTENANCE_FILE.touch(mode=0o600)
    # Native acknowledgements and engine process exit precede panel shutdown.
    result = ctl('bootout', PROXY)
    if result.returncode and ctl('print', PROXY).returncode == 0:
        raise RuntimeError(result.stderr)
    deadline = time.monotonic() + 90
    while not panel_off() and time.monotonic() < deadline:
        time.sleep(.1)
    if not panel_off():
        raise RuntimeError('Proxy did not exit; no forced kill')
    engines_off()
    print('Maintenance: panel off, all engines off.')


def wait_for_panel():
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            return request('/health')
        except urllib.error.URLError as exc:
            if not isinstance(exc.reason, (ConnectionRefusedError, TimeoutError)):
                raise
            time.sleep(.2)
    raise RuntimeError('Panel did not become ready')


def start():
    if proxy_pid():
        state = wait_for_panel()
        if state.get('status') == 'ok':
            print('Panel already available; no engine started.')
            return
    engines_off()
    if ctl('print', PROXY).returncode:
        result = ctl('bootstrap', DOMAIN, str(PLIST))
        if result.returncode:
            raise RuntimeError(result.stderr)
    else:
        result = ctl('kickstart', PROXY)
        if result.returncode:
            raise RuntimeError(result.stderr)
    state = wait_for_panel()
    engines_off()
    if state.get('status') == 'maintenance':
        request('/admin/api/resume', 'POST')
    print('Panel waiting; all engines off. Your next model request selects the engine.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('stop', 'start', 'status'))
    action = parser.parse_args().action
    try:
        if action == 'status':
            print(json.dumps(request('/health'), indent=2) if proxy_pid() else 'Panel off.')
        else:
            globals()[action]()
    except Exception as exc:
        parser.exit(1, f'local-ai: {exc}\n')


if __name__ == '__main__':
    main()
