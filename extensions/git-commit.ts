/**
 * /git-commit
 *
 * Prints a reusable prompt for asking Pi to turn the current working-tree diff
 * into clean, reviewable Git commits. The command also places the prompt in the
 * editor so it can be submitted immediately or edited first.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const GIT_COMMIT_PROMPT = [
	"## Git Commit Conventions",
	"",
	"Use Conventional Commits format. Max 100 char title.",
	"Do NOT add `Co-Authored-By` trailers to commits.",
	"",
	"### Commit Types",
	"",
	"| Type | Description |",
	"|------|-------------|",
	"| `feat` | New feature for the user |",
	"| `fix` | Bug fix for the user |",
	"| `docs` | Documentation changes |",
	"| `style` | Formatting, no code change |",
	"| `refactor` | Refactoring, no behavior change |",
	"| `test` | Adding/refactoring tests |",
	"| `chore` | Build tasks, no code change |",
	"| `perf` | Performance improvements |",
	"| `build` | Build system or dependencies |",
	"| `ci` | CI config changes |",
	"| `revert` | Reverts a previous commit |",
	"",
	"### Scope",
	"",
	"One token, kebab-case. Use domain/subsystem over file paths. Omit if cross-cutting.",
	"",
	"Common scopes: `auth`, `api`, `db`, `ui`, `tree`, `llm`, `chat`, `context`, `parser`",
	"",
	"### Format",
	"",
	"```",
	"type(scope): imperative description",
	"",
	"CHANGES:",
	"",
	"- Bullet describing change (7-10 words each)",
	"- Another change",
	"```",
	"",
	"### Branch Naming",
	"",
	"```",
	"<type>[optional-scope]/<ticket>-<short-slug>",
	"```",
	"",
	"Examples:",
	"- `feat/auth/123-add-login-form`",
	"- `fix/parser-handle-nested-blocks`",
	"- `refactor/llm-split-prompt-sections`",
	"",
	"### Large Diffs",
	"",
	"Segment into logical commits. Output with:",
	"",
	"```bash",
	"git add <files>",
	"```",
	"",
	"```",
	"type(scope): description",
	"",
	"CHANGES:",
	"",
	"- Change 1",
	"- Change 2",
	"```",
].join("\n");

export default function gitCommitPromptExtension(pi: ExtensionAPI) {
	pi.registerCommand("git-commit", {
		description: "Send Git commit conventions to the agent; optional args become priority messages",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const message = args?.trim()
				? args.trim()
				: await ctx.ui.input(
						"Optional commit focus/message (blank for conventions only)",
						"",
					);

			const prompt = message?.trim()
				? [
						"## Priority Messages",
						"",
						message.trim(),
						"",
						GIT_COMMIT_PROMPT,
					].join("\n")
				: GIT_COMMIT_PROMPT;

			if (!ctx.isIdle()) {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify("Git commit prompt queued as follow-up", "info");
				return;
			}

			pi.sendUserMessage(prompt);
		},
	});
}
