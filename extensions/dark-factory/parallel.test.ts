import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { save } from './core.mjs';
import { aggregateInputs, suiteStatus, waitAggregateInputs } from './parallel.mjs';

test('aggregate waits for reader receipts; completion needs exact population and prerequisite', { timeout: 5000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-suite-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const suite = { prerequisite: join(directory, 'prerequisite'), aggregate: join(directory, 'aggregate'), readers: [join(directory, 'reader')], route: {} };
  for (const path of [suite.prerequisite, suite.aggregate, ...suite.readers]) mkdirSync(path);
  const reader = suite.readers[0];
  save(join(reader, 'config.json'), { assignments: [{ tree_id: 'a' }, { tree_id: 'b' }] });
  save(join(reader, 'state.json'), { status: 'running' });
  const waiting = waitAggregateInputs(suite.aggregate, suite.readers);
  save(join(reader, 'completed-trees.json'), [{ tree_id: 'a', tree_packet: '/packet' }]);
  assert.equal((await waiting).pending.length, 1);
  assert.equal(suiteStatus(suite).completed, false);
  save(join(reader, 'state.json'), { status: 'reads_complete' });
  save(join(reader, 'finished.json'), { ok: true, completed: true });
  save(join(suite.aggregate, 'merged-trees.json'), [{ tree_id: 'a' }]);
  assert.equal(aggregateInputs(suite.aggregate, suite.readers).pending.length, 0);
  save(join(suite.prerequisite, 'state.json'), { status: 'running' });
  let admitted = false;
  const finalWait = waitAggregateInputs(suite.aggregate, suite.readers, suite.prerequisite).then(input => { admitted = true; return input; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, false);
  save(join(suite.prerequisite, 'state.json'), { status: 'prerequisite_ready' });
  assert.equal((await finalWait).prerequisiteReady, true);
  for (const [lane, status] of [[suite.prerequisite, 'prerequisite_ready'], [suite.aggregate, 'aggregate_ready']]) {
    save(join(lane, 'state.json'), { status }); save(join(lane, 'finished.json'), { ok: true, completed: true });
  }
  assert.equal(suiteStatus(suite).completed, false);
  save(join(reader, 'excluded-trees.json'), [{ tree_id: 'b' }]);
  assert.equal(suiteStatus(suite).status, 'complete');
  assert.deepEqual(suiteStatus(suite).trees, { total: 2, read: 1, excluded: 1, merged: 1, remaining_to_read: 0, remaining_to_merge: 0 });
  for (const excluded of [[{ tree_id: 'a' }], [{ tree_id: 'unknown' }], [{ tree_id: 'b' }, { tree_id: 'b' }]]) {
    save(join(reader, 'excluded-trees.json'), excluded);
    assert.equal(suiteStatus(suite).completed, false);
  }
  save(join(reader, 'excluded-trees.json'), [{ tree_id: 'b' }]);
  save(join(suite.aggregate, 'merged-trees.json'), [{ tree_id: 'b' }]);
  assert.equal(suiteStatus(suite).completed, false);
  writeFileSync(join(suite.aggregate, 'STOP'), 'stop');
  assert.ok(await waitAggregateInputs(suite.aggregate, suite.readers));
});
