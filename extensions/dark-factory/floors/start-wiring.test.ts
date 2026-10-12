import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { runtime, ensureController, serveFloors } from './wiring.mjs';
import { ensureFloorController } from './supervisor.mjs';
import { startGateway } from './floors-gateway.mjs';

const source = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
function fixture(t, { parent = null, missing = false, dead = '0', owner = '$10', tag, healthStatus = 0 } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-start-'))), root = join(dir, 'floors'), cwd = join(dir, 'repo'), agent = join(dir, 'agent');
  mkdirSync(cwd); mkdirSync(join(cwd, '.git')); mkdirSync(agent);
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ steeringMode: 'all', followUpMode: 'all' }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const uuid = '11111111-1111-4111-8111-111111111111';
  runtime.createFloor({ name: 'Fixture floor', cwd, roots: [uuid], instructions: uuid, voteCondition: uuid,
    bootstrap: 'Offline fixture', warningText: 'Fixture warning', wrapupText: 'Fixture wrapup',
    slots: ['a','b'].map(id => ({ id, provider: 'openai-codex-fixture', model: 'gpt-6.1-sol', thinking: 'high' })) }, { root, id: 'core' });
  const database = join(root, 'core', 'floor.sqlite'), db = new DatabaseSync(database);
  const config = JSON.parse(db.prepare('SELECT config FROM swarm_run').get().config);
  db.prepare('UPDATE swarm_run SET config=?,tmux_parent=?').run(JSON.stringify({ ...config, agentDir: agent }), parent);
  // Reader/recovery must accept additive schema without rewriting retained rows.
  db.exec('CREATE TABLE factory_jobs(id TEXT PRIMARY KEY,manifest TEXT NOT NULL,terminal TEXT,terminal_number INTEGER UNIQUE)');
  db.prepare('INSERT INTO factory_jobs(id,manifest,terminal,terminal_number) VALUES(?,?,?,?)').run(uuid,
    JSON.stringify({ id: uuid, dir: '/fixture/job' }), JSON.stringify({ id: uuid, state: 'exited', code: 7, drained: true }), 777);
  db.close();
  const floor = runtime.openFloor('core', { root }); t.after(() => floor.close());
  const calls = []; let exists = !!parent && !missing;
  const execute = args => {
    calls.push([...args]); let stdout = '', status = 0;
    switch (args[0]) {
      case 'has-session': status = exists ? 0 : 1; break;
      case 'show-options': stdout = args.at(-1) === '@bf2_swarm_run' ? (tag ?? floor.config.run) : '%20'; break;
      case 'display-message':
        if (args.at(-1) === '#{session_id}') stdout = '$10';
        else { stdout = `${dead} ${owner}`; status = healthStatus; }
        break;
      case 'new-session': case 'new-window': exists = true; stdout = '%20'; break;
      case 'respawn-pane': case 'set-option': break;
      default: assert.fail(`unexpected tmux operation ${args}`);
    }
    return { status, stdout, stderr: status ? 'unavailable' : '' };
  };
  const jobs = () => {
    const d = new DatabaseSync(database, { readOnly: true });
    try { return JSON.stringify(d.prepare('SELECT * FROM factory_jobs').all()); } finally { d.close(); }
  };
  return { dir, root, database, floor, calls, execute, jobs };
}
const launches = calls => calls.filter(a => ['new-session','new-window','respawn-pane'].includes(a[0]));
const post = (room, key) => fetch(`${room.origin}/api/floors/core/start`, { method: 'POST',
  headers: { Authorization: `Bearer ${room.token}`, Origin: room.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });

test('HTTP Start launches approved native controller for absent parent; retry/healthy reuse preserves retained jobs', async t => {
  assert.equal(ensureController, ensureFloorController);
  const h = fixture(t, { parent: '$2090', missing: true }), before = h.jobs();
  const room = await serveFloors({ root: h.root, runtime, ensureController: f => ensureController(f, h.execute,
    { PATH: '/fixture/bin', PI_SUBAGENT_TASK: 'remove', FACTORY_OLD: 'remove', TMUX: 'remove' }) });
  t.after(() => new Promise(r => room.server.close(r)));
  const state = await (await fetch(`${room.origin}/api/floors/core/state`, { headers: { Authorization: `Bearer ${room.token}` } })).json();
  assert.equal(state.status, 'stopped'); assert.equal(h.calls.length, 0);
  assert.equal((await post(room, 'start-fixture')).status, 200);
  assert.equal(h.floor.snapshot().status, 'running'); assert.equal(launches(h.calls).length, 1);
  const launch = launches(h.calls)[0]; assert.equal(launch[0], 'new-session');
  assert.ok(launch.at(-1).includes(`${source}/extensions/dark-factory/floors/supervisor.mjs`));
  assert.ok(launch.at(-1).includes('FACTORY_FLOOR=core')); assert.ok(launch.at(-1).includes(`FACTORY_ROOT=${h.root}`));
  assert.ok(launch.at(-1).includes("'-u' 'PI_SUBAGENT_TASK'")); assert.ok(!launch.at(-1).includes('exec pi'));
  assert.equal((await post(room, 'start-fixture')).status, 200); assert.equal(launches(h.calls).length, 1);
  assert.ok(!h.calls.some(a => a[0].startsWith('kill') || a.includes('-k')));
  assert.equal(h.floor.snapshot().workers.length, 0); assert.equal(h.jobs(), before);
});

test('healthy owned controller reused; confirmed dead controller respawns without -k', t => {
  for (const dead of ['0','1']) {
    const h = fixture(t, { parent: '$10', dead }), before = h.jobs(); h.floor.command('start', 'start');
    assert.equal(ensureController(h.floor, h.execute), '$10');
    assert.equal(launches(h.calls).length, dead === '1' ? 1 : 0);
    if (dead === '1') { assert.equal(launches(h.calls)[0][0], 'respawn-pane'); assert.ok(!launches(h.calls)[0].includes('-k')); }
    assert.equal(h.jobs(), before);
  }
});

test('foreign and ambiguous controller ownership refuse without launching or killing', t => {
  for (const options of [{ tag: 'foreign' }, { owner: '$999' }, { dead: 'uncertain' }, { healthStatus: 1 }]) {
    const h = fixture(t, { parent: '$10', ...options }), before = h.jobs(); h.floor.command('start', 'start');
    assert.throws(() => ensureController(h.floor, h.execute), /not owned|outside|unavailable/);
    assert.equal(launches(h.calls).length, 0); assert.ok(!h.calls.some(a => a[0].startsWith('kill')));
    assert.equal(h.jobs(), before);
  }
});

test('absent parent with undrained worker refuses a second parent', t => {
  const h = fixture(t, { parent: '$2090', missing: true }); h.floor.command('start', 'start');
  const db = new DatabaseSync(h.database);
  db.prepare('INSERT INTO swarm_workers(session,sender,pane,state,cleaned,tmux_session,slot,launch_config) VALUES(?,?,?,?,?,?,?,?)')
    .run('held', '12345678', '%90', 'active', 0, '$90', 'a', JSON.stringify(h.floor.settings().slots[0])); db.close();
  assert.throws(() => ensureController(h.floor, h.execute), /undrained/); assert.equal(launches(h.calls).length, 0);
});

test('source roots select approved openFloor only; reader exports and native hook stay intact', t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-wiring-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['reader','approved','room']) {
    const floors = join(dir, name, 'extensions/dark-factory/floors'); mkdirSync(floors, { recursive: true });
    writeFileSync(join(floors, 'runtime.mjs'), `export const marker=${JSON.stringify(name)}; export const openFloor=(id,options)=>({source:marker,id,options});`);
    writeFileSync(join(floors, 'supervisor.mjs'), 'export const ensureFloorController=()=>"native";');
    writeFileSync(join(floors, 'room.mjs'), `export const serveFloors=()=>${JSON.stringify(name)};`);
  }
  const script = `import assert from 'node:assert/strict'; import {runtime,ensureController,serveFloors} from ${JSON.stringify(new URL('./wiring.mjs', import.meta.url).href)};
    import {ensureFloorController} from ${JSON.stringify(pathToFileURL(join(dir, 'approved/extensions/dark-factory/floors/supervisor.mjs')).href)};
    assert.equal(ensureController,ensureFloorController); assert.equal(runtime.marker,'reader'); assert.equal(serveFloors(),'room');
    assert.deepEqual(runtime.openFloor('chosen',{root:'/fixture'}),{source:'approved',id:'chosen',options:{root:'/fixture'}});
    assert.equal(runtime.openFloor('other').source,'reader'); assert.equal(runtime.openFloor('core').source,'reader');`;
  const result = spawnSync(process.execPath, ['--input-type=module','-e',script], { encoding: 'utf8', env: { ...process.env,
    FACTORY_READER_CODE: join(dir, 'reader'), FACTORY_CONTROLLER_CODE: join(dir, 'approved'), FACTORY_ROOM_CODE: join(dir, 'room'), FACTORY_CONTROLLER_FLOOR: 'chosen' } });
  assert.equal(result.status, 0, result.stderr);
});

test('gateway uses private config and loopback port/root; refuses exposed or missing capability', async t => {
  const h = fixture(t), config = join(h.dir, 'hosting.json'), token = 'a'.repeat(64);
  writeFileSync(config, JSON.stringify({ token }), { mode: 0o600 });
  await assert.rejects(startGateway({}), /FACTORY_HOSTING_CONFIG/);
  const env = { FACTORY_HOSTING_CONFIG: config, FACTORY_ROOT: h.root, FACTORY_GATEWAY_PORT: '0' };
  chmodSync(config, 0o644); await assert.rejects(startGateway(env), /private owned/); chmodSync(config, 0o600);
  writeFileSync(config, '{}'); await assert.rejects(startGateway(env), /capability/);
  writeFileSync(config, JSON.stringify({ token })); await assert.rejects(startGateway({ ...env, FACTORY_GATEWAY_PORT: 'invalid' }), /port/);
  const room = await startGateway(env); t.after(() => new Promise(r => room.server.close(r)));
  assert.equal(room.token, token); assert.equal(room.server.address().address, '127.0.0.1');
  const state = await (await fetch(`${room.origin}/api/floors/core/state`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(state.status, 'stopped'); assert.equal(h.calls.length, 0);
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).token, token);
});
