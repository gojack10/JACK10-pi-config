import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
// A rejected submission belongs to one task: the controller keeps the evidence and the dispatcher retries.
// Anything else that halts code work is shared-repo or configuration ambiguity and must stop admission.
export class TaskFault extends Error {}
export const sha = value => typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
const text = value => typeof value === 'string' && value.length && !/[\x00-\x1f\x7f]/.test(value);
const within = (path, root) => path === root || path.startsWith(root === '/' ? '/' : root + '/');
export function fileScope(paths, label = 'files') {
  if (!Array.isArray(paths) || !paths.length || paths.some(path => !text(path) || isAbsolute(path) ||
      path.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase())) || /[\\*?\[\]:]/.test(path))) {
    throw Error(`${label} must contain literal repo-relative files/directories (no globs, traversal or .git)`);
  }
  return [...paths];
}
const absolute = (path, label) => {
  if (!text(path) || !isAbsolute(path) || resolve(path) !== path) throw Error(`${label} must be an absolute normalized path`);
  return path;
};
export function validateCodeConfig(code) {
  if (!code) return undefined;
  const c = { ...code };
  absolute(c.repo, 'code.repo'); absolute(c.worktree_root, 'code.worktree_root');
  if (within(c.worktree_root, c.repo) || within(c.repo, c.worktree_root)) throw Error('code worktree_root and repo must be disjoint');
  if (!text(c.main_branch) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(c.main_branch) || c.main_branch.includes('..') ||
      c.main_branch.includes('//') || c.main_branch.endsWith('/') || c.main_branch.endsWith('.lock')) throw Error('unsafe main_branch');
  if (!sha(c.main_head)) throw Error('code.main_head must be the full authorized commit SHA');
  c.allowed_paths = fileScope(c.allowed_paths, 'code.allowed_paths');
  c.frozen_paths = fileScope(c.frozen_paths, 'code.frozen_paths');
  for (const name of ['candidate_checks', 'main_checks']) {
    if (!Array.isArray(c[name]) || !c[name].length || c[name].some(argv => !Array.isArray(argv) || !argv.length ||
        !argv.every(text) || !isAbsolute(argv[0]))) throw Error(`code.${name} needs nonempty argv arrays with absolute executables`);
  }
  return c;
}
export function vetCodeTask(task, config, known) {
  if (task.seats && !task.seats.every(id => config.seats.some(seat => seat.id === id))) throw Error('task names an unavailable seat');
  if (!task.code) {
    if (known?.code) throw Error('cannot remove code ownership from a retained task');
    return;
  }
  if (!config.code) throw Error('code tasks are not enabled');
  const files = fileScope(task.code.files);
  for (const file of files) {
    if (!config.code.allowed_paths.some(root => within(file, root))) throw Error(`file authority outside code.allowed_paths: ${file}`);
    if (config.code.frozen_paths.some(root => within(file, root) || within(root, file))) throw Error(`file authority overlaps frozen path: ${file}`);
  }
  if (!task.seats?.length) throw Error('code tasks require explicit seats');
  if (known?.code && (JSON.stringify(files) !== JSON.stringify(known.code.files) || task.scope !== known.scope ||
      JSON.stringify(task.seats) !== JSON.stringify(known.seats))) throw Error('cannot change retained code ownership, tree scope or seats');
}
export const codePin = config => createHash('sha256').update(JSON.stringify(config.code)).digest('hex');
export const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout.replace(/\r?\n$/, '');
const canonical = path => { if (realpathSync(path) !== path) throw Error(`symlink/noncanonical path: ${path}`); };
export async function mainIdentity(c) {
  canonical(c.repo); canonical(c.worktree_root);
  if (await git(c.repo, 'rev-parse', '--show-toplevel') !== c.repo) throw Error('code.repo must be the git checkout root');
  if (await git(c.repo, 'symbolic-ref', 'HEAD') !== `refs/heads/${c.main_branch}`) throw Error('main branch changed');
  if (await git(c.repo, 'status', '--porcelain', '--untracked-files=all')) throw Error('main checkout is dirty');
  return git(c.repo, 'rev-parse', 'HEAD');
}
export async function preflightCode(config) {
  const c = validateCodeConfig(config.code);
  if (!c) return;
  await git(c.repo, 'check-ref-format', '--branch', c.main_branch);
  if (await mainIdentity(c) !== c.main_head) throw Error('main HEAD differs from authorized code.main_head');
  const common = await git(c.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  for (const repo of config.readonly_repos) {
    if (realpathSync(await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')) === realpathSync(common)) throw Error('mutable code repo is also read-only');
  }
}
export async function repoLock(config, directory) {
  const c = config.code;
  canonical(c.repo);
  const common = await git(c.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  absolute(common, 'git common directory'); canonical(common);
  const lock = join(common, 'parallel-factory.lock');
  try { mkdirSync(lock); writeFileSync(join(lock, 'owner'), directory + '\n'); }
  catch { if (!existsSync(join(lock, 'owner')) || readFileSync(join(lock, 'owner'), 'utf8').trim() !== directory) throw Error(`code repository lock is ambiguous or owned by another run: ${lock}`); }
  return lock;
}
export function releaseRepoLock(lock, directory) {
  if (lock && readFileSync(join(lock, 'owner'), 'utf8').trim() === directory) rmSync(lock, { recursive: true });
}
export function allocation(config, task) {
  return { ...task.code, worktree: join(config.code.worktree_root, `${config.run_node}-${task.node_id}`),
    branch: `factory/${config.run_node}/${task.node_id}`, base: config.code.main_head, phase: 'develop', candidate: null };
}
export async function prepareCode(config, code) {
  const c = config.code;
  canonical(c.worktree_root);
  if (existsSync(code.worktree)) throw Error('unacknowledged worktree already exists; retain it for recovery');
  await git(c.repo, 'check-ref-format', '--branch', code.branch);
  // No reset/remove/force: any partial Git operation remains inspectable and requires recovery.
  await git(c.repo, 'worktree', 'add', '-b', code.branch, code.worktree, code.base);
}
export async function worktreeIdentity(config, code, candidate) {
  canonical(code.worktree);
  if (await git(code.worktree, 'rev-parse', '--show-toplevel') !== code.worktree ||
      await git(code.worktree, 'symbolic-ref', 'HEAD') !== `refs/heads/${code.branch}` ||
      await git(code.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir') !==
        await git(config.code.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')) throw Error('incompatible worktree/branch/repo ownership');
  if (candidate && (await git(code.worktree, 'rev-parse', 'HEAD') !== candidate ||
      await git(code.worktree, 'status', '--porcelain', '--untracked-files=all'))) throw Error('candidate changed or worktree is dirty');
}
export async function candidateIdentity(config, code, candidate, base, acceptedMain = base) {
  if (!sha(candidate) || !sha(base) || !sha(acceptedMain)) throw Error('candidate/base/accepted main requires full SHA');
  await worktreeIdentity(config, code, candidate);
  await git(code.worktree, 'merge-base', '--is-ancestor', base, candidate);
  // Exclude only accepted history actually imported by this candidate, not newer unmerged main.
  const comparison = await git(code.worktree, 'merge-base', '--all', candidate, acceptedMain);
  if (!sha(comparison)) throw Error('candidate requires a single accepted-history merge base');
  await git(code.worktree, 'merge-base', '--is-ancestor', base, comparison);
  const paths = (await git(code.worktree, 'diff', '--name-only', '--no-renames', '-z', comparison, candidate)).split('\0').filter(Boolean);
  for (const path of paths) {
    if (!code.files.some(root => within(path, root)) || config.code.frozen_paths.some(root => within(path, root))) throw Error(`candidate violates file fence: ${path}`);
    // Symlink/gitlink publication is deliberately unsupported, not sandbox enforcement.
    const mode = await git(code.worktree, '--literal-pathspecs', 'ls-tree', candidate, '--', path);
    if (/^(120000|160000)\s/.test(mode)) throw Error(`candidate contains symlink/gitlink: ${path}`);
  }
  return paths;
}
// Registered packets are data. This is the only thing that executes them, so a model can never author a check.
const canonicalJson = value => JSON.stringify(value, (key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item).sort().reduce((sum, k) => ({ ...sum, [k]: item[k] }), {}) : item);

export function checkSetDigest(checks) {
  return createHash('sha256').update(Object.keys(checks ?? {}).sort()
    .map(id => `${id}:${checks[id].proposal_hash}:${checks[id].review_hash}`).join('\n')).digest('hex');
}

export async function runRegisteredChecks(config, checks, code, kind, directory) {
  const root = kind === 'candidate' ? code.worktree : config.code.repo;
  const logs = [];
  for (const id of Object.keys(checks ?? {}).sort()) {
    const entry = checks[id], path = join(directory, `${kind}-registered-${id}.log`);
    logs.push(path);
    const lines = [];
    let failures = 0;
    for (const [index, item] of entry.cases.entries()) {
      const argv = [join(root, 'target/debug', entry.observer)];
      let result, rejected;
      try {
        // execFileSync, not execFile: only the sync form accepts `input`, and an unclosed stdin hangs the observer.
        result = execFileSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
          input: typeof item.input === 'string' ? item.input : JSON.stringify(item.input) });
      } catch (error) { rejected = error; }
      if (item.expect_nonzero === true) {
        if (!rejected || rejected.killed) { failures += 1; lines.push(`case ${index}: expected rejection, exited 0`); }
        else lines.push(`case ${index}: rejected as expected`);
        continue;
      }
      if (rejected) { failures += 1; lines.push(`case ${index}: observer failed: ${rejected.stderr ?? rejected.message}`); continue; }
      let actual;
      try { actual = JSON.parse(result); } catch { failures += 1; lines.push(`case ${index}: observer output is not JSON`); continue; }
      if (canonicalJson(actual) !== canonicalJson(item.expected_output)) {
        failures += 1; lines.push(`case ${index}: output differs from the registered expectation`);
      } else lines.push(`case ${index}: matched`);
    }
    writeFileSync(path, JSON.stringify({ check: id, task: entry.task, observer: entry.observer, cases: entry.cases.length }) + '\n' + lines.join('\n') + '\n');
    if (failures) {
      // A landed feature that no longer passes is a platform fact; a candidate that fails one is its own fault.
      const reasons = lines.filter(line => !/: matched$/.test(line) && !/: rejected as expected$/.test(line)).slice(0, 4).join('; ');
      const message = `registered check ${id} failed for task ${entry.task}; ${failures} of ${entry.cases.length} cases: ${reasons}; retained log: ${path}`;
      throw kind === 'candidate' ? new TaskFault(message) : Error(message);
    }
  }
  return logs;
}

export async function runCodeChecks(config, code, kind, candidate, main, directory) {
  const cwd = kind === 'candidate' ? code.worktree : config.code.repo;
  const logs = [];
  for (const [i, argv] of config.code[`${kind}_checks`].entries()) {
    const path = join(directory, `${kind}-check-${i}.log`);
    logs.push(path);
    try {
      const result = await exec(argv[0], argv.slice(1), { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, FACTORY_CANDIDATE: candidate, FACTORY_MAIN: main, FACTORY_WORKTREE: code.worktree } });
      writeFileSync(path, JSON.stringify({ argv, cwd, candidate, main }) + '\n' + result.stdout + result.stderr);
    } catch (error) {
      writeFileSync(path, JSON.stringify({ argv, cwd, candidate, main }) + '\n' + (error.stdout ?? '') + (error.stderr ?? '') + String(error));
      // A candidate that fails its own gate is one bad item on the line. A main that fails after publication
      // means accepted history is unverified, which stays a stop until the run can decide a revert.
      throw kind === 'candidate' ? new TaskFault(`${kind} check failed; retained log: ${path}`)
        : Error(`${kind} check failed; retained log: ${path}`);
    }
  }
  return logs;
}
