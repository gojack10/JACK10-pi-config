import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { configuration, openBoard, HISTORY_LIMIT } from './board.mjs';
import { main } from './cli.mjs';

const executable = resolve('bin/board');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bf2-board-'));
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
    assert.equal(cli({ ...env, BF2_BOARD_DB: '' }, flag).status, 0);
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
