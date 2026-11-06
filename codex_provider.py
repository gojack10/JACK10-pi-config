"""Codex Responses API over the proxy's managed Chat Completions route."""
import hashlib
import json
import time
import uuid
from pathlib import Path

from aiohttp import web
from multidict import CIMultiDict

MODEL_ALIASES = {
    'deepseek-v4.1-flash-1017-local': 'deepseek-v4.1-flash',
    'glm-5.3-flash-local': 'glm-5.3-flash',
    'qwen3.8-flash-next-local': 'qwen3.8-flash-next',
}
REASONING_LEVELS = {'none', 'high', 'xhigh'}
HOSTED_SEARCH_TOOLS = {'web_search', 'web_search_preview'}


def invalid(message):
    return web.HTTPBadRequest(text=json.dumps({"error": {
        "type": "invalid_request_error", "message": message}}),
        content_type="application/json")


def text_content(value):
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        raise invalid("Expected text or a text content array")
    parts = []
    for part in value:
        if not isinstance(part, dict) or part.get("type") not in (
                "input_text", "output_text", "text", "summary_text", "reasoning_text"):
            raise invalid("This local Codex route supports text input only")
        parts.append(part.get("text", ""))
    return "\n".join(parts)


def tool_name(name, namespace=None):
    return f"{namespace}__{name}" if namespace else name


def chat_identity(identity):
    return "codex-" + hashlib.sha256(identity.encode()).hexdigest()[:40]


def request_headers(headers):
    result = CIMultiDict(headers)
    result["X-Pi-Request-Id"] = uuid.uuid4().hex
    result["X-Pi-Origin"] = "codex"
    result["X-Pi-Live-Answer"] = "1"
    identity = (headers.get("X-Pi-Chat-Id") or headers.get("session-id")
                or headers.get("thread-id"))
    if identity:
        result["X-Pi-Chat-Id"] = chat_identity(identity)
        result["X-Pi-Chat-Label"] = "Codex"
    return result


