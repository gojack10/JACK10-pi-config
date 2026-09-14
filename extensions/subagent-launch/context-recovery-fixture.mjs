// No-provider interactive child used ONLY by context-recovery.test.ts.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { loadExtensions } = await import(pathToFileURL(`${process.env.PI_TEST_PACKAGE}/dist/core/extensions/loader.js`));
const { SessionManager, estimateTokens } = await import(pathToFileURL(`${process.env.PI_TEST_PACKAGE}/dist/index.js`));
const friendly = process.env.PI_TEST_RECOVERY_CASE === 'friendly';
const initialTokens = friendly ? 140000 : 259495;
if (!friendly && Object.keys(process.env).some(key => key.startsWith('PI_RLM_FRIENDLY_STOP_') || key === 'PI_RLM_ROLLOVER_DIR')) {
  throw new Error('unconfigured worker inherited friendly-stop settings');
}
const pane = process.env.TMUX_PANE;
const tmux = args => execFileSync('tmux', args, { encoding: 'utf8' }).trim();
const manifest = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(tmux(['show-options', '-qv', '-t', pane, '@pi_subagent_manifest']), 'utf8')));
const paths = ['task-outcomes.ts', 'tmux-turn-signal.ts', 'subagent-launch.ts', 'openai-272k-guard.ts']
  .map(name => join(process.env.PI_TEST_EXTENSIONS, name));
if (friendly) paths.push(join(process.env.PI_TEST_EXTENSIONS, '../optional-extensions/rlm-friendly-stop.ts'));
let sm = SessionManager.create(process.cwd(), process.cwd());
const sessionFile = sm.getSessionFile();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: initialTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
sm.appendMessage({ role: 'user', content: 'Complete the assigned report.', timestamp: Date.now() });
sm.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 'retained progress' +
  (process.env.PI_TEST_RECOVERY_CASE === 'insufficient' ? 'x'.repeat(1_200_000) : '') },
  { type: 'toolCall', id: 'large-read', name: 'read', arguments: { path: '/fake' } }],
  provider: 'openai-test', model: 'fake', api: 'openai-responses', stopReason: 'toolUse', usage, timestamp: Date.now() });
sm.appendMessage({ role: 'toolResult', toolCallId: 'large-read', toolName: 'read', content: [{ type: 'text', text: 'large output '.repeat(1000) }],
  details: { preserve: true }, isError: false, timestamp: Date.now() });
