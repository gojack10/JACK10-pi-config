import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoop, save, taskSettings } from './core.mjs';
import { profileInputs, suiteStatus, waitProfileInputs } from './parallel.mjs';

test('parallel reader lane retains one tree across context handoff, then advances without a planner', async () => {
  const d = mkdtempSync(join(tmpdir(), 'yc-read-'));
  try {
    const tasks = ['a', 'b'].map(id => ({ tree_id: id, root_id: `root-${id}`, instruction: 'mine', acceptance: 'coverage' }));
    const seen = [];
    await runLoop({ directory: d, smoke: false, assignments: tasks, project: taskSettings('yc-read-0'),
      runStep: async ({ role, task, previous }) => {
        seen.push(task.tree_id); assert.equal(role, 'worker');
        if (seen.length === 2) assert.ok(previous);
        if (task.tree_id === 'b') assert.equal(previous, null);
        const packet = join(d, `${task.tree_id}-packet.json`);
        save(packet, { tree_id: task.tree_id, root_id: task.root_id, outline_complete: true,
          content_read_ids: [task.root_id], findings: [], exclusions: [], remaining_work: [] });
        return { text: JSON.stringify({ version: 1, role, disposition: seen.length === 1 ? 'continue' : 'worked',
          tree_id: task.tree_id, tree_packet: packet, evidence: [packet], updated_nodes: [], summary: 'reviewed' }),
          receipt: { job: seen.length }, contextStopped: seen.length === 1 };
      } });
    assert.deepEqual(seen, ['a', 'a', 'b']);
    assert.equal(JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).status, 'reads_complete');
    assert.equal(JSON.parse(readFileSync(join(d, 'completed-trees.json'), 'utf8')).length, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('profile waits for reader receipts and suite completion requires exact population and both validated lanes', { timeout: 5000 }, async () => {
  const d = mkdtempSync(join(tmpdir(), 'yc-suite-'));
  try {
    const suite = { video: join(d, 'video'), profile: join(d, 'profile'), readers: [join(d, 'reader')], route: {} };
    for (const p of [suite.video, suite.profile, ...suite.readers]) mkdirSync(p);
    save(join(suite.readers[0], 'config.json'), { assignments: [{ tree_id: 'a' }, { tree_id: 'b' }] });
    save(join(suite.readers[0], 'state.json'), { status: 'running' });
    const waiting = waitProfileInputs(suite.profile, suite.readers);
    save(join(suite.readers[0], 'completed-trees.json'), [{ tree_id: 'a', tree_packet: '/packet' }]);
    const input = await waiting;
    assert.equal(input.pending.length, 1);
    assert.equal(suiteStatus(suite).completed, false);
    save(join(suite.readers[0], 'state.json'), { status: 'reads_complete' });
    save(join(suite.readers[0], 'finished.json'), { ok: true, completed: true });
    save(join(suite.profile, 'merged-trees.json'), [{ tree_id: 'a' }]);
    assert.equal(profileInputs(suite.profile, suite.readers).pending.length, 0);
    save(join(suite.video, 'state.json'), { status: 'running' });
    let finalAdmitted = false;
    const finalWait = waitProfileInputs(suite.profile, suite.readers, suite.video).then(input => {
      finalAdmitted = true; return input;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finalAdmitted, false);
    save(join(suite.video, 'state.json'), { status: 'video_ready' });
    assert.equal((await finalWait).videoReady, true);
    for (const [lane, status] of [[suite.video, 'video_ready'], [suite.profile, 'profile_ready']]) {
      save(join(lane, 'state.json'), { status }); save(join(lane, 'finished.json'), { ok: true, completed: true });
    }
    assert.equal(suiteStatus(suite).completed, false); // b has not been read or explicitly excluded.
    save(join(suite.readers[0], 'excluded-trees.json'), [{ tree_id: 'b' }]);
    assert.equal(suiteStatus(suite).status, 'ready_for_interview');
    assert.deepEqual(suiteStatus(suite).trees, { total: 2, read: 1, excluded: 1, merged: 1, remaining_to_read: 0, remaining_to_merge: 0 });
    assert.equal(profileInputs(suite.profile, suite.readers).excluded.length, 1);
    save(join(suite.readers[0], 'excluded-trees.json'), [{ tree_id: 'a' }]);
    assert.equal(suiteStatus(suite).completed, false); // Cannot exclude an already-read tree or miss b.
    save(join(suite.readers[0], 'excluded-trees.json'), [{ tree_id: 'unknown' }]);
    assert.equal(suiteStatus(suite).completed, false);
    save(join(suite.readers[0], 'excluded-trees.json'), [{ tree_id: 'b' }, { tree_id: 'b' }]);
    assert.equal(suiteStatus(suite).completed, false);
    save(join(suite.readers[0], 'excluded-trees.json'), [{ tree_id: 'b' }]);
    save(join(suite.profile, 'merged-trees.json'), [{ tree_id: 'b' }]);
    assert.equal(suiteStatus(suite).completed, false); // Excluded trees must never count as reconciled evidence.
    save(join(suite.profile, 'merged-trees.json'), [{ tree_id: 'wrong' }]);
    assert.equal(suiteStatus(suite).completed, false);
    writeFileSync(join(suite.profile, 'STOP'), 'stop');
    assert.ok(await waitProfileInputs(suite.profile, suite.readers));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
