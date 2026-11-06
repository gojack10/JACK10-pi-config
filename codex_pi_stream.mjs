/** Translate Codex Responses through Pi's installed streaming providers. */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { Tools } from "./codex_cloud_tools.mjs";
import { gatewayPath } from "./codex_cloud_config.mjs";

const providers = {
  "amazon-bedrock": { api: "bedrock-converse-stream", replay: "bedrock", schemas: "bedrock" },
  openai: { api: "openai-responses", replay: "openai-api", schemas: "openai", base: "https://api.openai.com/v1" },
  openrouter: { api: "openai-completions", replay: "openrouter", schemas: "meta", base: "https://openrouter.ai/api/v1" },
};
const piRoot = () => gatewayPath("pi_root", "CODEX_PI_ROOT");
const load = (file) => import(pathToFileURL(join(piRoot(), "packages", file)).href);
const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT", () => abort.abort());
process.stdout.on("error", () => abort.abort());
const write = (text) => new Promise((resolve, reject) => process.stdout.write(text, (error) => error ? reject(error) : resolve()));
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function content(value, output = false) {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) throw invalid("Expected text or a content array");
  return value.map((part) => {
    if (["input_text", "output_text", "text"].includes(part.type)) return { type: "text", text: part.text };
    if (part.type === "input_image") {
      const match = /^data:(image\/[^;,]+);base64,([\s\S]+)$/.exec(part.image_url || "");
      if (!match) throw invalid("Image inputs require a base64 data URL");
      return { type: "image", mimeType: match[1], data: match[2] };
    }
    throw invalid(`Unsupported ${output ? "tool output" : "input"} content: ${part.type}`);
  });
}

function context(payload, tools, route) {
  tools.register(payload.tools || []);
  const input = tools.input(payload.input || [], (item) => [item]);
  const messages = [];
  let systemPrompt = payload.instructions || "";
  const currentAssistant = () => {
    if (messages.at(-1)?.role !== "assistant") {
      const { api, provider, id: model } = route.model;
      messages.push({ role: "assistant", api, provider, model, content: [],
        usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() });
    }
    return messages.at(-1);
  };
  for (const item of input) {
    const type = item.type || "message";
    if (type === "reasoning") {
      if (item.id?.startsWith(route.reasoningId) && item.encrypted_content?.startsWith(route.replay)) {
        const replay = JSON.parse(Buffer.from(item.encrypted_content.slice(route.replay.length), "base64").toString());
        if (replay.model === route.model.id && replay.block?.type === "thinking") {
          currentAssistant().content.push(replay.block);
          continue;
        }
      }
      const text = [...(item.summary || []), ...(item.content || [])].map((part) => part.text || "").join("\n");
      if (text) currentAssistant().content.push({ type: "text", text });
    } else if (type === "function_call") {
      let arguments_;
      try { arguments_ = JSON.parse(item.arguments); } catch { throw invalid("Invalid replayed tool arguments"); }
      currentAssistant().content.push({ type: "toolCall", id: item.call_id, name: item.name, arguments: arguments_ });
    } else if (type === "function_call_output") {
      messages.push({ role: "toolResult", toolCallId: item.call_id, toolName: "tool", content: content(item.output, true),
        isError: false, timestamp: Date.now() });
    } else if (["system", "developer"].includes(item.role)) {
      const text = content(item.content).map((part) => part.text || "").join("\n");
      if (route.model.compat?.supportsMidConvoSystemMessages) messages.push({ role: "system", content: text });
      else systemPrompt += "\n" + text;
    } else if (item.role === "assistant") {
      currentAssistant().content.push(...content(item.content));
    } else {
      messages.push({ role: "user", content: content(item.content || ""), timestamp: Date.now() });
    }
  }
  if (tools.hostedSearch) systemPrompt += "\nOpenAI-hosted web search is unavailable on this model. Use an available browser or search function tool; do not claim to have searched without using one.";
  return { systemPrompt, messages, tools: [...tools.declared.values()] };
}