def chat_request(payload):
    """Retain visible reasoning and call IDs when replaying Codex's transcript."""
    if not isinstance(payload, dict) or payload.get("stream") is not True:
        raise invalid("Local Codex requests require stream=true")
    if payload.get("previous_response_id") or payload.get("conversation"):
        raise invalid("Replay the full input; durable Responses references are unavailable")
    output_format = (payload.get("text") or {}).get("format") or {}
    if output_format.get("type", "text") != "text":
        raise invalid("Schema-constrained final output is unavailable on this local route")
    tools, names = [], {}
    hosted_search = False

    def register(specs, namespace=None):
        nonlocal hosted_search
        for spec in specs:
            kind = spec.get("type")
            # Codex adds hosted search for the openai provider regardless of
            # model metadata. Browser/MCP function tools remain available.
            if kind in HOSTED_SEARCH_TOOLS:
                hosted_search = True
                continue
            if kind == "namespace":
                register(spec.get("tools", []), spec["name"])
                continue
            if kind not in ("function", "custom"):
                raise invalid(f"Unsupported local Codex tool: {kind}")
            alias = tool_name(spec["name"], namespace)
            if alias in names:
                raise invalid(f"Duplicate tool name: {alias}")
            names[alias] = {"name": spec["name"], "namespace": namespace, "type": kind}
            parameters = spec.get("parameters") if kind == "function" else {
                "type": "object", "properties": {"input": {"type": "string"}},
                "required": ["input"], "additionalProperties": False}
            tools.append({"type": "function", "function": {
                "name": alias, "description": spec.get("description", ""),
                "parameters": parameters or {"type": "object", "properties": {}}}})

    register(payload.get("tools", []))
    messages = []
    if payload.get("instructions"):
        messages.append({"role": "system", "content": payload["instructions"]})
    if hosted_search:
        messages.append({"role": "system", "content":
            "OpenAI-hosted web search is unavailable for this local model. "
            "Use an available browser or search function tool instead; "
            "do not claim to have searched without actually using one."})
    items = payload.get("input", [])
    if isinstance(items, str):
        items = [{"role": "user", "content": items}]
    if not isinstance(items, list):
        raise invalid("input must be text or a conversation array")
    reasoning = ""
    for item in items:
        kind = item.get("type", "message")
        if kind == "reasoning":
            reasoning += text_content(item.get("content") or item.get("summary") or [])
        elif kind == "message":
            role = item.get("role", "user")
            message = {"role": "system" if role == "developer" else role,
                       "content": text_content(item.get("content", ""))}
            if role == "assistant" and reasoning:
                message["reasoning_content"], reasoning = reasoning, ""
            messages.append(message)
        elif kind in ("function_call", "custom_tool_call"):
            if not messages or messages[-1]["role"] != "assistant":
                messages.append({"role": "assistant", "content": ""})
            message = messages[-1]
            if reasoning:
                message["reasoning_content"], reasoning = reasoning, ""
            arguments = item.get("arguments", "{}") if kind == "function_call" else json.dumps({
                "input": item.get("input", "")})
            message.setdefault("tool_calls", []).append({"id": item["call_id"],
                "type": "function", "function": {
                    "name": tool_name(item["name"], item.get("namespace")),
                    "arguments": arguments}})
        elif kind in ("function_call_output", "custom_tool_call_output"):
            output = item.get("output", "")
            messages.append({"role": "tool", "tool_call_id": item["call_id"],
                             "content": text_content(output)})
        else:
            raise invalid(f"Unsupported Responses input item: {kind}")
    chat = {"model": payload.get("model"), "messages": messages, "stream": True,
            "temperature": payload.get("temperature", 0),
            "stream_options": {"include_usage": True}}
    choice = payload.get("tool_choice", "auto")
    if isinstance(choice, dict):
        if choice.get("type") in HOSTED_SEARCH_TOOLS:
            raise invalid("OpenAI-hosted web search is unavailable locally; use a browser or search function tool")
        if choice.get("type") not in ("function", "custom") or not isinstance(choice.get("name"), str):
            raise invalid("Local tool_choice must select an available function or custom tool")
        alias = tool_name(choice["name"], choice.get("namespace"))
        if alias not in names:
            raise invalid(f"Unknown selected local tool: {alias}")
        choice = {"type": "function", "function": {"name": alias}}
    if choice == "required" and not tools:
        raise invalid("tool_choice=required has no available local tools")
    if tools:
        chat["tools"] = tools
        chat["tool_choice"] = choice
        chat["parallel_tool_calls"] = False
    if "max_output_tokens" in payload:
        chat["max_tokens"] = payload["max_output_tokens"]
    effort = (payload.get("reasoning") or {}).get("effort")
    if effort is not None and effort not in REASONING_LEVELS:
        raise invalid("Local reasoning effort must be none (thinking off), high, or xhigh")
    if effort:
        chat["thinking"] = {"type": "disabled" if effort == "none" else "enabled"}
        if effort != "none":
            chat["reasoning_effort"] = "max" if effort == "xhigh" else "high"
    for key in ("top_p", "seed", "stop"):
        if key in payload:
            chat[key] = payload[key]
    return json.dumps(chat, separators=(",", ":")).encode(), ResponsesStream(chat["model"], names)


