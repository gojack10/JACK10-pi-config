import assert from "node:assert/strict";
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

test("probe launch failure is observed without breaking fresh login", async () => {
	const observations: Array<[string, Record<string, unknown>]> = [];
	const credentials = { access: "fresh" };
	const oauth = withFreshLoginProbe(
		async () => credentials,
		async (current) => current,
		() => launchLoginProbe(
			"openai-codex-test",
			(outcome, details) => observations.push([outcome, details]),
			() => { throw new Error("blocked"); },
		),
	);

	assert.equal(await oauth.login(undefined), credentials);
	assert.equal(observations.length, 1);
	assert.equal(observations[0]?.[0], "error");
	assert.match(String(observations[0]?.[1].error), /blocked/);
	assert.equal(observations[0]?.[1].model, "gpt-5.6-luna");
});
