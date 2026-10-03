import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { observe } from './watch.mjs';

function pendingHead(queue) {
  for (const name of readdirSync(queue).filter(name => /^\d{24}-[\da-f-]{36}\.json$/.test(name)).sort()) {
    const path = join(queue, name);
    let owner;
    try { owner = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !isAbsolute(owner.directory ?? '') || typeof owner.token !== 'string' || !owner.token) {
      throw Error(`Invalid queued slot request: ${path}`);
    }
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') { rmSync(path, { force: true }); continue; }
      if (error.code !== 'EPERM') throw error;
    }
    return path;
  }
}

function lease(path, owner) {
  let released = false;
  return { path, release() {
    if (released) return;
    const file = join(path, 'owner.json');
    let current;
    try { current = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') { released = true; return; } throw error; }
    if (current?.token === owner.token && current.pid === owner.pid && current.directory === owner.directory) {
      unlinkSync(file);
      rmdirSync(path);
    }
    released = true;
  } };
}

export async function acquireSlot(root, { directory, limit = 3, signal } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof directory !== 'string' || !isAbsolute(directory)) {
    throw Error('Slot root and owning directory must be absolute paths');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw Error('Slot limit must be a positive integer');
  signal?.throwIfAborted();
  const queue = join(root, 'queue');
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, directory, token: randomUUID() };
  // Host-local monotonic stamps order requests without a crash-prone scheduler lock.
  const request = join(queue, `${process.hrtime.bigint().toString().padStart(24, '0')}-${owner.token}.json`);
  const temporary = join(queue, `.${owner.token}.tmp`);

  return new Promise((resolve, reject) => {
    const watchers = [];
    let done = false, granted;
    const abort = () => fail(signal.reason);
    function close() {
      signal?.removeEventListener('abort', abort);
      for (const watcher of watchers) watcher.close();
    }
    function removeRequest() {
      rmSync(request, { force: true });
      rmSync(temporary, { force: true });
    }
    function fail(error) {
      if (done) return;
      done = true;
      close();
      try { removeRequest(); }
      catch (cleanupError) { error = new AggregateError([error, cleanupError], 'Could not remove slot request'); }
      try { granted?.release(); }
      catch (cleanupError) { error = new AggregateError([error, cleanupError], 'Could not release unreturned slot'); }
      reject(error);
    }
    function check() {
      if (done) return;
      try {
        signal?.throwIfAborted();
        if (pendingHead(queue) !== request) return;
        for (let i = 0; i < limit; i++) {
          const path = join(root, `slot-${i}`);
          try { mkdirSync(path, { mode: 0o700 }); }
          catch (error) { if (error.code === 'EEXIST') continue; throw error; }
          try {
            // Publish the already complete record atomically, with no overwrite or partial JSON.
            linkSync(request, join(path, 'owner.json'));
          } catch (error) {
            // Only remove an empty directory: never erase an unexpected owner.
            try { rmdirSync(path); } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], 'Could not clean failed slot claim');
            }
            throw error;
          }
          granted = lease(path, owner);
          removeRequest();
          close();
          done = true;
          resolve(granted);
          return;
        }
      } catch (error) { fail(error); }
    }
    try {
      signal?.addEventListener('abort', abort, { once: true });
      // Both watches precede publication and the deciding check, so release/admission cannot be missed.
      for (const path of [root, queue]) watchers.push(observe(path, check, fail));
      signal?.throwIfAborted();
      writeFileSync(temporary, JSON.stringify(owner, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, request);
      check();
    } catch (error) { fail(error); }
  });
}
