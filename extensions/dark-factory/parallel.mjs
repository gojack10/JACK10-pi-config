import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { save } from './core.mjs';
import { observe } from './watch.mjs';

const json = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
export function profileInputs(directory, readers) {
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

// Watch first, then inspect: completion cannot slip between the check and subscription.
export async function waitProfileInputs(directory, readers, video) {
  const watchers = [];
  try {
    return await new Promise((resolve, reject) => {
      const inspect = () => {
        try {
          const input = profileInputs(directory, readers);
          input.video = video ? { directory: video, state: json(join(video, 'state.json'), {}) } : null;
          input.videoReady = !video || input.video.state.status === 'video_ready';
          const videoStalled = video && ['error', 'paused', 'blocked', 'step_limit'].includes(input.video.state.status);
          if (existsSync(join(directory, 'STOP')) || input.pending.length || (input.allReadersComplete && input.videoReady) || input.stalled.length || videoStalled) {
            save(join(directory, 'reader-inputs.json'), input); resolve(input);
          }
        } catch (error) { reject(error); }
      };
      for (const d of [directory, ...readers, ...(video ? [video] : [])]) {
        watchers.push(observe(d, inspect, reject));
      }
      inspect();
    });
  } finally { for (const watcher of watchers) watcher.close(); }
}

export function suiteStatus(suite) {
  const lanes = [suite.video, suite.profile, ...suite.readers].map(directory => ({ directory,
    state: json(join(directory, 'state.json'), { status: 'not_started' }), finished: json(join(directory, 'finished.json'), null) }));
  const profile = profileInputs(suite.profile, suite.readers);
  const readerPopulation = suite.readers.flatMap(d => json(join(d, 'config.json'), {}).assignments ?? []).map(a => a.tree_id);
  const expected = new Set(readerPopulation), actual = new Set(profile.completed.map(e => e.tree_id));
  const excluded = new Set(profile.excluded.map(e => e.tree_id));
  const accounted = [...actual, ...excluded];
  const populationComplete = expected.size === readerPopulation.length && actual.size === profile.completed.length &&
    excluded.size === profile.excluded.length && accounted.length === expected.size &&
    new Set(accounted).size === expected.size && accounted.every(id => expected.has(id));
  const ready = lanes[0].state.status === 'video_ready' && lanes[1].state.status === 'profile_ready' &&
    lanes[0].finished?.ok === true && lanes[1].finished?.ok === true && profile.allReadersComplete &&
    populationComplete && lanes.slice(2).every(l => l.finished?.completed === true) &&
    profile.merged.length === actual.size && new Set(profile.merged.map(e => e.tree_id)).size === actual.size &&
    profile.merged.every(e => actual.has(e.tree_id));
  const needsAttention = lanes.some(l => ['error', 'paused', 'blocked', 'step_limit'].includes(l.state.status));
  return { status: ready ? 'ready_for_interview' : needsAttention ? 'needs_attention' : 'in_progress', model: suite.route,
    video: lanes[0], profile: lanes[1], readers: lanes.slice(2),
    trees: { total: expected.size, read: actual.size, excluded: excluded.size, merged: profile.merged.length,
      remaining_to_read: [...expected].filter(id => !actual.has(id) && !excluded.has(id)).length,
      remaining_to_merge: [...actual].filter(id => !profile.merged.some(e => e.tree_id === id)).length },
    completed: ready, completion_is: 'Both content-complete lanes; every inventoried tree either read and reconciled or explicitly excluded for denied AI access. Personal interview remains unperformed.' };
}

export async function watchSuite(suite, output) {
  const dirs = [suite.video, suite.profile, ...suite.readers];
  const watchers = [];
  try {
    return await new Promise((resolve, reject) => {
      const inspect = () => {
        try {
          const status = suiteStatus(suite); save(output, status);
          if (status.completed) resolve(status);
          else if ([status.video, status.profile, ...status.readers].some(l =>
            ['error', 'paused', 'blocked', 'stopped', 'step_limit'].includes(l.state.status))) {
            reject(Error(`YC suite needs attention; inspect ${output}`));
          }
        } catch (error) { reject(error); }
      };
      for (const dir of dirs) watchers.push(observe(dir, inspect, reject));
      inspect();
    });
  } finally { for (const watcher of watchers) watcher.close(); }
}
