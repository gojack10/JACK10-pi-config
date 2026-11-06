import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gatewayPath } from "./codex_cloud_config.mjs";

const require = createRequire(join(gatewayPath("pi_root", "CODEX_PI_ROOT"), "package.json"));
const { Compile } = await import(pathToFileURL(require.resolve("typebox/schema")).href);

const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const HOSTED_SEARCH = new Set(["web_search", "web_search_preview"]);
export const META_REPLAY = "pi-meta-v1:";

function hasSchemaReference(value) {
  if (!value || typeof value !== "object") return false;
  return ["$ref", "$dynamicRef", "$recursiveRef"].some((key) => typeof value[key] === "string") ||
    Object.values(value).some(hasSchemaReference);
}

/** Translate Codex tool names, schemas and arguments for each cloud provider. */
export class Tools {
  byName = new Map();
  declared = new Map();
  hostedSearch = false;

  constructor(provider, model) { this.provider = provider; this.model = model; }

  name(name, namespace) {
    if (typeof name !== "string" || !name) throw invalid("A tool name is required");
    // Codex groups native tools under functions when declaring them, but
    // dispatches their calls without a namespace.
    if (namespace === "functions") namespace = undefined;
    const key = JSON.stringify([namespace || null, name]);
    let alias = namespace ? `${namespace}__${name}` : name;
    alias = alias.replace(/[^A-Za-z0-9_-]/g, "_");
    if (alias.length > 63) alias = alias.slice(0, 38) + "_" + createHash("sha256").update(key).digest("hex").slice(0, 24);
    const previous = this.byName.get(alias);
    if (previous && previous.key !== key) throw invalid(`Ambiguous tool name: ${name}`);
    if (!previous) this.byName.set(alias, { key, name, namespace, type: "function" });
    return alias;
  }

  register(specs, namespace) {
    for (const tool of specs) {
      if (HOSTED_SEARCH.has(tool.type)) { this.hostedSearch = true; continue; }
      if (tool.type === "namespace") { this.register(tool.tools || [], tool.name); continue; }
      if (!["function", "custom"].includes(tool.type)) throw invalid(`Unsupported Codex tool: ${tool.type}`);
      const name = this.name(tool.name, namespace);
      const spec = this.byName.get(name);
      spec.type = tool.type;
      const parameters = tool.type === "function" ? (tool.parameters || { type: "object", properties: {} }) : {
        type: "object", properties: { input: { type: "string", description: "The complete raw text input for this tool." } },
        required: ["input"], additionalProperties: false,
      };
      const rootComposition = ["oneOf", "allOf", "anyOf"].some((key) => Object.hasOwn(parameters, key));
      // A string envelope removes references from Meta's wire schema entirely.
      // Use it for referenced Bedrock unions too: nesting would change local
      // reference targets such as # and #/$defs/node.
      const referenced = hasSchemaReference(parameters);
      spec.encoding = this.provider === "meta" && referenced ? "json" :
        this.provider === "bedrock" && rootComposition ? (referenced ? "json" : "object") : undefined;
      spec.validator = spec.encoding ? Compile(parameters) : undefined;
      this.declared.set(name, {
        name, description: tool.description || "",
        parameters: spec.encoding ? {
          type: "object", properties: { arguments: spec.encoding === "json" ? {
            type: "string", description: `JSON-encode the complete tool arguments matching this JSON Schema: ${JSON.stringify(parameters)}`,
          } : parameters }, required: ["arguments"], additionalProperties: false,
        } : parameters,
      });
    }
  }

  encodeArguments(name, arguments_) {
    const spec = this.byName.get(name);
    if (!spec?.encoding) return arguments_;
    return JSON.stringify({ arguments: spec.encoding === "json" ? arguments_ : JSON.parse(arguments_) });
  }

  decodeArguments(spec, arguments_) {
    if (!spec.encoding) return arguments_;
    if (!arguments_ || typeof arguments_ !== "object" || !Object.hasOwn(arguments_, "arguments")) {
      throw new Error(`Tool ${spec.name} returned arguments without its transport envelope`);
    }
    if (spec.encoding === "json" && typeof arguments_.arguments !== "string") {
      throw new Error(`Tool ${spec.name} returned non-string JSON arguments`);
    }
    const value = spec.encoding === "json" ? JSON.parse(arguments_.arguments) : arguments_.arguments;
    if (!spec.validator.Check(value)) {
      const errors = spec.validator.Errors(value).map((error) => `${error.instancePath || "/"}: ${error.message}`).join("; ");
      throw new Error(`Invalid arguments for tool ${spec.name}: ${errors}`);
    }
    return value;
  }

