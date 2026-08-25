import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	addTrafficSample,
	appendTrafficBesideCache,
	newTrafficState,
	TrafficMeter,
	trafficRow,
} from "./traffic.ts";

const july20 = Date.UTC(2026, 6, 20, 12);
const july22 = Date.UTC(2026, 6, 22, 12);

test("LOCAL accumulates permanently while LAN rotates on the billing cycle", () => {
	let state = newTrafficState(july20);
	state = addTrafficSample(state, { bytesIn: 10, bytesOut: 20 }, true, july20);
	state = addTrafficSample(state, { bytesIn: 30, bytesOut: 40 }, false, july20);
	state = addTrafficSample(state, { bytesIn: 1, bytesOut: 2 }, true, july22);
	assert.deepEqual(state.local, { bytesIn: 11, bytesOut: 22 });
	assert.deepEqual(state.cycle.lan, { bytesIn: 0, bytesOut: 0 });
	state = addTrafficSample(state, { bytesIn: 3, bytesOut: 4 }, false, july22);
	assert.deepEqual(state.cycle.lan, { bytesIn: 3, bytesOut: 4 });
});

test("localhost never enters manual HOTSPOT accounting", () => {
	let state = newTrafficState(july22);
	state.mode = "HOTSPOT";
	state = addTrafficSample(state, { bytesIn: 5, bytesOut: 6 }, true, july22);
	state = addTrafficSample(state, { bytesIn: 7, bytesOut: 8 }, false, july22);
	assert.deepEqual(state.local, { bytesIn: 5, bytesOut: 6 });
	assert.deepEqual(state.cycle.hotspot, { bytesIn: 7, bytesOut: 8 });
	assert.deepEqual(trafficRow(state, false, () => "-", july22), {
		type: "HOTSPOT",
		data: "manual",
		time: "-",
	});
});

test("nettop deltas persist across meter restarts", () => {
	const path = join(mkdtempSync(join(tmpdir(), "traffic-")), "state.json");
	const meter = new TrafficMeter(() => true, () => {}, path);
	(meter as any).consume(
		",bytes_in,bytes_out,\npi.1,100,200,\n" +
		",bytes_in,bytes_out,\npi.1,10,20,\n",
	);
	assert.deepEqual(meter.snapshot().local, { bytesIn: 10, bytesOut: 20 });
	assert.deepEqual(new TrafficMeter(() => true, () => {}, path).snapshot().local, {
		bytesIn: 10,
		bytesOut: 20,
	});
	assert.equal(JSON.parse(readFileSync(path, "utf8")).mode, "LAN");
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
	assert.doesNotMatch(lines[0], /TRAF/);
	assert.doesNotMatch(lines[2], /TRAF/);

	const skipped = [...initial];
	assert.equal(
		appendTrafficBesideCache(skipped, 0, 3, baseWidth + 2 + 15, row, (text) => text.length),
		"skipped",
	);
	assert.deepEqual(skipped, initial);

	const wide = [...initial];
	assert.equal(
		appendTrafficBesideCache(wide, 0, 3, 120, row, (text) => text.length),
		"wide",
	);
	assert.equal(wide.length, initial.length);
	assert.match(wide[0], /TRAFFIC/);
	assert.match(wide[1], /LOCAL/);
});
