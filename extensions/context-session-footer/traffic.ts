import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type WireBytes = { bytesIn: number; bytesOut: number };
export type TrafficMode = "LAN" | "HOTSPOT";
export type TrafficState = {
	mode: TrafficMode;
	local: WireBytes;
	cycle: {
		key: string;
		resetAt: number;
		lan: WireBytes;
		hotspot: WireBytes;
	};
};
export type TrafficRow = { type: "LOCAL" | TrafficMode; data: string; time: string };

const emptyBytes = (): WireBytes => ({ bytesIn: 0, bytesOut: 0 });
const validBytes = (value: unknown): value is WireBytes => {
	const bytes = value as WireBytes | undefined;
	return Boolean(
		bytes &&
		Number.isFinite(bytes.bytesIn) && bytes.bytesIn >= 0 &&
		Number.isFinite(bytes.bytesOut) && bytes.bytesOut >= 0,
	);
};

export const billingCycle = (now = Date.now()): { key: string; resetAt: number } => {
	const date = new Date(now);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	const startedThisMonth = date.getUTCDate() >= 21;
	const start = Date.UTC(year, month - (startedThisMonth ? 0 : 1), 21);
	const resetAt = Date.UTC(year, month + (startedThisMonth ? 1 : 0), 21);
	return { key: new Date(start).toISOString().slice(0, 10), resetAt };
};

export const newTrafficState = (now = Date.now()): TrafficState => ({
	mode: "LAN",
	local: emptyBytes(),
	cycle: { ...billingCycle(now), lan: emptyBytes(), hotspot: emptyBytes() },
});

const normalizeCycle = (state: TrafficState, now: number): TrafficState => {
	const cycle = billingCycle(now);
	return state.cycle.key === cycle.key
		? state
		: { ...state, cycle: { ...cycle, lan: emptyBytes(), hotspot: emptyBytes() } };
};

export const addTrafficSample = (
	state: TrafficState,
	sample: WireBytes,
	isLocal: boolean,
	now = Date.now(),
): TrafficState => {
	const next = structuredClone(normalizeCycle(state, now));
	const target = isLocal
		? next.local
		: next.mode === "HOTSPOT"
			? next.cycle.hotspot
			: next.cycle.lan;
	target.bytesIn += Math.max(0, sample.bytesIn);
	target.bytesOut += Math.max(0, sample.bytesOut);
	return next;
};

const formatBytes = (bytes: WireBytes): string =>
	`${((bytes.bytesIn + bytes.bytesOut) / 1_000_000_000).toFixed(1)} GB`;

export const trafficRow = (
	state: TrafficState,
	isLocal: boolean,
	formatTimer: (milliseconds: number) => string,
	now = Date.now(),
): TrafficRow => {
	const current = normalizeCycle(state, now);
	if (isLocal) return { type: "LOCAL", data: formatBytes(current.local), time: "-" };
	if (current.mode === "HOTSPOT")
		return { type: "HOTSPOT", data: "manual", time: "-" };
	return {
		type: "LAN",
		data: formatBytes(current.cycle.lan),
		time: formatTimer(current.cycle.resetAt - now),
	};
};

export const renderTrafficTable = (row: TrafficRow): string[] => {
	const headers = ["TYPE", "DATA", "TIME"];
	const values = [row.type, row.data, row.time];
	const widths = headers.map((header, index) => Math.max(header.length, values[index].length));
	const cell = (value: string, width: number) => ` ${value.padEnd(width)} `;
	return [
		`TRAFFIC${"─".repeat(Math.max(0, widths[0] + 3 - "TRAFFIC".length))}${widths.slice(1).map((width) => `┬${"─".repeat(width + 2)}`).join("")}┐`,
		`│${values.map((value, index) => cell(value, widths[index])).join("│")}│`,
		`└${widths.map((width) => "─".repeat(width + 2)).join("┴")}┘`,
	];
};

export const appendTrafficBesideCache = (
	lines: string[],
	cacheStart: number,
	cacheEnd: number,
	width: number,
	row: TrafficRow,
	measure: (text: string) => number,
	paint: (text: string) => string = (text) => text,
): "wide" | "condensed" | "skipped" => {
	if (cacheEnd - cacheStart < 3) return "skipped";
	const table = renderTrafficTable(row);
	const baseWidth = Math.max(...lines.slice(cacheStart, cacheEnd).map(measure));
	const available = width - baseWidth - 2;
	const append = (index: number, text: string) => {
		const target = cacheStart + index;
		lines[target] += `${" ".repeat(baseWidth - measure(lines[target]))}  ${paint(text)}`;
	};
	if (available >= Math.max(...table.map(measure))) {
		table.forEach((line, index) => append(index, line));
		return "wide";
	}
	const condensed = `TRAF ${row.type} ${row.data.replace(" GB", "GB")}${row.time === "-" ? "" : ` ${row.time}`}`;
	if (available >= measure(condensed)) {
		append(1, condensed);
		return "condensed";
	}
	return "skipped";
};

const validState = (value: unknown): value is TrafficState => {
	const state = value as TrafficState | undefined;
	return Boolean(
		state &&
		(state.mode === "LAN" || state.mode === "HOTSPOT") &&
		validBytes(state.local) &&
		typeof state.cycle?.key === "string" &&
		Number.isFinite(state.cycle.resetAt) &&
		validBytes(state.cycle.lan) &&
		validBytes(state.cycle.hotspot),
	);
};

export class TrafficMeter {
	private state: TrafficState;
	private child?: ReturnType<typeof spawn>;
	private buffer = "";
	private headers = 0;
	private bytesInColumn = -1;
	private bytesOutColumn = -1;
	readonly path: string;

	constructor(
		private readonly isLocal: () => boolean,
		private readonly changed: () => void,
		path = join(homedir(), ".pi", "agent", "traffic-state.json"),
	) {
		this.path = path;
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
			this.state = validState(value) ? normalizeCycle(value, Date.now()) : newTrafficState();
		} catch {
			this.state = newTrafficState();
		}
	}

	snapshot(): TrafficState {
		this.state = normalizeCycle(this.state, Date.now());
		return structuredClone(this.state);
	}

	start(): void {
		if (this.child) return;
		this.child = spawn("nettop", [
			"-n", "-P", "-x", "-d", "-L", "0", "-s", "5", "-t", "external",
			"-J", "bytes_in,bytes_out", "-p", String(process.pid),
		], { stdio: ["ignore", "pipe", "ignore"] });
		this.child.on("error", () => { this.child = undefined; });
		this.child.stdout?.on("data", (chunk: Buffer) => this.consume(String(chunk)));
	}

	stop(): void {
		this.child?.kill("SIGTERM");
		this.child = undefined;
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			const fields = line.trim().split(",");
			if (fields.includes("bytes_in") && fields.includes("bytes_out")) {
				this.headers++;
				this.bytesInColumn = fields.indexOf("bytes_in");
				this.bytesOutColumn = fields.indexOf("bytes_out");
				continue;
			}
			if (this.headers < 2) continue; // First sample establishes the baseline.
			const bytesIn = Number(fields[this.bytesInColumn]);
			const bytesOut = Number(fields[this.bytesOutColumn]);
			if (!Number.isFinite(bytesIn) || !Number.isFinite(bytesOut)) continue;
			this.state = addTrafficSample(
				this.state,
				{ bytesIn, bytesOut },
				this.isLocal(),
			);
			this.write();
			this.changed();
		}
	}

	private write(): void {
		// ponytail: single writer; add locking if concurrent Pi sessions must be counted.
		mkdirSync(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, this.path);
	}
}