  codexArguments(spec, arguments_) {
    if (spec.encoding) return JSON.stringify(this.decodeArguments(spec, JSON.parse(arguments_)));
    // Codex's integer fields reject JSON tokens such as 30000.0. Keep other
    // numeric tokens exact, including integers beyond JavaScript's safe range.
    return JSON.stringify(JSON.parse(arguments_, (_key, value, context) =>
      typeof value === "number" ? JSON.rawJSON(context.source.replace(/\.0+$/, "")) : value));
  }

  choice(choice) {
    if (typeof choice === "string") {
      if (!["auto", "none", "required"].includes(choice)) throw invalid("Unsupported tool_choice");
      if (choice === "required" && !this.declared.size) throw invalid("tool_choice=required has no available tools");
      return choice;
    }
    if (choice?.type === "allowed_tools") return { ...choice, tools: choice.tools.map((tool) => this.choice(tool)) };
    if (!["function", "custom"].includes(choice?.type)) throw invalid("Select an available function or custom tool");
    const name = this.name(choice.name, choice.namespace);
    if (!this.declared.has(name)) throw invalid(`Unknown selected tool: ${choice.name}`);
    return { type: "function", name };
  }

  input(items, reasoningItem) {
    if (typeof items === "string") return [{ role: "user", content: items }];
    if (!Array.isArray(items)) throw invalid("input must be text or an array");
    // Discover replayed dynamic tools before encoding any earlier calls to them.
    for (const item of items) {
      if (["additional_tools", "tool_search_output"].includes(item.type)) this.register(item.tools || []);
    }
    return items.flatMap((item) => {
      const type = item.type || "message";
      if (type === "additional_tools" || type === "tool_search_output") return [];
      if (type === "agent_message") {
        // Agent traffic is external context, not an assistant reply. OpenAI's
        // encrypted copy cannot be replayed to another provider; keep the
        // readable content and its direction without forwarding that metadata.
        const content = typeof item.content === "string" ? item.content : (item.content || [])
          .filter((part) => ["input_text", "output_text", "text"].includes(part.type) && typeof part.text === "string")
          .map((part) => part.text).join("\n");
        return [{ type: "message", role: "user", content: [{ type: "input_text",
          text: `[Agent message from ${item.author || "unknown"} to ${item.recipient || "unknown"}]\n` +
            (content || "[No readable message content is available to this model.]") }] }];
      }
      if (type === "reasoning") {
        if (reasoningItem) return reasoningItem(item);
        // Replay opaque state only to the model that produced it. Unversioned
        // Meta items came from the original Muse Full route.
        if (item.id?.startsWith("rs_meta_")) {
          if (item.encrypted_content?.startsWith(META_REPLAY)) {
            const replay = JSON.parse(Buffer.from(item.encrypted_content.slice(META_REPLAY.length), "base64").toString());
            if ((replay.model || "muse-wonder-full-1.0") === this.model) {
              return [{ ...item, id: replay.id, encrypted_content: replay.encrypted_content }];
            }
          } else if (this.model === "muse-wonder-full-1.0") {
            return [{ ...item, id: item.id.slice(8) }];
          }
        }
        const text = [...(item.summary || []), ...(item.content || [])].map((part) => part.text || "").join("\n");
        return text ? [{ role: "assistant", content: [{ type: "output_text", text }] }] : [];
      }
      if (type === "function_call" || type === "custom_tool_call") {
        const name = this.name(item.name, item.namespace);
        if (type === "custom_tool_call") this.byName.get(name).type = "custom";
        return [{ type: "function_call", name, call_id: item.call_id,
          arguments: this.encodeArguments(name, type === "custom_tool_call" ? JSON.stringify({ input: item.input }) : item.arguments) }];
      }
      if (type === "custom_tool_call_output") return [{ type: "function_call_output", call_id: item.call_id, output: item.output }];
      if (type === "function_call_output") return [{ type, call_id: item.call_id, output: item.output }];
      if (type === "message") {
        const { id, status, ...message } = item;
        return [message];
      }
      throw invalid(`Unsupported Meta Responses input item: ${type}`);
    });
  }
}
