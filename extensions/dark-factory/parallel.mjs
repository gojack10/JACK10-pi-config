import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { save } from './core.mjs';
import { observe } from './watch.mjs';

const json = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
export function aggregateInputs(directory, readers) {
  const merged = json(join(directory, 'merged-trees.json'), []);
  const lanes = readers.map(directory => ({ directory, state: json(join(directory, 'state.json'), { status: 'not_started' }),
    completed: json(join(directory, 'completed-trees.json'), []), excluded: json(join(directory, 'excluded-trees.json'), []) }));
  const completed = lanes.flatMap(l => l.completed);
  const mergedIds = new Set(merged.map(e => e.tree_id));
  return { readers: lanes.map(({ directory, state }) => ({ directory, state })), completed, excluded: lanes.flatMap(l => l.excluded),
    pending: completed.filter(e => !mergedIds.has(e.tree_id)), merged,
    allReadersComplete: lanes.every(l => l.state.status === 'reads_complete'),
    stalled: lanes.filter(l => ['error', 'paused', 'blocked', 'stopped', 'step_limit'].includes(l.state.status)) };
}

// Subscribe before inspecting so a dependency cannot complete between them.
export async function waitAggregateInputs(directory, readers, prerequisite) {
  const watchers = [];
  try {
    return await new Promise((resolve, reject) => {
      const inspect = () => {
        try {
          const input = aggregateInputs(directory, readers);
          input.prerequisite = prerequisite ? { directory: prerequisite, state: json(join(prerequisite, 'state.json'), {}) } : null;
          input.prerequisiteReady = !prerequisite || input.prerequisite.state.status === 'prerequisite_ready';
          const stalled = prerequisite && ['error', 'paused', 'blocked', 'step_limit'].includes(input.prerequisite.state.status);
          if (existsSync(join(directory, 'STOP')) || input.pending.length || (input.allReadersComplete && input.prerequisiteReady) || input.stalled.length || stalled) {
            save(join(directory, 'reader-inputs.json'), input); resolve(input);
          }
        } catch (error) { reject(error); }
      };
      for (const d of [directory, ...readers, ...(prerequisite ? [prerequisite] : [])]) watchers.push(observe(d, inspect, reject));
      inspect();
    });
  } finally { for (const watcher of watchers) watcher.close(); }
}

export function suiteStatus(suite) {
  const lanes = [suite.prerequisite, suite.aggregate, ...suite.readers].map(directory => ({ directory,
    state: json(join(directory, 'state.json'), { status: 'not_started' }), finished: json(join(directory, 'finished.json'), null) }));
  const aggregate = aggregateInputs(suite.aggregate, suite.readers);
  const population = suite.readers.flatMap(d => json(join(d, 'config.json'), {}).assignments ?? []).map(a => a.tree_id);
  const expected = new Set(population), actual = new Set(aggregate.completed.map(e => e.tree_id));
  const excluded = new Set(aggregate.excluded.map(e => e.tree_id)), accounted = [...actual, ...excluded];
  const covered = expected.size === population.length && actual.size === aggregate.completed.length &&
    excluded.size === aggregate.excluded.length && accounted.length === expected.size &&
    new Set(accounted).size === expected.size && accounted.every(id => expected.has(id));
  const ready = lanes[0].state.status === 'prerequisite_ready' && lanes[1].state.status === 'aggregate_ready' &&
    lanes[0].finished?.ok === true && lanes[1].finished?.ok === true && aggregate.allReadersComplete && covered &&
    lanes.slice(2).every(l => l.finished?.completed === true) && aggregate.merged.length === actual.size &&
    new Set(aggregate.merged.map(e => e.tree_id)).size === actual.size && aggregate.merged.every(e => actual.has(e.tree_id));
  const needsAttention = lanes.some(l => ['error', 'paused', 'blocked', 'step_limit'].includes(l.state.status));
  return { status: ready ? 'complete' : needsAttention ? 'needs_attention' : 'in_progress', model: suite.route,
    prerequisite: lanes[0], aggregate: lanes[1], readers: lanes.slice(2),
    trees: { total: expected.size, read: actual.size, excluded: excluded.size, merged: aggregate.merged.length,
      remaining_to_read: [...expected].filter(id => !actual.has(id) && !excluded.has(id)).length,
      remaining_to_merge: [...actual].filter(id => !aggregate.merged.some(e => e.tree_id === id)).length },
    completed: ready, completion_is: 'All configured lanes complete; each assigned tree is reconciled or explicitly excluded for denied access.' };
}

export async function watchSuite(suite, output) {
  const watchers = [];
  try {
    return await new Promise((resolve, reject) => {
      const inspect = () => {
        try {
          const status = suiteStatus(suite); save(output, status);
          if (status.completed) resolve(status);
          else if ([status.prerequisite, status.aggregate, ...status.readers].some(l =>
            ['error', 'paused', 'blocked', 'stopped', 'step_limit'].includes(l.state.status))) reject(Error(`Factory suite needs attention; inspect ${output}`));
        } catch (error) { reject(error); }
      };
      for (const directory of [suite.prerequisite, suite.aggregate, ...suite.readers]) watchers.push(observe(directory, inspect, reject));
      inspect();
    });
  } finally { for (const watcher of watchers) watcher.close(); }
}
