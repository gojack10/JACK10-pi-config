// Real Pi admission/lifecycle and extensions; synthetic provider, isolated tmux only.
import { execFile } from 'node:child_process';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const pkg = process.env.PI_TEST_PACKAGE;
const root = process.env.PI_TEST_EXTENSIONS;
const cwd = process.cwd();
const { ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices, createAgentSessionFromServices } =
  await import(pathToFileURL(join(pkg, 'dist/index.js')).href);
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(pkg, '../ai/dist/index.js')).href);
const tmux = async args => (await exec('tmux', args)).stdout.trim();
const show = option => tmux(['show-options', '-qv', '-t', process.env.TMUX_PANE, option]);
const manifest = async () => JSON.parse(await readFile(await show('@pi_subagent_manifest'), 'utf8'));
const initial = await manifest();
const model = { provider: initial.provider, id: initial.model, name: 'Synthetic worker', api: 'test-followup',
  baseUrl: 'https://invalid.invalid', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { xhigh: 'xhigh' } };
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, 'auth.json'), modelsPath: join(cwd, 'models.json') });
await modelRuntime.setRuntimeApiKey(model.provider, 'synthetic-only');
const calls = new Map();
const heldSettlements = new Set();
modelRuntime.registerProvider(model.provider, { api: model.api, streamSimple: () => {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const m = await manifest();
    const count = (calls.get(m.attemptId) ?? 0) + 1;
    calls.set(m.attemptId, count);
    if (m.attemptId === initial.attemptId && count === 1) await tmux(['wait-for', `release-${initial.jobId}`]);
    const pendingChild = process.env.PI_TEST_PENDING_CHILD === 'yes' && m.attemptId === initial.attemptId;
    if (pendingChild && count === 1) {
      const manager = globalThis[Symbol.for('pi.task-outcomes.manager-registry')].get(session.sessionManager);
      manager.registerChild(m.jobId, 'synthetic-child');
      void tmux(['wait-for', `child-${initial.jobId}`]).then(() => manager.recordChildOutcome(m.jobId, 'synthetic-child', 'completed', 'drained'));
    }
    const declare = m.mode === 'task' && (count === 1 || (pendingChild && count === 3));
    if (declare) await writeFile(m.reportPath, `report ${m.attemptId}\n`);
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: declare ? [{ type: 'toolCall', id: `declare-${m.attemptId}`, name: 'report_outcome',
        arguments: { outcome: m.attemptId === initial.attemptId ? process.env.PI_TEST_FIRST_OUTCOME : 'completed', summary: `finished ${m.attemptId}` } }] : [{ type: 'text', text: `reply ${m.attemptId}` }],
      stopReason: declare ? 'toolUse' : 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'done', reason: message.stopReason, message });
    stream.end(message);
  })().catch(error => { console.error(error); process.exit(1); });
  return stream;
} });
const services = await createAgentSessionServices({ cwd, agentDir: cwd, modelRuntime,
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [join(root, 'task-outcomes.ts'), join(root, 'subagent-launch.ts'), join(root, 'tmux-turn-signal.ts')],
    extensionFactories: [pi => {
      pi.on('agent_start', async (_event, ctx) => appendFile(join(cwd, 'events.jsonl'), `${JSON.stringify({ kind: 'start',
        attempt: (await manifest()).attemptId, session: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(),
        provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel() })}\n`));
      pi.on('agent_settled', async () => {
        const m = await manifest();
        // Hold after outcome publication too: waitForIdle must include all settled handlers.
        if (m.attemptId === initial.attemptId && !heldSettlements.has(m.attemptId)) {
          heldSettlements.add(m.attemptId);
          await tmux(['wait-for', `settle-${initial.jobId}`]);
        }
        await appendFile(join(cwd, 'events.jsonl'), `${JSON.stringify({ kind: 'settled', attempt: m.attemptId })}\n`);
      });
    }],
  } });
const { session, extensionsResult } = await createAgentSessionFromServices({ services,
  sessionManager: SessionManager.create(cwd, cwd), model, thinkingLevel: 'xhigh' });
if (extensionsResult.errors.length) throw new Error(JSON.stringify(extensionsResult.errors));
await session.bindExtensions({ mode: 'tui', commandContextActions: { waitForIdle: () => session.waitForIdle() } });
// Launcher passes the initial mission as @file in the boot command.
const mission = process.argv.find(arg => arg.startsWith('@'))?.slice(1);
void session.prompt(await readFile(mission, 'utf8')).catch(error => { console.error(error); process.exit(1); });
const input = createInterface({ input: process.stdin, terminal: false });
input.on('line', line => {
  // tmux bracketed-paste wrappers, normally stripped by the TUI editor.
  const command = line.replace(/\x1b\[20[01]~/g, '').trim();
  if (command) void session.prompt(command).catch(error => { console.error(error); process.exit(1); });
});
