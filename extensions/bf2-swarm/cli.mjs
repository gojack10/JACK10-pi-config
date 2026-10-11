import { parseArgs } from 'node:util';
import { configuration as boardConfiguration, openBoard as openLegacyBoard, formatPosts } from './board.mjs';
import { floorScope, main as factoryMain } from '../dark-factory/floors/cli.mjs';

export const HELP = `board — launch-scoped peer board (Node 24)

Factory floor mode:
  board post 'text'                  Worker post on its launch-bound floor
  board read                        Startup snapshot plus current owner condition
  board status                      Current owner condition, ballot and workers
  board done 'handoff'               Request graceful retirement
  board vote NUMBER yes|no          Vote on the owner's configured condition
  board --floor ID read             Outside operator: selected floor history
  board --floor ID post 'text'      Outside operator: attributed owner input
  --floors-dir PATH                  Alternate absolute discovery root

FACTORY_FLOOR/DB/SESSION/SENDER bind worker identity; FACTORY_ROOT selects discovery.
Workers cannot change floors. Outside floor operators must provide --floor.
Only workers vote/retire; they cannot replace the owner's ballot question.
Floor post as an outside operator has factory message wake/recovery semantics.

Legacy BF2 mode (unchanged when only BF2_BOARD_* launch variables are present):

Usage:
  board post 'text'                  Persist an attributed numbered post
  board read                        Startup: latest 30 plus retained owner wake
  board read --limit 100             History only (1-100)
  board read --before 42 --limit 30  Older history only; exclusive post number
  board done 'handoff'              Post once and request safe retirement
  board pause KEY 'reason'         Request pause for factory owner, proposer yes
  board vote NUMBER yes|no         Cast one immutable ballot on that pause
                                  One no cancels; three yes wait; no timeout
                                  KEY is your stable retry key for this intent
  board -h | --help                 Help, without opening a database

Launch configuration (required, inherited by CLI and Pi):
  BF2_BOARD_DB       Absolute dedicated SQLite path; parent must exist.
                    Keep outside knowledge/code worktrees and /tmp for real runs.
  BF2_BOARD_RUN      Same run ID for all peers; one database per run.
  BF2_BOARD_SESSION  Explicit Pi session ID (launch with --session-id).
  BF2_BOARD_SENDER   Unique launch-assigned 8 lowercase hex digits per session.

Use the worktree's bin/board directly, or before a later authorized launch:
  export PATH="/absolute/path/to/this/worktree/bin:$PATH"
  tests_pass && board post 'tests passed'
No PATH install or home settings change is needed. Do not replace inherited identity.

Agent startup: follow assigned tree read order, then plain board read ONCE.
Plain first read establishes a snapshot boundary only after successful stdout.
The optional Pi receiver waits for that read; newer peer posts are pushed as USER
input using steer. History options never consume pending pushes. If confused,
use board -h. Durable progress belongs on the tree; transient coordination here.
Posts are broadcasts, not commands, routed messages or ACKs. Experimental done
and vote require registered active sessions; done is NOT an immediate process kill.
Only agents propose/vote. One open pause, three fixed current active peers.
No capacity-gap votes, withdrawals, reason edits or generic polls. Repeating a
KEY/reason or the same ballot returns its stored result without another post.
Voter retirement/departure cancels an incomplete pause. Waiting is not BF2 success.
For operator start/status/stop/resume controls, use bf2-swarm -h.
Admission != persisted USER input != model comprehension. See
extensions/bf2-swarm/README.md for restart, duplicate, and crash boundaries.
`;

