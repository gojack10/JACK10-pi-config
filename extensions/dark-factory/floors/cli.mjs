import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const HELP = `factory — peer factory floors (Node 24)

Usage:
  factory create --floor ID --settings FILE   Create a stopped floor
  factory list                               Discover floors
  factory status --floor ID                  Settings, workers and ballot
  factory config --floor ID                  Read settings
  factory config --floor ID --settings FILE  Apply a settings patch
  factory message --floor ID 'text' [--key KEY]
  factory start --floor ID [--key KEY]        Explicit start/reconvene
  factory stop --floor ID [--key KEY]         Graceful drain, no replacement
  factory adopt --floor ID --run-dir PATH --settings FILE
  factory oss [--floor ID | --none]           View/select the managed OSS floor
  factory -h | --help

FILE is a JSON object imported into the floor SQLite, not a live settings file.
Creation never starts workers. Adoption retains the existing database/history.
--floors-dir PATH selects an absolute discovery directory (also FACTORY_ROOT).
Outside workers --floor is required; no last-used-floor fallback.
Workers inherit FACTORY_FLOOR/DB/SESSION/SENDER; do not replace their identity.
See extensions/dark-factory/README.md for the settings schema and approval boundary.
`;

const options = {
  help: { type: 'boolean', short: 'h' }, floor: { type: 'string' },
  'floors-dir': { type: 'string' }, settings: { type: 'string' },
  'run-dir': { type: 'string' }, key: { type: 'string' }, none: { type: 'boolean' },
};

export function floorScope(floor, env = process.env) {
  const names = ['FACTORY_FLOOR', 'FACTORY_DB', 'FACTORY_SESSION', 'FACTORY_SENDER'];
  const bound = names.some(name => env[name] !== undefined);
  if (bound && names.some(name => !env[name])) throw new Error('incomplete FACTORY worker binding; require FLOOR, DB, SESSION and SENDER');
  if (bound && floor !== undefined && floor !== env.FACTORY_FLOOR) throw new Error('cannot change a worker’s launch-assigned floor');
  const id = floor ?? (bound ? env.FACTORY_FLOOR : undefined);
  if (!id) throw new Error('--floor is required outside a launched factory worker');
  if (bound && !isAbsolute(env.FACTORY_DB)) throw new Error('FACTORY_DB must be absolute');
  return { floor: id, ...(bound ? { worker: { database: env.FACTORY_DB, session: env.FACTORY_SESSION, sender: env.FACTORY_SENDER } } : {}) };
}

export function parseCommand(args, env = process.env) {
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
  if (values.help) return { command: 'help' };
  const [command, ...rest] = positionals;
  const allowed = {
    create: ['floor', 'settings'], list: [], status: ['floor'],
    config: ['floor', 'settings'], message: ['floor', 'key'],
    start: ['floor', 'key'], stop: ['floor', 'key'],
    adopt: ['floor', 'run-dir', 'settings'], oss: ['floor', 'none'],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error('expected create, list, status, config, message, start, stop, adopt or oss; use factory -h');
  for (const key of Object.keys(values)) {
    if (key !== 'floors-dir' && !allowed[command].includes(key)) throw new Error(`--${key} is not supported for ${command}`);
  }
  if (rest.length !== (command === 'message' ? 1 : 0)) throw new Error(`unexpected arguments for ${command}; use factory -h`);
  if (['create', 'adopt'].includes(command) && !values.settings) throw new Error(`${command} requires --settings FILE`);
  if (['create', 'adopt'].includes(command) && !values.floor) throw new Error(`${command} requires an explicit --floor ID`);
  if (command === 'adopt' && (!values['run-dir'] || !isAbsolute(values['run-dir']))) throw new Error('adopt requires an absolute --run-dir PATH');
  const floorsDir = values['floors-dir'] ?? env.FACTORY_ROOT;
  if (floorsDir !== undefined && !isAbsolute(floorsDir)) throw new Error('--floors-dir must be absolute');
  if (values.key !== undefined && !values.key.trim()) throw new Error('--key must be nonempty');
  if (command === 'oss' && values.floor !== undefined && values.none) throw new Error('oss accepts --floor or --none, not both');
  const scope = command === 'list' || (command === 'oss' && values.floor === undefined) ? {} : floorScope(values.floor, env);
  if (['create', 'adopt', 'start', 'stop', 'message'].includes(command) || (command === 'config' && values.settings !== undefined) || (command === 'oss' && (values.floor !== undefined || values.none))) {
    if (env.FACTORY_SESSION !== undefined || env.BF2_BOARD_SESSION !== undefined) throw new Error('owner controls require an outside operator; workers use board');
  }
  let settings;
  if (values.settings !== undefined) {
    settings = JSON.parse(readFileSync(values.settings, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('--settings must contain a JSON object');
  }
  return { command, ...scope, ...(floorsDir !== undefined ? { floorsDir } : {}),
    ...(settings !== undefined ? { settings } : {}), ...(values.key !== undefined ? { key: values.key } : {}),
    ...(command === 'message' ? { text: rest[0] } : {}), ...(command === 'adopt' ? { runDir: values['run-dir'] } : {}),
    ...(values.none ? { none: true } : {}) };
}

async function operations() {
  return { ...await import('./runtime.mjs'), ...await import('./supervisor.mjs') };
}

export async function main(args = process.argv.slice(2), env = process.env, output = process.stdout, api) {
  const input = parseCommand(args, env);
  const print = text => new Promise((resolve, reject) => output.write(text + '\n', error => error ? reject(error) : resolve()));
  if (input.command === 'help') { await print(HELP); return; }
  api ??= await operations();
  const options = input.floorsDir === undefined ? {} : { root: input.floorsDir };
  let result;
  if (input.command === 'list') result = api.listFloors(options);
  else if (input.command === 'create') result = api.createFloor(input.settings, { ...options, id: input.floor });
  else if (input.command === 'adopt') result = api.adoptFloor(input.runDir, input.settings, { ...options, id: input.floor });
  else if (input.command === 'oss') result = input.floor || input.none ? api.selectOssFloor(input.floor ?? null, options) : api.ossStatus(options);
  else {
    const floor = api.openFloor(input.floor, options);
    try {
      if (input.worker && realpathSync(input.worker.database) !== realpathSync(floor.database)) throw new Error('launch database does not match selected floor');
      if (input.command === 'status') result = { id: floor.id, database: floor.database, ...floor.snapshot() };
      else if (input.command === 'config') result = input.settings === undefined ? floor.settings() : floor.configure(input.settings);
      else {
        if (input.command === 'start') api.validateFloorLaunch(floor.board.lifecycle.status().config);
        const key = input.key ?? randomUUID();
        result = { ...floor.command(key, input.command, input.text ?? null), floor: floor.id };
        const state = floor.snapshot();
        if (state.status === 'running' || state.pending || state.draining) {
          try { result.controller = api.ensureFloorController(floor, undefined, env); }
          catch (error) { result.controllerError = error.message; }
        }
      }
    } finally { floor.close(); }
  }
  await print(JSON.stringify(result, null, 2));
  if (result?.controllerError) throw new Error(`command ${result.key} was saved; controller recovery failed: ${result.controllerError}`);
  return result;
}
