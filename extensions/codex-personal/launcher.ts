import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Provider } from "/Users/jack/.local/share/pi-mono/packages/ai/src/models.ts";
import { builtinProviders } from "/Users/jack/.local/share/pi-mono/packages/ai/src/providers/all.ts";
import { ModelRuntime } from "/Users/jack/.local/share/pi-mono/packages/coding-agent/src/core/model-runtime.ts";
import { parseRegistry } from "../codex-quota-extension/store.ts";
import { evaluateCodexRouteFromFiles, parseWorkInput } from "./router.ts";

const agentDir = join(homedir(), ".pi", "agent");
const registryPath = join(agentDir, "codex-accounts.json");
const feedPath = join(agentDir, "codex-usage-state.json");
const choicePath = join(agentDir, "codex-personal-choice.json");
const routeEnv = "PI_CODEX_PERSONAL_ROUTE";
const maintenanceEnv = "PI_CODEX_ACCOUNT_MAINTENANCE";

function takeOption(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (!value) throw new Error(`${name} requires a value`);
	args.splice(index, 2);
	return value;
}

function savedModel(): string | undefined {
	try {
		const value = JSON.parse(readFileSync(choicePath, "utf8")) as { model?: unknown };
		return typeof value.model === "string" ? value.model : undefined;
	} catch {
		return undefined;
	}
}

function authBlocked(model: string, evaluation: ReturnType<typeof evaluateCodexRouteFromFiles>): string {
	return `ERROR: openai-codex-personal/${model} unavailable — no routable Codex account.\nEarliest recovery: unknown / earliest notBefore: none.\nFeed: ${feedPath}; telemetry eligible but credentials unavailable.\nAccounts: ${evaluation.accounts
		.map(({ account, reasons }) => `${account.label}(${account.accountKey}): ${[...reasons, "AUTH UNAVAILABLE"].join(", ")}`)
		.join("; ")}.`;
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const loginRef = takeOption(args, "--codex-login");
	if (!loginRef && args.includes("--no-session"))
		throw new Error("openai-codex-personal refuses --no-session because routing requires a durable pin");
	const workValue = takeOption(args, "--codex-work");
	const requested = takeOption(args, "--model");
	const existingScope = args.indexOf("--models");
	if (existingScope >= 0) args.splice(existingScope, 2);
	const resume = args.some((arg) => ["--continue", "-c", "--resume", "-r", "--session", "--fork"].includes(arg));
	const piArgs = [...args, "--models", "openai-codex-personal/*"];
	if (loginRef) {
		if (requested || workValue) throw new Error("--codex-login cannot be combined with --model or --codex-work");
		const registry = parseRegistry(JSON.parse(readFileSync(registryPath, "utf8")) as unknown);
		const normalized = loginRef.toLowerCase();
		const matches = registry.accounts.filter(
			(account) =>
				account.accountKey.toLowerCase() === normalized ||
				account.providerId.toLowerCase() === normalized ||
				account.label.toLowerCase() === normalized,
		);
		if (matches.length !== 1) throw new Error(`No unique Codex account matches ${loginRef}`);
		console.error(`Account maintenance enabled. Run /login ${matches[0]!.providerId}`);
		const result = spawnSync(process.env.PI_CODEX_PI_BIN ?? "pi", piArgs, {
			stdio: "inherit",
			env: { ...process.env, [maintenanceEnv]: matches[0]!.providerId },
		});
		return result.status ?? 1;
	}
	if (resume) {
		if (requested) throw new Error("Do not override the model when resuming a pinned Codex session");
		const result = spawnSync(process.env.PI_CODEX_PI_BIN ?? "pi", piArgs, { stdio: "inherit", env: process.env });
		return result.status ?? 1;
	}

	const registry = parseRegistry(JSON.parse(readFileSync(registryPath, "utf8")) as unknown);
	const rawModel = requested ?? savedModel() ?? "gpt-5.6-sol";
	const prefix = `${registry.umbrellaProviderId}/`;
	const model = rawModel.startsWith(prefix) ? rawModel.slice(prefix.length) : rawModel;
	if (model.includes("/")) throw new Error(`Expected ${prefix}<model> or a bare Sol model id`);
	const work = parseWorkInput(workValue);
	const evaluation = evaluateCodexRouteFromFiles({ model, work, registryPath, feedPath });
	if (evaluation.allBlocked) {
		console.error(evaluation.error);
		return 1;
	}

	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	const source = builtinProviders().find((provider) => provider.id === "openai-codex");
	if (!source) throw new Error("Built-in Codex provider is unavailable");
	for (const account of registry.accounts) {
		if (account.providerId === source.id) continue;
		runtime.registerNativeProvider({
			...source,
			id: account.providerId,
			getModels: () => source.getModels().map((entry) => ({ ...entry, provider: account.providerId })),
		} as Provider);
	}
	let winner = evaluation.candidates[0];
	for (const candidate of evaluation.candidates) {
		const account = registry.accounts.find((entry) => entry.accountKey === candidate.accountKey)!;
		if (await runtime.checkAuth(account.credentialRef)) {
			winner = candidate;
			break;
		}
		winner = undefined;
	}
	if (!winner) {
		console.error(authBlocked(model, evaluation));
		return 1;
	}
	for (const warning of winner.warnings) console.error(warning);
	const route = {
		umbrella: registry.umbrellaProviderId,
		accountKey: winner.accountKey,
		model,
		actualProviderId: winner.actualProviderId,
		feedGeneration: winner.feedGeneration,
		routedAt: Date.now(),
		workClass: work.workClass,
		...(work.horizonMinutes === undefined ? {} : { horizonMinutes: work.horizonMinutes }),
	};
	const env = {
		...process.env,
		[routeEnv]: JSON.stringify(route),
		PI_CODEX_WORK:
			work.workClass === "unpredictable" ? "unpredictable" : `${work.workClass}:${work.horizonMinutes}`,
	};
	const result = spawnSync(
		process.env.PI_CODEX_PI_BIN ?? "pi",
		[...piArgs, "--model", `${winner.actualProviderId}/${model}`],
		{ stdio: "inherit", env },
	);
	return result.status ?? 1;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
