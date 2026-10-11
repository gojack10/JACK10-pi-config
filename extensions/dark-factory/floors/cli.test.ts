import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCommand, floorScope } from './cli.mjs';

const bound = { FACTORY_FLOOR: 'alpha', FACTORY_DB: '/fixture/alpha/floor.sqlite', FACTORY_SESSION: 'session-a', FACTORY_SENDER: 'aaaaaaaa' };

test('explicit selection outside workers; launch binding cannot change floor', () => {
  assert.throws(() => parseCommand(['status'], {}), /--floor is required/);
  assert.equal(parseCommand(['status', '--floor', 'alpha'], {}).floor, 'alpha');
  assert.equal(parseCommand(['status'], bound).floor, 'alpha');
  assert.deepEqual(floorScope('alpha', bound).worker, { database: bound.FACTORY_DB, session: 'session-a', sender: 'aaaaaaaa' });
  assert.throws(() => parseCommand(['status', '--floor', 'beta'], bound), /cannot change/);
  for (const name of Object.keys(bound)) assert.throws(() => floorScope(undefined, { ...bound, [name]: '' }), /incomplete/);
  assert.throws(() => floorScope(undefined, { ...bound, FACTORY_DB: 'relative' }), /absolute/);
  assert.deepEqual(parseCommand(['list'], {}), { command: 'list' });
  assert.deepEqual(parseCommand(['--help'], {}), { command: 'help' });
});

test('command-specific flags refuse typos and ambiguous arguments before operations', () => {
  for (const args of [[], ['oops'], ['__proto__'], ['status', '--floor', 'alpha', 'extra'],
    ['list', '--floor', 'alpha'], ['start', '--floor', 'alpha', '--settings', 'missing'],
    ['message', '--floor', 'alpha'], ['message', '--floor', 'alpha', 'one', 'two'],
    ['status', '--floor', 'alpha', '--unknown'], ['status', '--floor', 'alpha', '--floors-dir', 'relative'],
    ['message', '--floor', 'alpha', 'hello', '--key', ' '], ['adopt', '--floor', 'alpha', '--settings', 'missing'],
    ['create', '--floor', 'alpha'], ['create', '--settings', 'missing']]) assert.throws(() => parseCommand(args, {}));
  assert.equal(parseCommand(['message', '--floor', 'beta', 'hello', '--key', 'retry'], {}).text, 'hello');
  assert.equal(parseCommand(['list'], { FACTORY_ROOT: '/fixture' }).floorsDir, '/fixture');
  assert.equal(parseCommand(['list', '--floors-dir', '/explicit'], { FACTORY_ROOT: '/fixture' }).floorsDir, '/explicit');
});

test('settings import is one transient JSON object; no database or model access', t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify({ name: 'Fixture', slots: [{ role: 'fixture text' }] }));
  assert.equal(parseCommand(['create', '--floor', 'alpha', '--settings', path], {}).settings.name, 'Fixture');
  assert.equal(parseCommand(['adopt', '--floor', 'alpha', '--run-dir', dir, '--settings', path], {}).runDir, dir);
  for (const data of ['[]', 'null', '42', 'not json']) {
    writeFileSync(path, data);
    assert.throws(() => parseCommand(['config', '--floor', 'alpha', '--settings', path], {}));
  }
});
