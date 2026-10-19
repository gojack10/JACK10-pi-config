"""Reproduce the isolated engine from a retained exact-commit archive; never load MLX.

uv run --no-project --python 3.13 python startlux-service/provision.py /path/upstream.tar.gz
Weights must already match model-pin.json. No service/process operations or secret reads.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

SERVICE = Path(__file__).resolve().parent
ROOT = Path.home() / '.local/share/startlux/source-83fe6c7'
COMMIT = '83fe6c7d61a687a6e17f118b4f7d8f429f5d3a01'
ARCHIVE_SHA = '2371a95403a64960ebbd8ad59370342eca3344a9e0cb19a71633ba70f0f442ea'
PYTHON = '/nix/store/kwnbzccaiqi6iwdchcy6xc8br4x9hn0j-python3-3.13.12/bin/python3.13'


def record(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(chunk)
    return {'bytes': path.stat().st_size, 'sha256': h.hexdigest()}


def sources(root):
    return {'pyproject.toml': record(root / 'pyproject.toml'), **{
        str(p.relative_to(root)): record(p) for p in sorted((root / 'startlux_decide').rglob('*.py'))}}


def main():
    archive = Path(sys.argv[1]).resolve()
    if record(archive)['sha256'] != ARCHIVE_SHA:
        raise RuntimeError('Unqualified upstream archive')
    model = json.loads((SERVICE / 'model-pin.json').read_text())
    for name, expected in model['files'].items():
        if record(Path(model['folder']) / name) != expected:
            raise RuntimeError('Unqualified model file: ' + name)
    with tempfile.TemporaryDirectory(prefix='startlux-provision-') as temp:
        with tarfile.open(archive) as tar:
            tar.extractall(temp, filter='data')
        upstream, = Path(temp).iterdir()
        subprocess.run(['/usr/bin/patch', '-p1', '-i', str(SERVICE / 'managed.patch')], cwd=upstream, check=True)
        shutil.copyfile(SERVICE / 'managed.py', upstream / 'startlux_decide/managed.py')
        expected = sources(upstream)
        if ROOT.exists():
            if '--update-managed' in sys.argv[2:]:
                # Only the guard and Metal boundary/diagnostic patch may change.
                # Refuse unknown drift; retain the prior pin as rollback evidence.
                previous = json.loads((SERVICE / 'pin.json').read_text())['source']
                actual = sources(ROOT)
                allowed = {'startlux_decide/managed.py', 'startlux_decide/backends/mlx.py'}
                if actual != previous or {k:v for k,v in actual.items() if k not in allowed} != {k:v for k,v in expected.items() if k not in allowed}:
                    raise RuntimeError('Existing upstream differs outside pinned managed boundary')
                for name in allowed:
                    shutil.copyfile(upstream / name, ROOT / name)
            elif sources(ROOT) != expected:
                raise RuntimeError('Existing upstream source differs; refusing overwrite')
        else:
            ROOT.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(upstream, ROOT)
    subprocess.run(['uv', 'sync', '--project', str(SERVICE), '--locked', '--python', PYTHON,
                    '--reinstall-package', 'startlux-decide'], check=True)
    python = SERVICE / '.venv/bin/python'
    metadata = json.loads(subprocess.check_output([str(python), '-I', '-c',
        'import importlib.metadata as m,json,sys,sysconfig; print(json.dumps({"python_version":sys.version,'
        '"prefix":sys.base_prefix,"site":sysconfig.get_path("purelib"),'
        '"packages":{d.metadata["Name"]:d.version for d in m.distributions()}}))'], text=True))
    installed = Path(metadata.pop('site'))
    for name, expected_file in expected.items():
        if name != 'pyproject.toml' and record(installed / name) != expected_file:
            raise RuntimeError('Installed upstream mismatch: ' + name)
    files = [p for p in (SERVICE / '.venv').rglob('*')
             if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc']
    files += [SERVICE / n for n in ('pyproject.toml', 'uv.lock', 'managed.py', 'managed.patch',
                                   'model-pin.json', 'provision.py', 'swap-cpu')]
    environment = {str(p.relative_to(SERVICE)): record(p) for p in sorted(files)}
    pin = {'schema': 1, 'upstream': {'commit': COMMIT, 'archive_sha256': ARCHIVE_SHA},
           'model': model, 'source': expected, 'environment': environment,
           'interpreter': {'path': str(python.resolve()), **record(python)}, **metadata}
    (SERVICE / 'pin.json').write_text(json.dumps(pin, indent=2) + '\n')
    print(json.dumps({'pin': str(SERVICE / 'pin.json'), 'source_files': len(expected),
                      'environment_files': len(environment), 'interpreter': pin['interpreter'],
                      'python_version': pin['python_version'], 'packages': pin['packages']}))


if __name__ == '__main__':
    main()
