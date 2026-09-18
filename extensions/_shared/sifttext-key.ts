// SiftText API key: SIFTTEXT_API_KEY env var, then the gitignored ~/.pi/agent/.sifttext-key.
// Read-only by design — nothing here writes the key to a process env, a file, or tmux.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SIFTTEXT_KEY_FILE = join(homedir(), ".pi", "agent", ".sifttext-key");

export function siftTextKey(): string | undefined {
	const fromEnv = process.env.SIFTTEXT_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		const fromFile = readFileSync(SIFTTEXT_KEY_FILE, "utf8").trim();
		return fromFile || undefined;
	} catch {
		return undefined;
	}
}