/** Turn Pi's provider-neutral incremental events into Codex Responses events. */
class Responses {
  id = "resp_" + randomUUID().replaceAll("-", "");
  created = Math.floor(Date.now() / 1000);
  sequence = 0;
  output = [];
  slots = new Map();
  constructor(tools, route) { this.tools = tools; this.route = route; }
  response(status, extra = {}) { return { id: this.id, object: "response", created_at: this.created,
    model: this.route.slug, status, output: this.output, error: null, incomplete_details: null, ...extra }; }
  async emit(type, fields = {}) {
    await write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...fields })}\n\n`);
  }
  async start() { await this.emit("response.created", { response: this.response("in_progress") }); }
  async add(index, block) {
    let item;
    let spec;
    if (block.type === "text") item = { type: "message", id: "msg_" + randomUUID(), role: "assistant", status: "in_progress",
      content: [{ type: "output_text", text: "", annotations: [] }] };
    else if (block.type === "thinking") item = { type: "reasoning", id: this.route.reasoningId + randomUUID(),
      summary: [{ type: "summary_text", text: "" }] };
    else {
      spec = this.tools.byName.get(block.name);
      if (!spec) throw new Error("Provider returned an undeclared tool");
      const custom = spec.type === "custom";
      const callId = this.route.model.api === "openai-responses" ? block.id.split("|", 1)[0] : block.id;
      item = { type: custom ? "custom_tool_call" : "function_call", id: (custom ? "ctc_" : "fc_") + randomUUID(),
        name: spec.name, call_id: callId, status: "in_progress", [custom ? "input" : "arguments"]: "" };
      if (spec.namespace) item.namespace = spec.namespace;
    }
    const slot = { item, spec, output_index: this.output.length };
    this.output.push(item);
    this.slots.set(index, slot);
    await this.emit("response.output_item.added", { output_index: slot.output_index, item });
    const fields = { item_id: item.id, output_index: slot.output_index };
    if (block.type === "text") await this.emit("response.content_part.added", { ...fields, content_index: 0, part: item.content[0] });
    if (block.type === "thinking") await this.emit("response.reasoning_summary_part.added", { ...fields, summary_index: 0, part: item.summary[0] });
    return slot;
  }
  async event(event) {
    if (event.type === "start") return;
    if (event.type === "error") throw new Error(event.error.errorMessage || "Provider request failed");
    if (event.type === "done") {
      const u = event.message.usage;
      const input = u.input + u.cacheRead + u.cacheWrite;
      const usage = { input_tokens: input, output_tokens: u.output, total_tokens: input + u.output,
        input_tokens_details: { cached_tokens: u.cacheRead }, output_tokens_details: { reasoning_tokens: u.reasoning || 0 } };
      const status = event.reason === "length" ? "incomplete" : "completed";
      await this.emit("response." + status, { response: this.response(status, { usage,
        incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null }) });
      return;
    }
    const block = event.partial?.content[event.contentIndex];
    if (!block) return;
    const slot = this.slots.get(event.contentIndex) || await this.add(event.contentIndex, block);
    const { item, output_index, spec } = slot;
    const fields = { item_id: item.id, output_index };
    if (event.type === "text_delta") {
      item.content[0].text += event.delta;
      await this.emit("response.output_text.delta", { ...fields, content_index: 0, delta: event.delta });
    } else if (event.type === "thinking_delta") {
      item.summary[0].text += event.delta;
      await this.emit("response.reasoning_summary_text.delta", { ...fields, summary_index: 0, delta: event.delta });
    } else if (event.type === "toolcall_delta" && spec.type !== "custom" && !spec.encoding) {
      item.arguments += event.delta;
      await this.emit("response.function_call_arguments.delta", { ...fields, delta: event.delta });
    } else if (event.type.endsWith("_end")) {
      if (block.type === "text") {
        item.content[0].text = block.text;
        item.status = "completed";
        await this.emit("response.output_text.done", { ...fields, content_index: 0, text: block.text });
        await this.emit("response.content_part.done", { ...fields, content_index: 0, part: item.content[0] });
      } else if (block.type === "thinking") {
        item.summary[0].text = block.thinking;
        // This is an opaque transport envelope for Pi's provider signature,
        // not gateway encryption. It is never logged or persisted server-side.
        item.encrypted_content = this.route.replay + Buffer.from(JSON.stringify({ model: this.route.model.id, block })).toString("base64");
        await this.emit("response.reasoning_summary_text.done", { ...fields, summary_index: 0, text: block.thinking });
        await this.emit("response.reasoning_summary_part.done", { ...fields, summary_index: 0, part: item.summary[0] });
      } else {
        if (block.argumentsError) throw new Error(block.argumentsError);
        item.status = "completed";
        if (spec.type === "custom") {
          if (typeof block.arguments.input !== "string") throw new Error("Provider returned a custom tool without text input");
          item.input = block.arguments.input;
          await this.emit("response.custom_tool_call_input.delta", { ...fields, delta: item.input });
          await this.emit("response.custom_tool_call_input.done", { ...fields, input: item.input });
        } else {
          item.arguments = JSON.stringify(this.tools.decodeArguments(spec, block.arguments));
          if (spec.encoding) await this.emit("response.function_call_arguments.delta", { ...fields, delta: item.arguments });
          await this.emit("response.function_call_arguments.done", { ...fields, arguments: item.arguments });
        }
      }
      await this.emit("response.output_item.done", { output_index, item });
    }
  }
}

async function bedrockEnvironment() {
  const envFile = gatewayPath("bedrock_env_file", "CODEX_BEDROCK_ENV_FILE");
  let env;
  try { env = parseEnv(await readFile(envFile, "utf8")); }
  catch { throw new Error("Cannot load the Bedrock environment file; set CODEX_BEDROCK_ENV_FILE to its path"); }
  for (const [name, value] of Object.entries(env)) if (name.startsWith("AWS_")) process.env[name] = value;
  if (!env.AWS_BEARER_TOKEN_BEDROCK) throw new Error("The Bedrock environment file needs AWS_BEARER_TOKEN_BEDROCK");
  return env;
}

export async function run({ slug, provider, id }) {
  let started = false;
  let response;
  const errorCode = provider === "amazon-bedrock" ? "bedrock_gateway_error" : "cloud_gateway_error";
  try {
    const profile = providers[provider];
    if (!profile) throw new Error(`Unsupported Pi provider: ${provider}`);
    const bedrock = provider === "amazon-bedrock";
    const env = bedrock ? await bedrockEnvironment() : undefined;
    const { ModelRuntime } = await load("coding-agent/dist/core/model-runtime.js");
    const { getSupportedThinkingLevels } = await load("ai/dist/models.js");
    const agentDir = gatewayPath("agent_dir", "CODEX_PI_AGENT_DIR", dirname(fileURLToPath(import.meta.url)));
    const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false, refreshOnCreate: false });
    const model = models.getModel(provider, id);
    if (!model || model.api !== profile.api || (profile.base && model.baseUrl.replace(/\/+$/, "") !== profile.base)) {
      throw new Error(`Pi does not register ${provider}/${id} on the expected API`);
    }
    const levels = getSupportedThinkingLevels(model);
    if (process.argv.includes("--catalog")) {
      await write(JSON.stringify({ id: slug, context_length: model.contextWindow, input_modalities: model.input,
        thinking_levels: levels.map((level) => level === "off" ? "none" : level) }) + "\n");
      return;
    }

    const reader = createInterface({ input: process.stdin });
    const line = await new Promise((resolve, reject) => {
      reader.once("line", resolve);
      reader.once("close", () => reject(new Error("Request pipe closed")));
    });
    reader.close();
    process.stdin.on("end", () => abort.abort());
    process.stdin.resume();
    const { payload, session_id: sessionId } = JSON.parse(line);
    if (payload.model !== slug || payload.stream !== true) throw invalid(`Use ${slug} with stream=true`);
    if (payload.previous_response_id || payload.conversation) throw invalid("Replay full input; stored Responses references are unavailable");
    if ((payload.text?.format?.type || "text") !== "text") throw invalid("Schema-constrained final output is unavailable on this route");
    const level = payload.reasoning?.effort === "none" ? "off" : (payload.reasoning?.effort || levels.at(-1));
    if (!levels.includes(level)) throw invalid(`Reasoning must be one of: ${levels.join(", ")}`);
    const route = { slug, model, replay: `pi-${profile.replay}-v1:`, reasoningId: `rs_${profile.replay.replaceAll("-", "_")}_` };
    const tools = new Tools(profile.schemas);
    const ctx = context(payload, tools, route);
    const choice = tools.choice(payload.tool_choice || "auto");
    if (model.api !== "openai-responses" && choice?.type === "allowed_tools") {
      throw invalid("tool_choice must be auto, none, required, or a named tool");
    }

    response = new Responses(tools, route);
    const options = {
      signal: abort.signal, sessionId,
      maxTokens: payload.max_output_tokens || model.maxTokens,
      onResponse: async () => {
        if (!started) { await write(JSON.stringify({ status: 200 }) + "\n"); started = true; await response.start(); }
      },
    };
    const reasoning = level === "off" ? undefined : level;
    if (bedrock) {
      Object.assign(options, {
        cacheRetention: "long", bearerToken: env.AWS_BEARER_TOKEN_BEDROCK,
        env: { ...env, PI_CACHE_RETENTION: "long" }, reasoning,
        toolChoice: choice === "required" ? "any" : typeof choice === "object" ? { type: "tool", name: choice.name } : choice,
      });
    } else {
      const auth = await models.getAuth(model, { signal: abort.signal });
      if (auth?.type !== "api_key" || !auth.auth.apiKey) {
        throw Object.assign(new Error(`Configure the ${provider} API key in Pi`), { status: 401 });
      }
      if (auth.auth.baseUrl && auth.auth.baseUrl.replace(/\/+$/, "") !== profile.base) {
        throw new Error(`Pi ${provider} authentication resolved an unexpected endpoint`);
      }
      const { configureHttpDispatcher } = await load("coding-agent/dist/core/http-dispatcher.js");
      configureHttpDispatcher(0);
      Object.assign(options, { apiKey: auth.auth.apiKey, cacheRetention: "short", reasoningEffort: reasoning,
        maxTokens: Math.min(options.maxTokens, model.maxTokens) });
      if (model.api === "openai-responses") {
        options.toolChoice = choice;
        options.reasoningSummary = payload.reasoning?.summary;
        options.onPayload = (params) => ({ ...params, store: false });
      } else {
        options.toolChoice = typeof choice === "object" ? { type: "function", function: { name: choice.name } } : choice;
      }
    }
    if (model.api !== "openai-responses" && payload.temperature !== undefined) options.temperature = payload.temperature;
    for await (const event of models.stream(model, ctx, options)) await response.event(event);
  } catch (error) {
    if (!abort.signal.aborted) {
      const message = error instanceof Error ? error.message : "Pi cloud gateway failed";
      if (started) await response.emit("response.failed", { response: response.response("failed", {
        error: { code: errorCode, message } }) }).catch(() => {});
      else await write(JSON.stringify({ status: error.status || 502,
        error: { type: errorCode, message } }) + "\n").catch(() => {});
    }
    process.exitCode = 1;
  } finally { process.stdin.destroy(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [slug, provider, id] = process.argv.slice(2).filter((argument) => argument !== "--catalog");
  await run({ slug, provider, id });
}