export async function main(args = process.argv.slice(2), env = process.env, output = process.stdout, api) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, limit: { type: 'string' }, before: { type: 'string' },
      floor: { type: 'string' }, 'floors-dir': { type: 'string' } } });
  const print = text => new Promise((resolve, reject) => output.write(text + '\n', error => error ? reject(error) : resolve()));
  if (values.help) { await print(HELP); return; }
  const [command, ...rest] = positionals;
  if (!['post', 'read', 'status', 'done', 'pause', 'vote'].includes(command)) throw new Error('expected post, read, status, done, pause or vote; use board -h');
  if (command !== 'read' && (values.limit !== undefined || values.before !== undefined)) throw new Error('history options require read');
  if (['post', 'done'].includes(command) && rest.length !== 1) throw new Error(`usage: board ${command} 'text'`);
  if (['read', 'status'].includes(command) && rest.length) throw new Error(`usage: board ${command} [--floor ID]`);
  if (command === 'pause' && rest.length !== 2) throw new Error("usage: board pause KEY 'reason'");
  if (command === 'vote' && (rest.length !== 2 || !['yes','no'].includes(rest[1]))) throw new Error('usage: board vote NUMBER yes|no');
  const integer = value => {
    if (!/^\d+$/.test(value)) throw new Error('history options require positive integers');
    return Number(value);
  };
  const options = { ...(values.limit !== undefined ? { limit: integer(values.limit) } : {}),
    ...(values.before !== undefined ? { before: integer(values.before) } : {}) };
  const scoped = values.floor !== undefined || ['FACTORY_FLOOR', 'FACTORY_DB', 'FACTORY_SESSION', 'FACTORY_SENDER'].some(name => env[name] !== undefined);
  if (values.floor !== undefined && env.BF2_BOARD_SESSION !== undefined && env.FACTORY_SESSION === undefined) throw new Error('legacy BF2 workers use their launch database; cannot select a factory floor');
  const scope = scoped ? floorScope(values.floor, env) : null;
  if (values['floors-dir'] !== undefined && !scope) throw new Error('--floors-dir requires a factory floor');
  if (scope && !scope.worker) {
    const root = values['floors-dir'] ?? env.FACTORY_ROOT;
    if (command === 'post') return factoryMain(['message', '--floor', scope.floor, ...(root ? ['--floors-dir', root] : []), rest[0]], env, output, api);
    if (!['read', 'status'].includes(command)) throw new Error('done, pause and vote require a launch-bound worker; use factory for owner controls');
    api ??= await import('../dark-factory/floors/runtime.mjs');
    const floor = api.openFloor(scope.floor, root === undefined ? {} : { root });
    try {
      if (command === 'status') { await print(JSON.stringify(floor.snapshot(), null, 2)); return; }
      const snapshot = floor.board.history(options);
      await print(`Floor ${floor.id}; owner condition: ${JSON.stringify(floor.settings().voteCondition)}\n${formatPosts(floor.config.run, snapshot.posts)}`);
      return;
    } finally { floor.close(); }
  }
  if (scope?.worker && values['floors-dir'] !== undefined) throw new Error('workers use their launch database, not --floors-dir');
  const config = (api?.configuration ?? boardConfiguration)(env);
  const board = (api?.openBoard ?? openLegacyBoard)(config);
  try {
    if (command === 'status') { await print(JSON.stringify(board.lifecycle.status(), null, 2)); return; }
    if (command === 'post' || command === 'done') {
      const number = command === 'done' ? board.lifecycle.done(rest[0]) : board.post(rest[0]);
      await print(`#${number} ${config.sender}${command === 'done' ? ' retirement requested (safe settlement pending)' : ''}`); return;
    }
    if (command === 'vote' || command === 'pause') {
      const vote = command === 'pause' ? board.lifecycle.pause(rest[0], rest[1]) : board.lifecycle.vote(integer(rest[0]), rest[1]);
      await print(`pause #${vote.number} ${vote.result}`); return;
    }
    const snapshot = board.history(options);
    const posts = snapshot.startup && values.limit === undefined && values.before === undefined ?
      [...new Map([...snapshot.wake, ...snapshot.posts].map(p => [p.number,p])).values()].sort((a,b) => a.number-b.number) : snapshot.posts;
    await print((scope ? `Floor ${scope.floor}; owner condition: ${JSON.stringify(board.lifecycle.status().floor.voteCondition)}\n` : '') + formatPosts(config.run, posts));
    if (snapshot.startup && values.limit === undefined && values.before === undefined) board.finishStartup(snapshot.highwater, snapshot.wake[0]?.number ?? null);
  } finally { board.close(); }
}
