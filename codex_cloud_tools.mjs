import { createHash } from "node:crypto";

const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const HOSTED_SEARCH = new Set(["web_search", "web_search_preview"]);

/** Keep Codex namespaces and custom tools outside Meta's function-name space. */
export class Tools {
  byName = new Map();
  declared = new Map();
  hostedSearch = false;

  name(name, namespace) {
    if (typeof name !== "string" || !name) throw invalid("A tool name is required");
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
      if (!["function", "custom"].includes(tool.type)) throw invalid(`Unsupported Meta Codex tool: ${tool.type}`);
      const name = this.name(tool.name, namespace);
      this.byName.get(name).type = tool.type;
      this.declared.set(name, {
        name, description: tool.description || "",
        parameters: tool.type === "function" ? (tool.parameters || { type: "object", properties: {} }) : {
          type: "object", properties: { input: { type: "string", description: "The complete raw text input for this tool." } },
          required: ["input"], additionalProperties: false,
        },
      });
    }
  }

  choice(choice) {
    if (typeof choice === "string") {
      if (!["auto", "none", "required"].includes(choice)) throw invalid("Unsupported tool_choice");
      if (choice === "required" && !this.declared.size) throw invalid("tool_choice=required has no available tools");
      return choice;
    }
    if (choice?.type === "allowed_tools") return { ...choice, tools: choice.tools.map((tool) => this.choice(tool)) };
    if (!["function", "custom"].includes(choice?.type)) throw invalid("Select an available function or custom tool; hosted OpenAI tools are unavailable on Meta");
    const name = this.name(choice.name, choice.namespace);
    if (!this.declared.has(name)) throw invalid(`Unknown selected tool: ${choice.name}`);
    return { type: "function", name };
  }

  input(items, reasoningItem) {
    if (typeof items === "string") return [{ role: "user", content: items }];
    if (!Array.isArray(items)) throw invalid("input must be text or an array");
    return items.flatMap((item) => {
      const type = item.type || "message";
      if (type === "additional_tools" || type === "tool_search_output") {
        this.register(item.tools || []);
        return [];
      }
      if (type === "reasoning") {
        if (reasoningItem) return reasoningItem(item);
        // Foreign encrypted reasoning cannot be decrypted by Meta. Our marker
        // preserves Meta's complete reasoning item on subsequent turns.
        if (item.id?.startsWith("rs_meta_")) return [{ ...item, id: item.id.slice(8) }];
        const text = [...(item.summary || []), ...(item.content || [])].map((part) => part.text || "").join("\n");
        return text ? [{ role: "assistant", content: [{ type: "output_text", text }] }] : [];
      }
      if (type === "function_call" || type === "custom_tool_call") {
        const name = this.name(item.name, item.namespace);
        if (type === "custom_tool_call") this.byName.get(name).type = "custom";
        return [{ type: "function_call", name, call_id: item.call_id,
          arguments: type === "custom_tool_call" ? JSON.stringify({ input: item.input }) : item.arguments }];
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
