"""Manage local inference: local-ai unload | stop | start | status | restart [-- command ...]."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import plistlib
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
RESTART_LABEL = 'com.local.llm.restart'
RESTART_JOB = DOMAIN + '/' + RESTART_LABEL
RESTART_PLIST = HOME / '.dsv4/local-ai-restart.plist'
RESTART_LOG = HOME / '.dsv4/local-ai-restart.log'


def ctl(*args):
    return subprocess.run(['/bin/launchctl', *args], capture_output=True, text=True)


def proxy_pid():
    match = re.search(r'^\s*pid = (\d+)', ctl('print', PROXY).stdout, re.M)
    return int(match[1]) if match else None


def request(path, method='GET'):
    key = (HOME / '.pi/agent/.proxy-key').read_text().strip()
    req = urllib.request.Request('http://127.0.0.1:8002' + path, method=method,
                                 headers={'Authorization': 'Bearer ' + key})
    timeout = None if path == '/admin/api/unload' else 5 if path == '/health' else 300
    with urllib.request.urlopen(req, timeout=timeout) as response:
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


def unload():
    print('Cancelling any active generation, then unloading managed engines...', flush=True)
    result = request('/admin/api/unload', 'POST')
    if result != {'status': 'ok', 'engines': 'off'}:
        raise RuntimeError('Proxy did not confirm that all managed engines are off')
    print('All managed engines off. The proxy is ready for the next model request.')


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


def run_restart(command):
    # A refused/partial stop must not reopen admission over uncertain engines.
    stop()
    try:
        if command:
            subprocess.run(command, check=True)
    finally:
        # Even a failed promotion must attempt to restore reception. start()
        # still requires engines off; executable qualification is unchanged.
        start()
    print('Restart complete.')


def restart(command):
    RESTART_PLIST.parent.mkdir(parents=True, exist_ok=True)
    with (RESTART_PLIST.parent / 'local-ai-restart.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another restart is being scheduled') from None
        previous = ctl('print', RESTART_JOB)
        if previous.returncode == 0:
            if (re.search(r'^\s*pid = \d+', previous.stdout, re.M)
                    or not re.search(r'^\s*last exit code = ', previous.stdout, re.M)):
                raise RuntimeError(f'Restart already pending/running; see {RESTART_LOG}')
            result = ctl('bootout', RESTART_JOB)
            if result.returncode:
                raise RuntimeError(result.stderr)
        RESTART_LOG.touch(mode=0o600)
        RESTART_LOG.write_text('')
        spec = {
            'Label': RESTART_LABEL,
            'ProgramArguments': [str(HOME / '.pi/agent/local-ai'), '_restart', '--', *command],
            'WorkingDirectory': os.getcwd(),
            'EnvironmentVariables': {
                'HOME': str(HOME), 'PATH': os.environ['PATH'], 'PYTHONUNBUFFERED': '1',
            },
            'RunAtLoad': True,
            'KeepAlive': False,
            'StandardOutPath': str(RESTART_LOG),
            'StandardErrorPath': str(RESTART_LOG),
        }
        RESTART_PLIST.touch(mode=0o600)
        RESTART_PLIST.write_bytes(plistlib.dumps(spec))
        result = ctl('bootstrap', DOMAIN, str(RESTART_PLIST))
        if result.returncode:
            raise RuntimeError(result.stderr)
    print(f'Local-inference restart queued; not yet complete. Log: {RESTART_LOG}')
    print('Use local-ai status for the outcome. The independent Codex cloud gateway stays available.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('unload', 'stop', 'start', 'status', 'restart', '_restart'),
                        metavar='{unload,stop,start,status,restart}')
    parser.add_argument('command', nargs=argparse.REMAINDER,
                        help='optional command to run with engines off during restart')
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if command and args.action not in ('restart', '_restart'):
        parser.error('Only restart accepts a command')
    try:
        if args.action == 'status':
            state = ctl('print', RESTART_JOB)
            if state.returncode == 0:
                exit_code = re.search(r'^\s*last exit code = (\d+)', state.stdout, re.M)
                running = re.search(r'^\s*pid = \d+', state.stdout, re.M)
                outcome = f'exit {exit_code[1]}' if exit_code and not running else 'pending/running'
                print(f'Restart: {outcome}. Log: {RESTART_LOG}')
            print(json.dumps(request('/health'), indent=2) if proxy_pid() else 'Panel off.')
        elif args.action == 'restart':
            restart(command)
        elif args.action == '_restart':
            run_restart(command)
        else:
            globals()[args.action]()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors='replace').strip()
        parser.exit(1, f'local-ai: HTTP {exc.code}: {detail or exc.reason}\n')
    except Exception as exc:
        parser.exit(1, f'local-ai: {exc}\n')


if __name__ == '__main__':
    main()
