import { readFileSync } from 'node:fs';
import { configuration, openBoard } from './board.mjs';

const textOf = content => typeof content === 'string' ? content :
  content?.filter(b => b.type === 'text').map(b => b.text).join('');

// A single session owns this receiver. No routing, broker, or lifecycle controller.
export function receiver(pi, config, ctx) {
  if (ctx.sessionManager.getSessionId() !== config.session || !ctx.sessionManager.getSessionFile()) {
    throw new Error('board receiver requires a persistent Pi session matching BF2_BOARD_SESSION');
  }
  const board = openBoard(config);
  let closed = false;
  let running = false;
  let admitted;
  let lastError;
  const current = () => !closed && ctx.sessionManager.getSessionId() === config.session && board.lifecycle.acceptsInput();
  const warn = error => {
    const message = `BF2 board: ${error.message ?? error}`;
    if (lastError !== message) {
      lastError = message;
      console.error(message); // No injected model message for receiver errors.
    }
  };
  return {
    async pump() {
      if (!current() || running) return;
      running = true;
      try {
        let batch = board.pending();
        if (!batch) return;
        // message_end extensions run BEFORE Pi appends the entry. Inspect on a
        // later tick/turn instead; do not equate an admission receipt with storage.
        const matches = entry => entry.type === 'message' && entry.message.role === 'user' &&
          textOf(entry.message.content) === batch.text;
        const selected = ctx.sessionManager.getBranch().find(matches);
        // SessionManager appends in memory before its synchronous file write. A
        // branch entry alone could survive a failed write; require disk evidence.
        // ponytail: scan JSONL only for a matching pending entry; index if large sessions make this costly.
        const persisted = selected && readFileSync(ctx.sessionManager.getSessionFile(), 'utf8')
          .split('\n').some(line => {
            let entry;
            try { entry = JSON.parse(line); }
            catch { return false; } // Pi's loader skips blank/malformed physical lines too.
            return entry?.id === selected.id && matches(entry);
          });
        if (persisted) {
          board.confirmPersisted(batch.key);
          admitted = undefined;
          batch = board.pending();
          if (!batch) return;
        }
        if (admitted === batch.key) return;
        const receipt = await pi.sendUserMessage(batch.text, {
          deliverAs: 'steer', expandPromptTemplates: false,
          admissionKey: `bf2-board:${batch.key}`, admissionGuard: current,
        });
        if (!current()) return;
        if (receipt.status === 'rejected') throw new Error(`admission rejected (${receipt.reason}): ${receipt.error}`);
        if (!['steer', 'turn'].includes(receipt.delivery)) {
          admitted = batch.key;
          throw new Error('input was handled instead of becoming USER input; pending retained, repair input handler and restart');
        }
        admitted = batch.key;
        lastError = undefined;
        // Durable pending remains until the exact USER entry is observed.
      } catch (error) { warn(error); }
      finally { running = false; }
    },
    close() { if (!closed) { closed = true; board.close(); } },
  };
}

export function installReceiver(pi, env = process.env) {
  if (!['BF2_BOARD_DB', 'BF2_BOARD_RUN', 'BF2_BOARD_SESSION', 'BF2_BOARD_SENDER'].some(key => env[key] !== undefined)) return;
  const config = configuration(env); // Partial/invalid opt-in refuses before opening SQLite.
  let active;
  let timer;
  const stop = () => { clearInterval(timer); timer = undefined; active?.close(); active = undefined; };
  pi.on('session_start', async (_event, ctx) => {
    stop();
    active = receiver(pi, config, ctx);
    timer = setInterval(() => { void active?.pump(); }, 1000);
    timer.unref();
    await active.pump();
  });
  pi.on('turn_end', async () => { await active?.pump(); });
  pi.on('session_shutdown', stop);
}
