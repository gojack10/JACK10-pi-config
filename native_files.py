"""Owner-only files shared by native control clients and engine workers."""
import os
from pathlib import Path
import secrets


def private_file(path):
    path = Path(path)
    st = path.lstat()
    if not path.is_file() or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise RuntimeError(f'untrusted control file {path}')
    return path


def publish(directory, name, content):
    directory = Path(directory)
    st = directory.lstat()
    if not directory.is_dir() or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise RuntimeError('untrusted control directory')
    tmp = directory / ('.' + name + '.' + secrets.token_hex(8))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, directory / name)
    finally:
        tmp.unlink(missing_ok=True)
