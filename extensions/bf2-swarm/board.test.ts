import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
const fixtureRoot = join(homedir(), '.local/state/bf2-room-tests');
mkdirSync(fixtureRoot, { recursive: true });
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { configuration, openBoard, HISTORY_LIMIT } from './board.mjs';
import { main } from './cli.mjs';

const executable = resolve('bin/board');
function fixture(t) {
  const dir = mkdtempSync(join(fixtureRoot, 'bf2-board-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, BF2_BOARD_DB: join(dir, 'board.sqlite'), BF2_BOARD_RUN: 'test-run',
    BF2_BOARD_SESSION: 'session-a', BF2_BOARD_SENDER: 'aaaaaaaa' };
  return { dir, env, config: configuration(env) };
}
const cli = (env, ...args) => spawnSync(executable, args, { env, encoding: 'utf8' });

test('real executable post/read across separate processes; compound bash invocation', t => {
  const { env } = fixture(t);
  const posted = spawnSync('/bin/bash', ['-c', 'true && "$BOARD_EXEC" post "hello peer"'], {
    env: { ...env, BOARD_EXEC: executable }, encoding: 'utf8' });
  assert.equal(posted.status, 0, posted.stderr);
  assert.match(posted.stdout, /^#1 aaaaaaaa\n$/);
  const read = cli({ ...env, BF2_BOARD_SESSION: 'session-b', BF2_BOARD_SENDER: 'bbbbbbbb' }, 'read');
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /#1 aaaaaaaa .*: "hello peer"/);
  assert.equal(cli(env, 'post', 'second').stdout, '#2 aaaaaaaa\n');
  assert.match(cli(env, 'read').stdout, /#1 .*\n#2 /);
});

test('help and invalid opt-in do not create SQLite; identity/run conflicts refuse', t => {
  const { env } = fixture(t);
  for (const flag of ['-h', '--help']) {
    const help = cli({ ...env, BF2_BOARD_DB: '' }, flag);
    assert.equal(help.status, 0);
    assert.doesNotMatch(help.stdout, /board status/);
    for (const command of ['read', 'post', 'vote', 'done']) assert.match(help.stdout, new RegExp(`board ${command}\\b`));
    assert.equal(existsSync(env.BF2_BOARD_DB), false);
  }
  assert.equal(cli({ ...env, BF2_BOARD_SENDER: '' }, 'read').status, 1);
  assert.equal(existsSync(env.BF2_BOARD_DB), false);
  assert.equal(cli(env, 'post', 'one').status, 0);
  for (const overrides of [{ BF2_BOARD_RUN: 'other' }, { BF2_BOARD_SESSION: 'other-session' }, { BF2_BOARD_SENDER: 'bbbbbbbb' }]) {
    assert.equal(cli({ ...env, ...overrides }, 'post', 'bad').status, 1);
  }
  assert.doesNotMatch(cli(env, 'read').stdout, /bad/);
});

test('status is rejected before opening a database in legacy, floor-worker and outside scopes', t => {
  const { env } = fixture(t);
  const scopes = [env,
    { ...env, FACTORY_FLOOR: 'fixture', FACTORY_DB: env.BF2_BOARD_DB, FACTORY_SESSION: 'session-a', FACTORY_SENDER: 'aaaaaaaa' },
    { ...env, FACTORY_ROOT: join(env.BF2_BOARD_DB, 'unused') }];
  for (const [i, scoped] of scopes.entries()) {
    const result = cli(scoped, ...(i === 2 ? ['--floor', 'fixture'] : []), 'status');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected post, read, done, pause or vote; use board -h/);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(env.BF2_BOARD_DB), false);
  }
});

test('read/post/vote/done dispatch remains available in legacy and floor-worker scopes', async () => {
  for (const env of [{}, { FACTORY_FLOOR: 'fixture', FACTORY_DB: '/unused', FACTORY_SESSION: 'session-a', FACTORY_SENDER: 'aaaaaaaa' }]) {
    const calls = [];
    const api = { configuration: () => ({ run: 'fixture', sender: 'aaaaaaaa' }), openBoard: () => ({
      post: text => { calls.push(['post', text]); return 1; },
      history: options => { calls.push(['read', options]); return { posts: [], wake: [], startup: true, highwater: 1 }; },
      finishStartup: (...args) => calls.push(['startup', ...args]),
      lifecycle: {
        status: () => ({ floor: { voteCondition: 'fixture condition' } }),
        vote: (...args) => { calls.push(['vote', ...args]); return { number: 2, result: 'recorded' }; },
        done: text => { calls.push(['done', text]); return 3; },
      },
      close: () => calls.push(['close']),
    }) };
    let text = '';
    const output = { write(chunk, callback) { text += chunk; callback(); } };
    for (const args of [['post', 'hello'], ['read'], ['vote', '2', 'yes'], ['vote', '2', 'no'], ['done', 'handoff']]) {
      await main(args, env, output, api);
    }
    assert.deepEqual(calls, [['post', 'hello'], ['close'], ['read', {}], ['startup', 1, null], ['close'],
      ['vote', 2, 'yes'], ['close'], ['vote', 2, 'no'], ['close'], ['done', 'handoff'], ['close']]);
    assert.match(text, /Board run fixture/);
    assert.match(text, /#1 aaaaaaaa/);
    assert.match(text, /pause #2 recorded/);
    assert.match(text, /#3 aaaaaaaa retirement requested/);
  }
});

test('bounded chronological history; older reads do not initialize/advance delivery', t => {
  const { env, config } = fixture(t);
  const board = openBoard(config);
  t.after(() => board.close());
  for (let i = 1; i <= 45; i++) board.post(`post ${i}`);
  const first = board.history();
  assert.equal(first.posts.length, HISTORY_LIMIT);
  assert.equal(first.posts[0].number, 16);
  assert.equal(first.posts.at(-1).number, 45);
  const older = cli(env, 'read', '--before', '16', '--limit', '5');
  assert.equal(older.status, 0, older.stderr);
  assert.match(older.stdout, /#11 .*\n#12 .*\n#13 .*\n#14 .*\n#15 /);
  assert.equal(board.history().startup, true);
  assert.equal(cli(env, 'read').status, 0);
  assert.equal(board.history().startup, false);
  for (const args of [['--limit', '0'], ['--limit', '101'], ['--before', '-1'], ['--limit', '2x'], ['--before', '9007199254740993']]) {
    assert.equal(cli(env, 'read', ...args).status, 1);
  }
});

test('input validation, Unicode/multiline quoting, no invented sender from prose', t => {
  const { env } = fixture(t);
  for (const args of [['post'], ['post', ''], ['post', '  '], ['post', 'x'.repeat(16385)], ['post', 'one', 'two'], ['read', 'extra'], ['run_capture'], ['read', '--unknown']]) {
    assert.equal(cli(env, ...args).status, 1);
  }
  const text = 'from bbbbbbbb: hi\n🍀';
  assert.equal(cli(env, 'post', text).status, 0);
  assert.match(cli(env, 'read').stdout, /#1 aaaaaaaa .*: "from bbbbbbbb: hi\\n🍀"/);
});

test('stdout failure does not consume startup; snapshot excludes posts arriving during output', async t => {
  const { env, config } = fixture(t);
  const board = openBoard(config);
  t.after(() => board.close());
  board.post('old');
  await assert.rejects(main(['read'], env, { write(_text, callback) { callback(new Error('EPIPE')); } }), /EPIPE/);
  assert.equal(board.history().startup, true);
  const peer = openBoard({ ...config, session: 'peer', sender: 'bbbbbbbb' });
  t.after(() => peer.close());
  await main(['read'], env, { write(_text, callback) { peer.post('during stdout'); callback(); } });
  assert.match(board.pending().text, /during stdout/);
  assert.doesNotMatch(board.pending().text, /"old"/);
});

test('dedicated board uses persistent WAL mode across CLI opens', t => {
  const { env } = fixture(t);
  assert.equal(cli(env, 'post', 'WAL').status, 0);
  const db = new DatabaseSync(env.BF2_BOARD_DB);
  try { assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal'); }
  finally { db.close(); }
  assert.equal(cli(env, 'read').status, 0);
});

test('concurrent independent CLI processes preserve unique numbered posts', async t => {
  const { env, config } = fixture(t);
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => new Promise(resolveResult => {
    const child = spawn(executable, ['post', `concurrent ${i}`], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', status => resolveResult({ status, stdout, stderr }));
  })));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(new Set(results.map(r => r.stdout)).size, 16);
  const board = openBoard(config);
  t.after(() => board.close());
  assert.deepEqual(board.history().posts.map(p => p.number), Array.from({ length: 16 }, (_, i) => i + 1));
});
