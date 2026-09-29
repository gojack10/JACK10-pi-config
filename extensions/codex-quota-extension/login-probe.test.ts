import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchLoginProbe, withFreshLoginProbe } from "../codex-workspaces/probe.ts";

test("auto-probe runs after fresh login but not credential refresh", async () => {
	let probes = 0;
	const oauth = withFreshLoginProbe(
		async () => ({ access: "fresh" }),
		async () => ({ access: "refreshed" }),
		() => { probes++; },
	);

	assert.deepEqual(await oauth.login(undefined), { access: "fresh" });
	assert.equal(probes, 1);
	assert.deepEqual(await oauth.refresh({ access: "old" }, undefined), { access: "refreshed" });
	assert.equal(probes, 1);
});

test("probes use a configured Luna model and launch failures do not break login", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "codex-probe-model-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const registryPath = join(directory, "accounts.json");
	for (const models of [["gpt-6-astra", "gpt-6-luna", "gpt-6-sol"], ["gpt-5.6-luna"], ["gpt-6-sol"]]) {
		writeFileSync(registryPath, JSON.stringify({
			schemaVersion: 1,
			umbrellaProviderId: "openai-codex-personal",
			accounts: [{ accountKey: "test", providerId: "openai-codex-test", credentialRef: "openai-codex-test",
				label: "Test", policyClass: "perishable", supportedModels: models }],
		}));
		const expected = models.find((id) => id.endsWith("-luna")) ?? models[0];
		const observations: Array<[string, Record<string, unknown>]> = [];
		let launchedModel: string | undefined;
		const credentials = { access: "fresh" };
		const oauth = withFreshLoginProbe(
			async () => credentials,
			async (current) => current,
			() => launchLoginProbe(
				"openai-codex-test",
				(outcome, details) => observations.push([outcome, details]),
				(_command, args) => { launchedModel = args[args.indexOf("--model") + 1]; throw new Error("blocked"); },
				registryPath,
			),
		);
		assert.equal(await oauth.login(undefined), credentials);
		assert.equal(launchedModel, expected);
		assert.equal(observations.length, 1);
		assert.equal(observations[0]?.[0], "error");
		assert.match(String(observations[0]?.[1].error), /blocked/);
		assert.equal(observations[0]?.[1].model, expected);
	}
});
