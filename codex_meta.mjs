/** Meta Responses transport using the installed Pi runtime, auth and tool adapters. */
import { Tools } from "./codex_cloud_tools.mjs";
import { gatewayPath } from "./codex_cloud_config.mjs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODEL = "muse-wonder-full-1.0";
const BASE = "https://api.meta.ai/v1";
const piRoot = () => gatewayPath("pi_root", "CODEX_PI_ROOT");
const agentDir = () => gatewayPath("agent_dir", "CODEX_PI_AGENT_DIR", dirname(fileURLToPath(import.meta.url)));
const load = (file) => import(pathToFileURL(join(piRoot(), "packages", file)).href);
const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT", () => abort.abort());
process.stdout.on("error", () => abort.abort());
const write = (text) => new Promise((resolve, reject) => {
  process.stdout.write(text, (error) => error ? reject(error) : resolve());
});
const invalid = (message) => Object.assign(new Error(message), { status: 400 });

async function runtime() {
  const { ModelRuntime } = await load("coding-agent/dist/core/model-runtime.js");
  const { getSupportedThinkingLevels } = await load("ai/dist/models.js");
  const models = await ModelRuntime.create({
    authPath: join(agentDir(), "auth.json"), modelsPath: join(agentDir(), "models.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const model = models.getModel("meta", MODEL);
  if (!model || model.api !== "openai-responses" || model.baseUrl.replace(/\/+$/, "") !== BASE) {
    throw new Error(`Configure meta/${MODEL} with ${BASE} in Pi's models.json`);
  }
  return { models, model, levels: getSupportedThinkingLevels(model) };
}


async function prepare(payload, session, model, levels) {
  if (payload.model !== MODEL || payload.stream !== true) throw invalid(`Use ${MODEL} with stream=true`);
  if (payload.previous_response_id || payload.conversation) throw invalid("Replay the full input; stored Responses references are unavailable");
  if ((payload.text?.format?.type || "text") !== "text") throw invalid("Schema-constrained final output is unavailable on the Meta route");
  const effort = payload.reasoning?.effort || levels.at(-1);
  const level = effort === "none" ? "off" : effort;
  if (!levels.includes(level)) throw invalid(`Meta reasoning effort must be one of: ${levels.join(", ")}`);
  const tools = new Tools();
  tools.register(payload.tools || []);
  const input = tools.input(payload.input || []);
  const { convertResponsesTools } = await load("ai/dist/api/openai-responses-shared.js");
  const { aliasMetaSubscriptionTools } = await load("ai/dist/api/meta-subscription-tools.js");
  const { clampOpenAIPromptCacheKey } = await load("ai/dist/api/openai-prompt-cache.js");
  let instructions = payload.instructions || "";
  if (tools.hostedSearch) instructions += "\nOpenAI-hosted web search is unavailable on this model. Use an available browser or search function tool; do not claim to have searched without using one.";
  const params = {
    model: MODEL, input, instructions, stream: true, store: false,
    max_output_tokens: payload.max_output_tokens || model.maxTokens,
    reasoning: { effort: model.thinkingLevelMap?.[level] || effort, summary: payload.reasoning?.summary || "auto" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: clampOpenAIPromptCacheKey(payload.prompt_cache_key || session),
    tools: convertResponsesTools([...tools.declared.values()], { supportsStrictMode: false, supportsOpenAIGrammarTools: false }),
    tool_choice: tools.choice(payload.tool_choice || "auto"),
  };
  for (const key of ["temperature", "top_p", "parallel_tool_calls"]) {
    if (payload[key] !== undefined) params[key] = payload[key];
  }
  // Exactly the same installed compatibility function used by Pi's Meta path.
  return { ...aliasMetaSubscriptionTools(params), tools };
}

class Output {
  sequence = 0;
  items = new Map();
  ids = new Map();
  customDone = new Set();
  response;
  terminal = false;

  constructor(tools, wireNames) { this.tools = tools; this.wireNames = wireNames; }

  item(item, complete) {
    if (item.type === "reasoning") {
      const id = "rs_meta_" + item.id;
      this.ids.set(item.id, id);
      return { ...item, id };
    }
    if (item.type !== "function_call") return item;
    const spec = this.tools.byName.get(this.wireNames.get(item.name) || item.name);
    if (!spec) throw new Error("Meta returned an undeclared tool");
    this.items.set(item.id, spec);
    const result = { ...item, name: spec.name };
    delete result.namespace;
    if (spec.namespace) result.namespace = spec.namespace;
    if (spec.type === "custom") {
      result.type = "custom_tool_call";
      result.id = "ctc_meta_" + item.id;
      this.ids.set(item.id, result.id);
      result.input = complete ? this.customInput(item.arguments) : "";
      delete result.arguments;
    }
    return result;
  }

  customInput(arguments_) {
    const value = JSON.parse(arguments_).input;
    if (typeof value !== "string") throw new Error("Meta returned a custom tool without a text input");
    return value;
  }

  async emit(event) {
    const data = { ...event, sequence_number: this.sequence++ };
    if (data.item_id) data.item_id = this.ids.get(data.item_id) || data.item_id;
    await write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  async finishCustom(event, arguments_) {
    if (this.customDone.has(event.item_id)) return;
    const input = this.customInput(arguments_);
    const fields = { item_id: event.item_id, output_index: event.output_index };
    await this.emit({ type: "response.custom_tool_call_input.delta", ...fields, delta: input });
    await this.emit({ type: "response.custom_tool_call_input.done", ...fields, input });
    this.customDone.add(event.item_id);
  }

  async event(event) {
    if (event.type.startsWith("response.function_call_arguments.")) {
      const spec = this.items.get(event.item_id);
      if (spec?.type === "custom") {
        if (event.type.endsWith(".done")) await this.finishCustom(event, event.arguments);
        return;
      }
      if (spec && event.name) event = { ...event, name: spec.name };
    }
    if (event.item) {
      const complete = event.type === "response.output_item.done";
      const item = this.item(event.item, complete);
      if (complete && item.type === "custom_tool_call") {
        await this.finishCustom({ item_id: event.item.id, output_index: event.output_index }, event.item.arguments);
      }
      event = { ...event, item };
    }
    if (event.response) {
      this.response = event.response;
      event = { ...event, response: { ...event.response,
        output: (event.response.output || []).map((item) => this.item(item, event.response.status !== "in_progress")) } };
    }
    await this.emit(event);
    if (["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type)) this.terminal = true;
  }

  async fail(message) {
    await this.emit({ type: "response.failed", response: {
      ...(this.response || {}), object: "response", model: MODEL, status: "failed", output: [],
      error: { code: "meta_gateway_error", message },
    } });
  }
}

let started = false;
let output;
try {
  const { models, model, levels } = await runtime();
  if (process.argv.includes("--catalog")) {
    await write(JSON.stringify({ id: MODEL, context_length: model.contextWindow,
      input_modalities: model.input, thinking_levels: levels.map((level) => level === "off" ? "none" : level) }) + "\n");
  } else {
    const reader = createInterface({ input: process.stdin });
    const line = await new Promise((resolve, reject) => {
      reader.once("line", resolve);
      reader.once("close", () => reject(new Error("Request pipe closed")));
    });
    reader.close();
    process.stdin.on("end", () => abort.abort());
    process.stdin.resume();
    const { payload, session_id: session } = JSON.parse(line);
    const prepared = await prepare(payload, session, model, levels);
    const { configureHttpDispatcher } = await load("coding-agent/dist/core/http-dispatcher.js");
    configureHttpDispatcher(0);
    let auth;
    try { auth = await models.getAuth(model, { signal: abort.signal }); }
    catch { throw Object.assign(new Error("Pi Meta authentication could not refresh; sign in with /login meta in Pi"), { status: 401 }); }
    if (auth?.type !== "oauth" || !auth.auth.apiKey) throw Object.assign(new Error("This model requires Pi's Meta subscription login (/login meta)"), { status: 401 });
    if (auth.auth.baseUrl && auth.auth.baseUrl.replace(/\/+$/, "") !== BASE) throw new Error("Meta auth resolved an unexpected endpoint");
    const { getIdentityHeaders } = await load("ai/dist/utils/identity.js");
    const require = createRequire(join(piRoot(), "package.json"));
    const OpenAI = require("openai");
    const client = new OpenAI({ apiKey: auth.auth.apiKey, baseURL: BASE, maxRetries: 0,
      timeout: 2147483647, defaultHeaders: { ...getIdentityHeaders(model), ...auth.auth.headers,
        ...(session ? { session_id: session, "x-client-request-id": session } : {}) } });
    const { data: stream } = await client.responses.create(prepared.params, { signal: abort.signal }).withResponse();
    output = new Output(prepared.tools, prepared.toolNamesByWire);
    await write(JSON.stringify({ status: 200 }) + "\n");
    started = true;
    for await (const event of stream) await output.event(event);
    if (!output.terminal) throw new Error("Meta stream ended without a terminal response event");
  }
} catch (error) {
  if (!abort.signal.aborted) {
    const message = error instanceof Error ? error.message : "Meta gateway failed";
    if (started) await output.fail(message).catch(() => {});
    else await write(JSON.stringify({ status: Number.isInteger(error.status) ? error.status : 502,
      error: { type: "meta_gateway_error", message } }) + "\n").catch(() => {});
  }
  process.exitCode = 1;
} finally {
  process.stdin.destroy();
}
