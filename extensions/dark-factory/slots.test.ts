import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { acquireSlot } from './slots.mjs';

const requests = root => readdirSync(join(root, 'queue')).filter(name => name.endsWith('.json'));
const occupied = root => readdirSync(root).filter(name => /^slot-\d+$/.test(name));
const owner = path => JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'factory-slots-'));
  const root = join(base, 'slots'), directory = join(base, 'run');
  const controller = new AbortController(), leases = [];
  mkdirSync(directory);
  t.after(() => {
    controller.abort();
    for (const lease of leases) lease.release();
    rmSync(base, { recursive: true, force: true });
  });
  return { root, directory, take(options = {}) {
    const result = acquireSlot(root, { directory, signal: controller.signal, ...options });
    result.then(lease => leases.push(lease), () => {});
    return result;
  } };
}

test('at most three leases; a queued fourth wakes after release', { timeout: 5000 }, async t => {
  const { root, directory, take } = fixture(t);
  const leases = await Promise.all([take(), take(), take()]);
  assert.deepEqual(leases.map(lease => lease.path), [0, 1, 2].map(i => join(root, `slot-${i}`)));
  for (const lease of leases) {
    assert.equal(owner(lease.path).pid, process.pid);
    assert.equal(owner(lease.path).directory, directory);
    assert.match(owner(lease.path).token, /^[\da-f-]{36}$/);
  }
  let granted = false;
  const fourth = take().then(lease => { granted = true; return lease; });
  await setImmediate();
  assert.equal(granted, false);
  assert.equal(requests(root).length, 1);
  assert.equal(occupied(root).length, 3);
  leases[1].release();
  const next = await fourth;
  assert.equal(next.path, leases[1].path);
  assert.equal(occupied(root).length, 3);
  assert.deepEqual(requests(root), []);
});

test('FIFO prevents a finishing lane from overtaking older queued requests', { timeout: 5000 }, async t => {
  const { root, take } = fixture(t);
  const holder = await take({ limit: 1 });
  const admission = [];
  const older = take({ limit: 1 }).then(lease => { admission.push('older'); return lease; });
  const second = take({ limit: 1 }).then(lease => { admission.push('second'); return lease; });
  holder.release();
  const reacquirer = take({ limit: 1 }).then(lease => { admission.push('reacquirer'); return lease; });
  assert.equal(requests(root).length, 3);
  const firstLease = await older;
  assert.deepEqual(admission, ['older']);
  firstLease.release();
  const secondLease = await second;
  assert.deepEqual(admission, ['older', 'second']);
  secondLease.release();
  await reacquirer;
  assert.deepEqual(admission, ['older', 'second', 'reacquirer']);
});

test('pending and already-aborted signals cancel without requests; granted leases survive abort', { timeout: 5000 }, async t => {
  const { root, directory, take } = fixture(t);
  const already = new AbortController();
  already.abort();
  await assert.rejects(acquireSlot(root, { directory, signal: already.signal }), { name: 'AbortError' });
  assert.equal(existsSync(root), false);
  const grantedSignal = new AbortController();
  const holder = await take({ limit: 1, signal: grantedSignal.signal });
  grantedSignal.abort();
  assert.ok(existsSync(holder.path));
  const cancel = new AbortController();
  t.after(() => cancel.abort());
  const pending = take({ limit: 1, signal: cancel.signal });
  assert.equal(requests(root).length, 1);
  cancel.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(readdirSync(join(root, 'queue')), []);
  const next = take({ limit: 1 });
  holder.release();
  await next;
  assert.deepEqual(requests(root), []);
});

test('the parent-reserved slot remains occupied even when its owner PID is dead', { timeout: 5000 }, async t => {
  const { root, directory, take } = fixture(t);
  const reserved = join(root, 'slot-0');
  mkdirSync(reserved, { recursive: true });
  const record = { pid: spawnSync(process.execPath, ['-e', '']).pid, directory, token: randomUUID() };
  assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
  writeFileSync(join(reserved, 'owner.json'), JSON.stringify(record));
  const leases = await Promise.all([take(), take()]);
  assert.deepEqual(leases.map(lease => lease.path), [join(root, 'slot-1'), join(root, 'slot-2')]);
  let granted = false;
  const pending = take().then(lease => { granted = true; return lease; });
  await setImmediate();
  assert.equal(granted, false);
  assert.deepEqual(owner(reserved), record);
  // Only the parent explicitly releases its reserved slot.
  unlinkSync(join(reserved, 'owner.json'));
  rmdirSync(reserved);
  assert.equal((await pending).path, reserved);
});

