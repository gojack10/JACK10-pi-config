import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "python-bash-guard";

// Keep this conservative: allowing shell metacharacters would let an allowed
// prefix smuggle arbitrary commands, e.g. `git status; rm -rf ...`.
const DANGEROUS_SHELL_SYNTAX = /[\n\r;|&<>`]|\$\(/;

function firstWord(command: string): string {
	return command.trim().split(/\s+/, 1)[0] ?? "";
}

function isPythonReplCommand(command: string): boolean {
	const cmd = command.trim();
	// Allow uv run with optional flags (--with, --python, etc.) before python/python3/ipython.
	// Pattern: uv run [--flag ...] python|python3|ipython [...]
	const uvRunPattern = /^uv run(?:\s+--[\w.-]+(?:\s+\S+)?)*\s+(python3?|ipython)(?:\s|$)/;
	return uvRunPattern.test(cmd);
}

function isAllowed(command: string): { ok: true } | { ok: false; reason: string } {
	const cmd = command.trim();
	if (!cmd) return { ok: false, reason: "empty command" };

	// Python is the escape hatch. Allow heredocs, -c snippets, etc. so the
	// model can replace grep/find/sed/awk with real Python inspection code.
	if (isPythonReplCommand(cmd)) return { ok: true };

	if (DANGEROUS_SHELL_SYNTAX.test(cmd)) {
		return {
			ok: false,
			reason: "shell control syntax is disabled for non-Python commands in python-bash-guard mode",
		};
	}

	const word = firstWord(cmd);
	if (word === "git") return { ok: true };
	if (word === "ls") return { ok: true };
	if (word === "pwd") return { ok: true };

	return { ok: false, reason: "only git, ls, pwd, and uv-run Python REPL commands are allowed" };
}

function blockMessage(command: string, reason: string): string {
	return [
		"python-bash-guard is enabled.",
		`Rejected: ${reason}.`,
		"",
		"Allowed bash commands:",
		"- git ...        (any git command, without shell chaining/pipes/redirection)",
		"- ls ...         (without shell chaining/pipes/redirection)",
		"- pwd            (without shell chaining/pipes/redirection)",
		"- uv run [--with PKG ...] python ... / python3 ... / ipython ... (Python is the escape hatch; --with, heredocs, and -c are OK)",
		"",
		"For searching/inspection, use Python instead, for example:",
		"uv run python - <<'PY'",
		"from pathlib import Path",
		"for p in Path('.').rglob('*.py'):",
		"    if '.venv' not in p.parts:",
		"        text = p.read_text(errors='ignore')",
		"        if 'needle' in text:",
		"            print(p)",
		"PY",
		"",
		`Blocked command: ${command}`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let previousTools: string[] | undefined;

	function setStatus() {
		// Status is visible in interactive mode; harmless in non-interactive modes.
		return enabled ? "py-bash:on" : "";
	}

	function enable(ctx: any) {
		enabled = true;
		previousTools = pi.getActiveTools();

		// Keep file mutation tools and bash, but remove shell-ish discovery tools so
		// the model is nudged into Python for search/inspection.
		const active = pi.getActiveTools().filter((name) => !["grep", "find"].includes(name));
		pi.setActiveTools(active);

		ctx.ui.setStatus(STATUS_KEY, setStatus());
		ctx.ui.notify("python-bash-guard enabled: bash allows only git, ls, pwd, and uv-run Python.", "info");
	}

	function disable(ctx: any) {
		enabled = false;
		if (previousTools) pi.setActiveTools(previousTools);
		previousTools = undefined;

		ctx.ui.setStatus(STATUS_KEY, setStatus());
		ctx.ui.notify("python-bash-guard disabled.", "info");
	}

	pi.registerCommand("python-bash-guard", {
		description: "Toggle bash restriction to git/ls/pwd/uv-run Python only",
		handler: async (_args, ctx) => {
			if (enabled) disable(ctx);
			else enable(ctx);
		},
	});

	pi.registerCommand("pybash", {
		description: "Alias for /python-bash-guard",
		handler: async (_args, ctx) => {
			if (enabled) disable(ctx);
			else enable(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, setStatus());
	});

	pi.on("before_agent_start", async (event) => {
		if (!enabled) return;
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\npython-bash-guard is enabled. For bash, only use git, ls, pwd, or uv run python/python3/ipython. Do not use grep, find, rg, sed, awk, cat, head, tail, wc, xargs, shell pipelines, redirection, command substitution, or command chaining. For file/search/inspection tasks, write small Python snippets and run them with uv run python.",
		};
	});

	pi.on("tool_call", async (event) => {
		if (!enabled) return;

		if (isToolCallEventType("bash", event)) {
			const command = event.input.command ?? "";
			const allowed = isAllowed(command);
			if (!allowed.ok) {
				return { block: true, reason: blockMessage(command, allowed.reason) };
			}
		}
	});

	// Also apply the same rule to user-entered ! / !! commands.
	pi.on("user_bash", async (event) => {
		if (!enabled) return;

		const allowed = isAllowed(event.command);
		if (!allowed.ok) {
			return {
				result: {
					output: blockMessage(event.command, allowed.reason),
					exitCode: 126,
					cancelled: false,
					truncated: false,
				},
			};
		}
	});
}
