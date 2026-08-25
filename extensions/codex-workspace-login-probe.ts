import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const MODEL = "gpt-5.6-luna";
const TIMEOUT_MS = 15_000;
const AGENT_DIR = join(homedir(), ".pi", "agent");

type ProbeObservation = (
	outcome: "success" | "error",
	details: Record<string, unknown>,
) => void;

type ProbeProcess = {
	once(event: "error", listener: (error: Error) => void): ProbeProcess;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): ProbeProcess;
	kill(signal: NodeJS.Signals): boolean;
	unref(): void;
};

type SpawnProbe = (
	command: string,
	args: string[],
	options: { env: NodeJS.ProcessEnv; stdio: "ignore" },
) => ProbeProcess;

export const withFreshLoginProbe = <Interaction, Credentials, Signal>(
	login: (interaction: Interaction) => Promise<Credentials>,
	refresh: (credentials: Credentials, signal: Signal) => Promise<Credentials>,
	probe: (credentials: Credentials) => void,
) => ({
	login: async (interaction: Interaction): Promise<Credentials> => {
		const credentials = await login(interaction);
		try { probe(credentials); } catch {}
		return credentials;
	},
	refresh,
});

export const launchLoginProbe = (
	provider: string,
	observe: ProbeObservation,
	launch: SpawnProbe = spawn as unknown as SpawnProbe,
): void => {
	try {
		const child = launch(process.env.PI_CODEX_PI_BIN ?? "pi", [
			"--no-extensions",
			"--extension", join(AGENT_DIR, "extensions", "codex-workspaces.ts"),
			"--extension", join(AGENT_DIR, "extensions", "codex-quota-extension", "index.ts"),
			"--model", `${provider}/${MODEL}`,
			"--thinking", "off",
			"--system-prompt", "",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-tools",
			"--no-session",
			"--print",
			"Reply only: ok",
		], {
			stdio: "ignore",
			env: { ...process.env, PI_CODEX_ACCOUNT_MAINTENANCE: provider },
		});
		let settled = false;
		const finish = (outcome: "success" | "error", details: Record<string, unknown>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			observe(outcome, { model: MODEL, thinking: "off", ...details });
		};
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			finish("error", { error: `probe timed out after ${TIMEOUT_MS}ms` });
		}, TIMEOUT_MS);
		timeout.unref();
		child.once("error", (error) => finish("error", { error: error.message }));
		child.once("exit", (code, signal) => finish(
			code === 0 ? "success" : "error",
			code === 0 ? { status: "complete" } : { error: `probe exited ${code ?? signal ?? "unknown"}` },
		));
		child.unref();
	} catch (error) {
		observe("error", {
			model: MODEL,
			thinking: "off",
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

export const scheduleLoginProbe = (provider: string, observe: ProbeObservation): void => {
	observe("success", { model: MODEL, thinking: "off", status: "scheduled" });
	const timer = setTimeout(() => launchLoginProbe(provider, observe), 250);
	timer.unref();
};
