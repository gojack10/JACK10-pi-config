import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { openFloor } from './runtime.mjs';
import { floorScope } from './cli.mjs';
import { configuration, openBoard } from '../../bf2-swarm/board.mjs';
import { launchJob, cancelJob } from '../../bf2-swarm/jobs.mjs';

export const HELP = `factory-job — independent machine jobs (no model/controller launch)
  factory-job launch [--floor ID] --key UUID --command-file FILE [--cwd PATH] [--owner NODE_UUID]
    [--stopped-operation 'explicit human authorization reason']
  factory-job list [--floor ID]
  factory-job pending [--floor ID]       Unhandled completions only
  factory-job handled [--floor ID] --key UUID --reason 'recorded evidence/action pointer'
  factory-job status [--floor ID] --key UUID
  factory-job cancel --floor ID --key UUID
  factory-job override-context --floor ID --session UUID --reason 'explicit human scope'
  --floors-dir PATH (or FACTORY_ROOT) selects the discovery root.
Workers use their launch-assigned floor. Cancellation and context overrides require an outside operator.
A stopped-operation launch requires an outside operator, an owner and a stopped/drained floor.
It records the separate authorization without starting workers or changing the floor's Stop.
Keep the UUID key before launching; retrying it never starts a second process.
Command, cwd, source revision, origin, control, log and receipts stay in the returned job directory.
Status/Stop/worker retirement do not cancel jobs. A terminal event is not project acceptance.
Mark handled only after inspecting and recording/acting on the result, including failures.
Handling is shared across replacements; it retains receipts and does not assert success.
Cancellation fails closed if runner identity/control or actual process-group drain cannot be established.
Commands which detach descendants outside their process group need their own verified control/drain contract.
Context override applies only to this occupant; it does not resume a stopped floor or undo final done.
`;
export async function main(args = process.argv.slice(2), env = process.env) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, floor: { type: 'string' }, 'floors-dir': { type: 'string' }, key: { type: 'string' },
    'command-file': { type: 'string' }, cwd: { type: 'string' }, owner: { type: 'string' }, 'stopped-operation': { type: 'string' }, session: { type: 'string' }, reason: { type: 'string' },
  } });
  if (values.help) { console.log(HELP); return; }
  const [command] = positionals;
  const allowed = { launch: ['key','command-file','cwd','owner','stopped-operation'], list: [], pending: [], handled: ['key','reason'], status: ['key'], cancel: ['key'], 'override-context': ['session','reason'] };
  if (positionals.length !== 1 || !Object.hasOwn(allowed, command)) throw new Error('use factory-job -h');
  for (const key of Object.keys(values)) if (!['floor','floors-dir',...allowed[command]].includes(key)) throw new Error(`--${key} is not valid for ${command}`);
  if (['launch','status','cancel','handled'].includes(command) && !values.key) throw new Error(`${command} requires --key UUID`);
  if (command === 'launch' && !values['command-file']) throw new Error('launch requires --command-file FILE');
  if (command === 'handled' && !values.reason) throw new Error('handled requires --reason evidence/action pointer');
  if (values['stopped-operation'] !== undefined && ['FACTORY_FLOOR','FACTORY_DB','FACTORY_SESSION','FACTORY_SENDER','BF2_BOARD_SESSION','BF2_BOARD_SENDER','BF2_SWARM_WORKER'].some(name => env[name] !== undefined)) throw new Error('stopped operation requires an outside authorized operator');
  const scope = floorScope(values.floor, env);
  if (['cancel','override-context'].includes(command) && (scope.worker || env.BF2_BOARD_SESSION !== undefined)) throw new Error('explicit job cancellation/context override requires an outside authorized operator');
  const floor = openFloor(scope.floor, values['floors-dir'] ?? env.FACTORY_ROOT ? { root: values['floors-dir'] ?? env.FACTORY_ROOT } : {});
  let peer;
  try {
    if (scope.worker) {
      if (realpathSync(scope.worker.database) !== realpathSync(floor.database)) throw new Error('worker database does not match floor');
      peer = openBoard(configuration(env));
    }
    const board = peer ?? floor.board, config = peer ? configuration(env) : floor.config;
    let result;
    if (command === 'launch') result = launchJob(board, config, { id: values.key, command: readFileSync(values['command-file'], 'utf8'), cwd: values.cwd ?? floor.settings().cwd, owner: values.owner ?? null, stoppedOperation: values['stopped-operation'] });
    else if (command === 'override-context') result = floor.board.lifecycle.overrideContextStop(values.session, values.reason);
    else if (command === 'handled') result = board.jobs.handle(values.key, values.reason);
    else if (command === 'pending') result = board.jobs.pending().map(j => ({ id: j.id, owner: j.manifest.owner, state: j.terminal.state, code: j.terminal.code, drained: j.terminal.drained }));
    else {
      const jobs = board.jobs.observe();
      result = command === 'list' ? jobs : jobs.find(j => j.id === values.key);
      if (!result) throw new Error('unknown job key');
      if (command === 'cancel') result = await cancelJob(result);
    }
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { peer?.close(); floor.close(); }
}
