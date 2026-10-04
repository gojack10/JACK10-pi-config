import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoop, save, taskSettings, validateReport } from './core.mjs';

const project = { ...taskSettings('yc-read-0'), excludeUnreadable: true };

test('authorized access exclusions advance once, remain separate from reads and preserve coverage gaps', async () => {
  const d = mkdtempSync(join(tmpdir(), 'yc-exclude-'));
  try {
    const tasks = ['denied', 'readable'].map(tree_id => ({ tree_id, root_id: `root-${tree_id}` }));
    const seen = [];
    await runLoop({ directory: d, project, assignments: tasks, runStep: async ({ role, task, previous }) => {
      seen.push(task.tree_id);
      assert.equal(previous, null);
      const excluded = task.tree_id === 'denied', packet = join(d, `${task.tree_id}.json`);
      save(packet, { ...task, outline_complete: !excluded, content_read_ids: excluded ? [] : [task.root_id],
        findings: [], exclusions: [], remaining_work: excluded ? ['Unread, explicitly excluded'] : [],
        ...(excluded ? { coverage_status: 'excluded', exclusion_kind: 'ai_read_denied',
          exclusion_reason: 'Root read returned Tree not accessible via AI' } : {}) });
      const text = JSON.stringify({ version: 1, role, disposition: excluded ? 'excluded' : 'worked',
        tree_id: task.tree_id, tree_packet: packet, evidence: [packet], updated_nodes: [], summary: 'honest coverage' });
      if (excluded) assert.throws(() => validateReport(text, role, false, taskSettings('yc-read-0')), /invalid disposition/);
      return { text, receipt: { job: task.tree_id } };
    } });
    assert.deepEqual(seen, ['denied', 'readable']);
    const read = name => JSON.parse(readFileSync(join(d, name), 'utf8'));
    assert.equal(read('state.json').status, 'reads_complete');
    assert.deepEqual(read('completed-trees.json').map(x => x.tree_id), ['readable']);
    assert.deepEqual(read('excluded-trees.json').map(x => x.tree_id), ['denied']);
    assert.equal(read('denied.json').outline_complete, false);
    assert.equal(read('denied.json').remaining_work.length, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('network failures and mismatched identities cannot become access exclusions', async () => {
  for (const fields of [{ exclusion_kind: 'network_timeout' }, { root_id: 'wrong-root' }]) {
    const d = mkdtempSync(join(tmpdir(), 'yc-exclude-invalid-'));
    try {
      const task = { tree_id: 'denied', root_id: 'root' }, packet = join(d, 'packet.json');
      save(packet, { ...task, coverage_status: 'excluded', exclusion_kind: 'ai_read_denied', exclusion_reason: 'denied', ...fields });
      await assert.rejects(runLoop({ directory: d, project, assignments: [task], runStep: async ({ role }) => ({
        text: JSON.stringify({ version: 1, role, disposition: 'excluded', summary: 'not acceptable',
          tree_id: task.tree_id, tree_packet: packet, evidence: [packet], updated_nodes: [] }), receipt: {} }) }),
      /invalid tree exclusion packet|identity mismatch/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});
