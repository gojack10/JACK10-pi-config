import { parseArgs } from 'node:util';
import { configuration, openBoard, formatPosts } from './board.mjs';

export const HELP = `board — opt-in, one-run broadcast board (Node 24; no model calls)

Usage:
  board post 'text'                  Persist an attributed numbered post
  board read                        Startup: latest 30, chronological; then history
  board read --limit 100             History only (1-100)
  board read --before 42 --limit 30  Older history only; exclusive post number
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
Posts are broadcasts, not commands, routed messages, ACKs, or lifecycle signals.
Admission != persisted USER input != model comprehension. See
extensions/bf2-swarm/README.md for restart, duplicate, and crash boundaries.
`;

export async function main(args = process.argv.slice(2), env = process.env, output = process.stdout) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, limit: { type: 'string' }, before: { type: 'string' } } });
  const print = text => new Promise((resolve, reject) => output.write(text + '\n', error => error ? reject(error) : resolve()));
  if (values.help) { await print(HELP); return; }
  const [command, ...rest] = positionals;
  if (command !== 'post' && command !== 'read') throw new Error("expected post or read; use board -h");
  if (command === 'post' && (rest.length !== 1 || values.limit || values.before)) throw new Error("usage: board post 'text'");
  if (command === 'read' && rest.length) throw new Error('usage: board read [--limit 1-100] [--before NUMBER]');
  const integer = value => {
    if (!/^\d+$/.test(value)) throw new Error('history options require positive integers');
    return Number(value);
  };
  const options = { ...(values.limit !== undefined ? { limit: integer(values.limit) } : {}),
    ...(values.before !== undefined ? { before: integer(values.before) } : {}) };
  const config = configuration(env);
  const board = openBoard(config);
  try {
    if (command === 'post') { await print(`#${board.post(rest[0])} ${config.sender}`); return; }
    const snapshot = board.history(options);
    await print(formatPosts(config.run, snapshot.posts));
    if (snapshot.startup && values.limit === undefined && values.before === undefined) board.finishStartup(snapshot.highwater);
  } finally { board.close(); }
}