class ResponsesStream:
    """Incremental Chat Completions SSE to Responses events, without buffering text."""
    def __init__(self, model, names):
        self.model, self.names = model, names
        self.id, self.created = "resp_" + uuid.uuid4().hex, int(time.time())
        self.sequence = 0
        self.buffer, self.frame = b"", []
        self.output, self.calls = [], {}
        self.message = self.reasoning = None
        self.usage = None
        self.finish_reason = None
        self.started = self.finished = False
        self.release_chat = False

    def event(self, kind, **fields):
        data = dict(type=kind, sequence_number=self.sequence, **fields)
        self.sequence += 1
        return ("event: " + kind + "\ndata: " + json.dumps(data, separators=(",", ":"),
                ensure_ascii=False) + "\n\n").encode()

    def response(self, status, **fields):
        return dict(id=self.id, object="response", created_at=self.created,
                    status=status, model=self.model, output=self.output,
                    error=None, incomplete_details=None, usage=self.usage, **fields)

    def start(self):
        if self.started:
            return b""
        self.started = True
        return self.event("response.created", response=self.response("in_progress"))

    def add_item(self, item):
        index = len(self.output)
        self.output.append(item)
        return index, self.event("response.output_item.added", output_index=index, item=item)

    def delta(self, text, *, reasoning=False):
        if not text:
            return b""
        out = b""
        if reasoning:
            if self.reasoning is None:
                item = {"id": "rs_local_" + uuid.uuid4().hex, "type": "reasoning", "summary": []}
                self.reasoning, out = self.add_item(item)
                item["summary"].append({"type": "summary_text", "text": ""})
                out += self.event("response.reasoning_summary_part.added", item_id=item["id"],
                                  output_index=self.reasoning, summary_index=0, part=item["summary"][0])
            item = self.output[self.reasoning]
            item["summary"][0]["text"] += text
            return out + self.event("response.reasoning_summary_text.delta", item_id=item["id"],
                output_index=self.reasoning, summary_index=0, delta=text)
        if self.message is None:
            item = {"id": "msg_" + uuid.uuid4().hex, "type": "message", "role": "assistant",
                    "status": "in_progress", "content": []}
            self.message, out = self.add_item(item)
            item["content"].append({"type": "output_text", "text": "", "annotations": []})
            out += self.event("response.content_part.added", item_id=item["id"],
                output_index=self.message, content_index=0, part=item["content"][0])
        item = self.output[self.message]
        item["content"][0]["text"] += text
        return out + self.event("response.output_text.delta", item_id=item["id"],
            output_index=self.message, content_index=0, delta=text)

    def chunk(self, payload):
        if payload.get("error"):
            raise RuntimeError(str(payload["error"]))
        out = b""
        if payload.get("usage"):
            usage = payload["usage"]
            self.usage = {"input_tokens": usage.get("prompt_tokens", 0),
                "output_tokens": usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
                "input_tokens_details": {"cached_tokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)},
                "output_tokens_details": {"reasoning_tokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)}}
        for choice in payload.get("choices", []):
            delta = choice.get("delta", {})
            out += self.delta(delta.get("reasoning_content") or delta.get("reasoning") or "", reasoning=True)
            out += self.delta(delta.get("content") or "")
            for call in delta.get("tool_calls") or []:
                current = self.calls.setdefault(call["index"], {"id": "", "name": "", "arguments": ""})
                if call.get("id"):
                    current["id"] = call["id"]
                function = call.get("function") or {}
                current["name"] += function.get("name") or ""
                current["arguments"] += function.get("arguments") or ""
            if choice.get("finish_reason"):
                self.finish_reason = choice["finish_reason"]
        return out

    def feed(self, data):
        out = self.start()
        self.buffer += data
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            line = line.rstrip(b"\r")
            if line.startswith(b"data:"):
                self.frame.append(line[5:].lstrip())
            elif not line and self.frame:
                value = b"\n".join(self.frame)
                self.frame.clear()
                if value != b"[DONE]":
                    out += self.chunk(json.loads(value))
        return out

    def finish(self):
        if self.finished:
            return b""
        out = self.feed(b"\n\n")
        if not self.finish_reason:
            return out + self.fail("Upstream stream ended without a finish reason")
        for index, item in enumerate(self.output):
            if item["type"] == "reasoning":
                part = item["summary"][0]
                out += self.event("response.reasoning_summary_text.done", item_id=item["id"],
                    output_index=index, summary_index=0, text=part["text"])
                out += self.event("response.reasoning_summary_part.done", item_id=item["id"],
                    output_index=index, summary_index=0, part=part)
            elif item["type"] == "message":
                item["status"] = "completed"
                part = item["content"][0]
                out += self.event("response.output_text.done", item_id=item["id"],
                    output_index=index, content_index=0, text=part["text"])
                out += self.event("response.content_part.done", item_id=item["id"],
                    output_index=index, content_index=0, part=part)
            out += self.event("response.output_item.done", output_index=index, item=item)
        for call in self.calls.values():
            spec = self.names.get(call["name"])
            if spec is None:
                raise RuntimeError(f"Upstream returned an unknown tool: {call['name']}")
            custom = spec["type"] == "custom"
            value = json.loads(call["arguments"])["input"] if custom else call["arguments"]
            field = "input" if custom else "arguments"
            item = {"id": ("ctc_" if custom else "fc_") + uuid.uuid4().hex,
                "type": "custom_tool_call" if custom else "function_call",
                "call_id": call["id"] or "call_" + uuid.uuid4().hex,
                "name": spec["name"], field: "", "status": "in_progress"}
            if spec["namespace"]:
                item["namespace"] = spec["namespace"]
            index, added = self.add_item(item)
            out += added
            kind = "response.custom_tool_call_input" if custom else "response.function_call_arguments"
            out += self.event(kind + ".delta", item_id=item["id"], output_index=index, delta=value)
            item[field], item["status"] = value, "completed"
            out += self.event(kind + ".done", item_id=item["id"], output_index=index, **{field: value})
            out += self.event("response.output_item.done", output_index=index, item=item)
        self.finished = True
        self.release_chat = not self.calls
        status = "incomplete" if self.finish_reason == "length" else "completed"
        response = self.response(status)
        if status == "incomplete":
            response["incomplete_details"] = {"reason": "max_output_tokens"}
            self.release_chat = True
        return out + self.event("response." + status, response=response)

    def fail(self, message, *, terminal_failure=False):
        if self.finished and not terminal_failure:
            return b""
        out = self.start()
        self.finished = self.release_chat = True
        response = self.response("failed")
        response["error"] = {"code": "server_error", "message": str(message)}
        return out + self.event("response.failed", response=response)


def model_catalog(models):
    """Codex model metadata, distinct from the proxy's OpenAI /models list."""
    instructions = "You are Codex, a coding agent. Use the available tools to complete the user's task."
    cache = Path.home() / ".codex/models_cache.json"
    if cache.exists():
        cached = json.loads(cache.read_text()).get("models", [])
        for model in sorted(cached, key=lambda m: m.get("slug") != "gpt-6.1-sol"):
            template = (model.get("model_messages") or {}).get("instructions_template") or model.get("base_instructions")
            if template:
                instructions = template
                break
    result = []
    aliases = {canonical: alias for alias, canonical in MODEL_ALIASES.items()}
    for priority, model in enumerate(models):
        alias = aliases.get(model["id"])
        result.append({"slug": alias or model["id"],
            "display_name": alias or model["name"] + " (Local proxy)",
            "description": "Local inference through managed proxy admission",
            "default_reasoning_level": "high", "supported_reasoning_levels": [
                {"effort": "none", "description": "Thinking disabled"},
                {"effort": "high", "description": "High reasoning"},
                {"effort": "xhigh", "description": "Maximum local reasoning"}],
            "shell_type": "unified_exec", "visibility": "list", "supported_in_api": True,
            "priority": priority, "additional_speed_tiers": [], "service_tiers": [],
            "availability_nux": None, "upgrade": None, "base_instructions": instructions,
            "include_skills_usage_instructions": True, "include_plugin_usage_instructions": True,
            "include_apps_usage_instructions": True, "default_reasoning_summary": "detailed",
            "support_verbosity": False, "default_verbosity": None,
            "apply_patch_tool_type": "freeform", "truncation_policy": {"mode": "tokens", "limit": 10000},
            "context_window": model["context_length"], "max_context_window": model["context_length"],
            "effective_context_window_percent": 95, "experimental_supported_tools": [],
            "input_modalities": ["text"], "supports_search_tool": False,
            "supports_experimental_context": False, "use_responses_lite": False,
            "supports_reasoning_effort_updates": False})
    return {"models": result}