test('release is idempotent and cannot remove a replacement or mismatched owner', async t => {
  const { root, directory, take } = fixture(t);
  const old = await take({ limit: 1 });
  const oldToken = owner(old.path).token;
  old.release(); old.release();
  assert.equal(existsSync(old.path), false);
  const replacement = await take({ limit: 1 });
  assert.notEqual(owner(replacement.path).token, oldToken);
  old.release();
  assert.ok(existsSync(replacement.path));
  replacement.release();
  for (const patch of [{ token: randomUUID() }, { pid: process.pid + 1 }, { directory: join(directory, 'other') }]) {
    const lease = await take({ limit: 1 });
    const foreign = { ...owner(lease.path), ...patch };
    writeFileSync(join(lease.path, 'owner.json'), JSON.stringify(foreign));
    lease.release(); lease.release();
    assert.deepEqual(owner(lease.path), foreign);
    rmSync(lease.path, { recursive: true });
  }
  assert.deepEqual(occupied(root), []);
});

test('a dead pending controller request is safe to prune, unlike an occupied slot', { timeout: 5000 }, async t => {
  const { root, directory, take } = fixture(t);
  const holder = await take({ limit: 1 });
  const token = randomUUID(), pid = spawnSync(process.execPath, ['-e', '']).pid;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const stale = join(root, 'queue', `000000000000000000000000-${token}.json`);
  writeFileSync(stale, JSON.stringify({ pid, directory, token }));
  const next = take({ limit: 1 });
  assert.equal(existsSync(stale), false);
  assert.equal(requests(root).length, 1);
  holder.release();
  await next;
});

test('independent processes share the three-slot cap and FIFO queue', { timeout: 5000 }, async t => {
  const { root, directory, take } = fixture(t);
  const holders = await Promise.all([take(), take(), take()]);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireSlot } from ${JSON.stringify(new URL('./slots.mjs', import.meta.url).href)};
    const pending = acquireSlot(process.argv[1], { directory: process.argv[2], limit: 3 });
    process.send({ state: 'queued' });
    const lease = await pending;
    process.on('message', message => {
      if (message === 'release') { lease.release(); process.disconnect(); }
    });
    process.send({ state: 'granted', path: lease.path });
  `, root, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  });
  assert.equal((await once(child, 'message'))[0].state, 'queued');
  assert.equal(requests(root).length, 1);
  const grantedMessage = once(child, 'message');
  holders[0].release();
  let overtook = false;
  const reacquirer = take().then(lease => { overtook = true; return lease; });
  const [message] = await grantedMessage;
  assert.equal(message.state, 'granted');
  assert.equal(overtook, false);
  assert.equal(owner(message.path).pid, child.pid);
  assert.equal(occupied(root).length, 3);
  child.send('release');
  await reacquirer;
  assert.deepEqual(await exited, [0, null]);
});

test('an acquisition error removes its own request and temporary file', async t => {
  const { root, directory, take } = fixture(t);
  await take({ limit: 1 });
  const corrupt = join(root, 'queue', `000000000000000000000000-${randomUUID()}.json`);
  writeFileSync(corrupt, JSON.stringify({ pid: 0, directory, token: 'invalid' }));
  await assert.rejects(take({ limit: 1 }), /Invalid queued slot request/);
  assert.deepEqual(readdirSync(join(root, 'queue')), [corrupt.split('/').at(-1)]);
  unlinkSync(corrupt);
  for (const options of [{ limit: 0 }, { limit: 1.5 }, { directory: 'relative' }]) {
    await assert.rejects(take(options));
    assert.deepEqual(readdirSync(join(root, 'queue')), []);
  }
});