let loaded, ctx;
let resumed = false;
let started = false;
let idle = true;
let aborted = false;
const emit = async (name, event = {}) => {
  for (const ext of loaded.extensions) for (const handler of ext.handlers.get(name) ?? []) await handler(event, ctx);
};
const task = () => globalThis[Symbol.for('pi.task-outcomes.manager-registry')].get(sm);
const commands = () => loaded.extensions.flatMap(ext => [...ext.commands.entries()]);
async function bind() {
  loaded = await loadExtensions(paths, process.cwd());
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  loaded.runtime.appendEntry = (type, data) => sm.appendCustomEntry(type, data);
  loaded.runtime.sendUserMessage = text => { throw new Error(`unexpected model request: ${text}`); };
  ctx = {
    cwd: process.cwd(), mode: 'tui', hasUI: false, sessionManager: sm,
    model: { provider: 'openai-test', id: 'fake', contextWindow: 272000, cost: {} },
    ui: { setStatus() {}, notify() {} },
    isIdle: () => idle, waitForIdle: async () => { if (!idle) throw new Error('not idle'); },
    hasPendingMessages: () => process.env.PI_TEST_RECOVERY_CASE === 'queued', abort: () => { aborted = true; },
    getContextUsage: () => ({ tokens: resumed ? sm.buildSessionContext().messages.reduce((n, msg) => n + estimateTokens(msg), 0) : friendly && !started ? 1000 : initialTokens,
      contextWindow: 272000, percent: null }),
    switchSession: async (file, options) => {
      if (process.env.PI_TEST_RECOVERY_CASE === 'cancel') return { cancelled: true };
      const maintenance = options.maintenance;
      const anchor = sm.getLeafId();
      const manager = task();
      const extensionInstances = loaded;
      if (maintenance?.beforeReplace) {
        const prepared = await maintenance.beforeReplace();
        if (prepared?.replace === false) {
          await prepared.afterNoReplace?.();
          return { cancelled: false };
        }
      }
      if (maintenance) {
        // In-place refresh: preserve the SessionManager and extension instances.
        sm.setSessionFile(file);
        if (anchor === null) sm.resetLeaf();
        else sm.branch(anchor);
        if (task() !== manager || loaded !== extensionInstances) throw new Error('maintenance replaced the live owner');
        resumed = true;
      } else {
        await emit('session_shutdown', { reason: 'resume', targetSessionFile: file });
        sm = SessionManager.open(file);
        resumed = true;
        await bind();
        await emit('session_start', { reason: 'resume', previousSessionFile: file });
      }
      await options.withSession({ ...ctx, sendUserMessage: async text => {
        if (!text.includes('Continue the same assignment')) throw new Error('missing continuation');
        await finish();
      } });
      return { cancelled: false };
    },
  };
}
async function finish() {
  const active = task().snapshot().active;
  if (active?.attemptId !== manifest.attemptId || active.state !== 'active') throw new Error('assignment was lost');
  idle = false;
  aborted = false;
  await emit('agent_start');
  if (friendly && !sm.getBranch().some(e => e.customType === 'rlm-friendly-stop-state' && e.data?.phase === 'reset')) {
    throw new Error('friendly stop did not re-arm after persisted resume');
  }
  await emit('before_provider_request', { payload: { input: ['safe'], tools: [{}] } });
  if (aborted) throw new Error('cleaned context was blocked again');
  writeFileSync(manifest.reportPath, `same attempt ${active.attemptId}; same session ${sm.getSessionId()}\n`);
  const report = loaded.extensions.find(ext => ext.tools.has('report_outcome')).tools.get('report_outcome').definition;
  await report.execute('report', { outcome: 'completed', summary: 'recovered assignment completed' }, undefined, undefined, ctx);
  const assistant = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }], usage, timestamp: Date.now() };
  sm.appendMessage(assistant);
  await emit('agent_end', { messages: [assistant] });
  idle = true;
  await emit('agent_settled');
}
await bind();
await emit('session_start', { reason: 'startup' });
started = true;
idle = false;
await emit('agent_start');
if (friendly) {
  if (process.env.PI_RLM_FRIENDLY_STOP_TOKENS !== undefined || process.env.PI_RLM_FRIENDLY_STOP_MODEL !== 'fake' ||
      process.env.PI_RLM_FRIENDLY_STOP_PERCENT !== '40') throw new Error('launcher opt-in environment is wrong');
  await emit('turn_end', {});
  await emit('context', { messages: [] });
  const checkpoint = loaded.extensions.find(ext => ext.tools.has('rlm_rollover_checkpoint'))?.tools.get('rlm_rollover_checkpoint').definition;
  if (!checkpoint) throw new Error('friendly extension was not enabled by canonical launch');
  const result = await checkpoint.execute('checkpoint', { completedOperationIds: ['probe'], nextOperation: 'finish',
    symbolicUuidBindings: {}, failures: [], receiptPaths: [], notes: 'retained progress' }, undefined, undefined, ctx);
  if (!result.terminate) throw new Error('checkpoint must terminate the model turn');
} else {
  await emit('before_provider_request', { payload: { input: ['not transmitted'], tools: [{}] } });
  if (!aborted) throw new Error('real guard did not block synthetic context');
}
const abortedMessage = { role: 'assistant', stopReason: friendly ? 'toolUse' : 'aborted',
  ...(friendly ? {} : { errorMessage: 'Operation aborted' }), content: [], usage, timestamp: Date.now() };
sm.appendMessage(abortedMessage);
await emit('agent_end', { messages: [abortedMessage] });
idle = true;
await emit('agent_settled');
const paused = task().snapshot().active;
if (paused?.state !== 'context_paused') throw new Error('guard did not retain paused assignment');
writeFileSync(join(process.cwd(), 'paused.json'), JSON.stringify({ ...paused, sessionFile, piSessionId: sm.getSessionId() }));
if (process.env.PI_TEST_RECOVERY_CASE === 'busy') idle = false;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.startsWith('/')) continue;
  const [name, ...args] = line.trim().slice(1).split(' ');
  const entry = commands().find(([command]) => command === name);
  if (!entry) throw new Error(`unknown local command ${name}`);
  await entry[1].handler(args.join(' '), ctx);
}
