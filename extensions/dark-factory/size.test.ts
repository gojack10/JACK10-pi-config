import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mission, runLoop, taskSettings } from './core.mjs';

test('size factory runs sequential writers and continues the same owner at a friendly stop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yc-size-'));
  try {
    const evidence = join(directory, 'prepared.json'); writeFileSync(evidence, '{}');
    const project = taskSettings('yc-size');
    const assignments = [{ owner_id: 'first' }, { owner_id: 'second', hub: true }];
    let active = 0, maximum = 0;
    const seen = [];
    await runLoop({ directory, project, assignments, runStep: async ({ step, role, task, previous, reportPath }) => {
      maximum = Math.max(maximum, ++active);
      assert.equal(role, 'worker'); seen.push(task.owner_id);
      if (step === 2) assert.equal(previous, join(directory, '1-worker.json'));
      if (step === 3) assert.equal(previous, null);
      const text = JSON.stringify({ version: 1, role, disposition: step === 1 ? 'continue' : 'worked',
        summary: 'trusted prepared result', evidence: [evidence], updated_nodes: ['00000000-0000-0000-0000-000000000001'] });
      writeFileSync(reportPath, text); active--;
      return { text, receipt: { job: step }, contextStopped: step === 1 };
    } });
    assert.equal(maximum, 1);
    assert.deepEqual(seen, ['first', 'first', 'second']);
    assert.equal(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).status, 'size_ready');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'completed-nodes.json'), 'utf8')).map(n => n.owner_id), ['first', 'second']);
    assert.deepEqual(project.route, { provider: 'openai-codex-personal', model: 'gpt-6-luna', thinking: 'high' });
    const text = mission({ role: 'worker', directory, project, contract: '', reportPath: '/report.json', task: assignments[0] });
    assert.match(text, /NO CHECKING OR VERIFICATION/);
    assert.match(text, /Count only prepared crystallization strings/);
    assert.match(text, /80% friendly stop/);
    assert.match(text, /without any closing check\/readback/);
    assert.match(text, /fs\.openSync\(reportPath,'r\+'\)/);
    assert.match(text, /Do NOT use an atomic-save\/rename helper/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
