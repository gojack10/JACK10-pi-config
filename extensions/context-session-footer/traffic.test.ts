import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	addTrafficSample,
	appendTrafficBesideCache,
	getNetworkIdentity,
	newTrafficState,
	readTrafficState,
	registerTrafficCommand,
	runTrafficCommand,
	TrafficMeter,
	trafficRow,
	writeTrafficState,
	type NetworkClass,
	type NetworkIdentity,
} from "./traffic.ts";

const july20 = Date.UTC(2026, 6, 20, 12);
const july22 = Date.UTC(2026, 6, 22, 12);
const networkA: NetworkIdentity = {
	status: "ONLINE",
	networkId: `hmac:${"a".repeat(64)}`,
	signals: ["route", "gateway", "wifi"],
};
const networkB: NetworkIdentity = {
	status: "ONLINE",
	networkId: `hmac:${"b".repeat(64)}`,
	signals: ["route", "gateway"],
};

const labeledState = (networkClass: NetworkClass, now = july22) => ({
	...newTrafficState(now),
	mode: networkClass.toUpperCase() as "LAN" | "HOTSPOT",
	networkLabel: {
		kind: "network_label" as const,
		networkId: networkA.status === "ONLINE" ? networkA.networkId : "",
		class: networkClass,
		setAt: new Date(now).toISOString(),
		profileRevision: 1 as const,
		signals: ["route", "gateway", "wifi"],
		reason: "manual" as const,
	},
});

test("LOCAL persists while classified LAN rotates on the billing cycle", () => {
	let state = labeledState("lan", july20);
	state = addTrafficSample(state, { bytesIn: 10, bytesOut: 20 }, true, july20, networkA);
	state = addTrafficSample(state, { bytesIn: 30, bytesOut: 40 }, false, july20, networkA);
	state = addTrafficSample(state, { bytesIn: 1, bytesOut: 2 }, true, july22, networkA);
	assert.deepEqual(state.local, { bytesIn: 11, bytesOut: 22 });
	assert.deepEqual(state.cycle.lan, { bytesIn: 0, bytesOut: 0 });
	state = addTrafficSample(state, { bytesIn: 3, bytesOut: 4 }, false, july22, networkA);
	assert.deepEqual(state.cycle.lan, { bytesIn: 3, bytesOut: 4 });
});

test("manual HOTSPOT only applies to its matching network identity", () => {
	let state = labeledState("hotspot");
	state = addTrafficSample(state, { bytesIn: 5, bytesOut: 6 }, true, july22, networkA);
	state = addTrafficSample(state, { bytesIn: 7, bytesOut: 8 }, false, july22, networkA);
	state = addTrafficSample(state, { bytesIn: 9, bytesOut: 10 }, false, july22, networkB);
	assert.deepEqual(state.local, { bytesIn: 5, bytesOut: 6 });
	assert.deepEqual(state.cycle.hotspot, { bytesIn: 7, bytesOut: 8 });
	assert.deepEqual(state.cycle.unknown, { bytesIn: 9, bytesOut: 10 });
	assert.deepEqual(trafficRow(state, false, () => "01:02:03", july22, networkA), {
		type: "HOTSPOT:manual",
		data: "0.0 GB/25 GB",
		time: "01:02:03",
	});
	assert.deepEqual(trafficRow(state, false, () => "-", july22, networkB), {
		type: "UNKNOWN",
		data: "0.0 GB!",
		time: "-",
	});
	assert.deepEqual(trafficRow(state, false, () => "-", july22, { status: "OFFLINE" }), {
		type: "OFFLINE",
		data: "!",
		time: "-",
	});
});

test("/traffic parses hotspot, lan, status, and usage errors", () => {
	const directory = mkdtempSync(join(tmpdir(), "traffic-command-"));
	const path = join(directory, "state.json");
	const options = { path, identity: () => networkA, now: () => july22 };

	assert.deepEqual(runTrafficCommand("wat", options), {
		level: "warning",
		text: "Usage: /traffic [hotspot|lan]",
	});
	assert.match(runTrafficCommand("hotspot", options).text, /^HOTSPOT:manual set for hmac:/);
	assert.equal(readTrafficState(path, july22).networkLabel?.class, "hotspot");
	assert.match(runTrafficCommand("", options).text, /class HOTSPOT:manual.*matches yes/);
	assert.match(runTrafficCommand("lan", options).text, /^LAN:manual set for hmac:/);
	assert.equal(readTrafficState(path, july22).networkLabel?.class, "lan");
});

test("/traffic registers as an extension command", () => {
	let registration: any;
	registerTrafficCommand({
		registerCommand(name, options) { registration = { name, ...options }; },
	}, { identity: () => ({ status: "OFFLINE" }) });
	assert.equal(registration.name, "traffic");
	const notifications: Array<[string, string]> = [];
	registration.handler("", {
		ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
	});
	assert.deepEqual(notifications, [["OFFLINE — no default route; cannot classify.", "error"]]);
});

test("classification persists atomically with 0600 mode and v2 label fields", () => {
	const directory = mkdtempSync(join(tmpdir(), "traffic-persist-"));
	const path = join(directory, "state.json");
	runTrafficCommand("hotspot", { path, identity: () => networkA, now: () => july22 });
	const stored = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(stored.networkLabel, {
		kind: "network_label",
		networkId: networkA.status === "ONLINE" ? networkA.networkId : "",
		class: "hotspot",
		setAt: new Date(july22).toISOString(),
		profileRevision: 1,
		signals: ["route", "gateway", "wifi"],
		reason: "manual",
	});
	assert.deepEqual(readdirSync(directory), ["state.json"]);
});

test("network identity is HMAC-only in state and machine key is 0600", () => {
	const directory = mkdtempSync(join(tmpdir(), "traffic-identity-"));
	const path = join(directory, "state.json");
	const keyPath = join(directory, ".traffic-key");
	const gateway = "172.20.10.1";
	const ssid = "Jack's raw phone SSID";
	const identity = getNetworkIdentity({
		keyPath,
		exec(command) {
			if (command === "route") return `gateway: ${gateway}\ninterface: en0\n`;
			return `Current Wi-Fi Network: ${ssid}\n`;
		},
	});
	assert.equal(identity.status, "ONLINE");
	assert.match(identity.status === "ONLINE" ? identity.networkId : "", /^hmac:[a-f0-9]{64}$/);
	runTrafficCommand("hotspot", { path, identity: () => identity, now: () => july22 });
	const raw = readFileSync(path, "utf8");
	assert.doesNotMatch(raw, /Jack's raw phone SSID|172\.20\.10\.1|en0/);
	assert.equal(statSync(keyPath).mode & 0o777, 0o600);
});

test("identity mismatch reports UNKNOWN and offline cannot classify", () => {
	const directory = mkdtempSync(join(tmpdir(), "traffic-status-"));
	const path = join(directory, "state.json");
	runTrafficCommand("lan", { path, identity: () => networkA, now: () => july22 });
	assert.match(
		runTrafficCommand("", { path, identity: () => networkB, now: () => july22 }).text,
		/class UNKNOWN.*matches no.*Re-classify/,
	);
	assert.deepEqual(
		runTrafficCommand("hotspot", { path, identity: () => ({ status: "OFFLINE" }) }),
		{ level: "error", text: "OFFLINE — no default route; cannot classify." },
	);
	assert.equal(readTrafficState(path, july22).networkLabel?.class, "lan");
	assert.deepEqual(getNetworkIdentity({ exec: () => { throw new Error("no route"); } }), {
		status: "OFFLINE",
	});
});

test("nettop deltas and the shared classification persist across meter restarts", () => {
	const path = join(mkdtempSync(join(tmpdir(), "traffic-meter-")), "state.json");
	runTrafficCommand("lan", { path, identity: () => networkA });
	const meter = new TrafficMeter(() => false, () => {}, path, () => networkA);
	(meter as any).consume(
		",bytes_in,bytes_out,\npi.1,100,200,\n" +
		",bytes_in,bytes_out,\npi.1,10,20,\n",
	);
	assert.deepEqual(meter.snapshot().cycle.lan, { bytesIn: 10, bytesOut: 20 });
	const restarted = new TrafficMeter(() => false, () => {}, path, () => networkA).snapshot();
	assert.deepEqual(restarted.cycle.lan, { bytesIn: 10, bytesOut: 20 });
	assert.equal(restarted.networkLabel?.class, "lan");
});

test("atomic writer preserves 0600 mode", () => {
	const directory = mkdtempSync(join(tmpdir(), "traffic-write-"));
	const path = join(directory, "state.json");
	writeTrafficState(path, newTrafficState(july22));
	writeTrafficState(path, labeledState("lan"));
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(directory), ["state.json"]);
});

test("TRAFFIC uses CACHE rows, degrades after QUOTA, then skips", () => {
	const row = { type: "LOCAL" as const, data: "0.0 GB", time: "-" };
	const initial = [
		"CACHE────────┬────┐",
		"│ CACHE ROW  │ CODEX-QUOTA: TOTAL 40%",
		"└────────────┴────┘",
	];
	const lines = [...initial];
	const baseWidth = Math.max(...lines.map((line) => line.length));
	assert.equal(
		appendTrafficBesideCache(lines, 0, 3, baseWidth + 2 + 17, row, (text) => text.length),
		"condensed",
	);
	assert.equal(lines.length, initial.length);
	assert.match(lines[1], /CODEX-QUOTA: TOTAL 40%.*TRAF LOCAL 0\.0GB/);

	const skipped = [...initial];
	assert.equal(
		appendTrafficBesideCache(skipped, 0, 3, baseWidth + 2 + 15, row, (text) => text.length),
		"skipped",
	);
	assert.deepEqual(skipped, initial);

	const wide = [...initial];
	assert.equal(appendTrafficBesideCache(wide, 0, 3, 120, row, (text) => text.length), "wide");
	assert.equal(wide.length, initial.length);
	assert.match(wide[0], /TRAFFIC/);
	assert.match(wide[1], /LOCAL/);
});
