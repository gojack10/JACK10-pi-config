import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type WireBytes = { bytesIn: number; bytesOut: number };
export type TrafficMode = "LAN" | "HOTSPOT";
export type NetworkClass = "lan" | "hotspot";
export type NetworkLabel = {
	kind: "network_label";
	networkId: string;
	class: NetworkClass;
	setAt: string;
	profileRevision: 1;
	signals: string[];
	reason: "manual";
};
export type NetworkIdentity =
	| { status: "ONLINE"; networkId: string; signals: string[] }
	| { status: "OFFLINE" };
export type TrafficState = {
	mode: TrafficMode;
	local: WireBytes;
	cycle: {
		key: string;
		resetAt: number;
		lan: WireBytes;
		hotspot: WireBytes;
		unknown: WireBytes;
	};
	networkLabel?: NetworkLabel;
};
export type TrafficRow = {
	type: "LOCAL" | "LAN:manual" | "HOTSPOT:manual" | "UNKNOWN" | "OFFLINE";
	data: string;
	time: string;
};

type Exec = (command: string, args: string[]) => string;
type CommandLevel = "info" | "warning" | "error";
export type TrafficCommandResult = { level: CommandLevel; text: string };
export type TrafficCommandOptions = {
	path?: string;
	keyPath?: string;
	identity?: () => NetworkIdentity;
	now?: () => number;
	changed?: () => void;
};

const DEFAULT_STATE_PATH = join(homedir(), ".pi", "agent", "traffic-state.json");
const DEFAULT_KEY_PATH = join(homedir(), ".pi", "agent", ".traffic-key");
const USAGE = "Usage: /traffic [hotspot|lan]";
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
	cycle: {
		...billingCycle(now),
		lan: emptyBytes(),
		hotspot: emptyBytes(),
		unknown: emptyBytes(),
	},
});

const validLabel = (value: unknown): value is NetworkLabel => {
	const label = value as NetworkLabel | undefined;
	return Boolean(
		label &&
		label.kind === "network_label" &&
		/^hmac:[a-f0-9]{64}$/.test(label.networkId) &&
		(label.class === "lan" || label.class === "hotspot") &&
		typeof label.setAt === "string" &&
		label.profileRevision === 1 &&
		Array.isArray(label.signals) && label.signals.every((signal) => typeof signal === "string") &&
		label.reason === "manual",
	);
};

const parseState = (value: unknown, now: number): TrafficState | undefined => {
	const state = value as TrafficState | undefined;
	if (!state || (state.mode !== "LAN" && state.mode !== "HOTSPOT")) return undefined;
	if (!validBytes(state.local) || typeof state.cycle?.key !== "string") return undefined;
	if (!Number.isFinite(state.cycle.resetAt) || !validBytes(state.cycle.lan)) return undefined;
	if (!validBytes(state.cycle.hotspot)) return undefined;
	const cycle = billingCycle(now);
	if (state.cycle.key !== cycle.key) {
		return {
			mode: state.mode,
			local: state.local,
			cycle: { ...cycle, lan: emptyBytes(), hotspot: emptyBytes(), unknown: emptyBytes() },
			...(validLabel(state.networkLabel) ? { networkLabel: state.networkLabel } : {}),
		};
	}
	return {
		mode: state.mode,
		local: state.local,
		cycle: {
			key: state.cycle.key,
			resetAt: state.cycle.resetAt,
			lan: state.cycle.lan,
			hotspot: state.cycle.hotspot,
			unknown: validBytes(state.cycle.unknown) ? state.cycle.unknown : emptyBytes(),
		},
		...(validLabel(state.networkLabel) ? { networkLabel: state.networkLabel } : {}),
	};
};

export const readTrafficState = (path = DEFAULT_STATE_PATH, now = Date.now()): TrafficState => {
	try {
		return parseState(JSON.parse(readFileSync(path, "utf8")), now) ?? newTrafficState(now);
	} catch {
		return newTrafficState(now);
	}
};

export const writeTrafficState = (path: string, state: TrafficState): void => {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try { unlinkSync(temporary); } catch {}
		throw error;
	}
};

const sleep = (milliseconds: number) =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

const updateTrafficState = (
	path: string,
	update: (state: TrafficState) => TrafficState,
	now = Date.now(),
): TrafficState => {
	mkdirSync(dirname(path), { recursive: true });
	const lock = `${path}.lock`;
	let fd: number | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			fd = openSync(lock, "wx", 0o600);
			writeFileSync(fd, String(process.pid));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 99) throw error;
			try {
				const owner = Number(readFileSync(lock, "utf8"));
				process.kill(owner, 0);
			} catch (ownerError) {
				if ((ownerError as NodeJS.ErrnoException).code === "ESRCH") {
					try { unlinkSync(lock); } catch {}
				}
			}
			sleep(10);
		}
	}
	try {
		const state = update(readTrafficState(path, now));
		writeTrafficState(path, state);
		return state;
	} finally {
		if (fd !== undefined) closeSync(fd);
		try { unlinkSync(lock); } catch {}
	}
};

const readOrCreateKey = (path: string): Buffer => {
	mkdirSync(dirname(path), { recursive: true });
	try {
		const key = readFileSync(path);
		if (key.length < 32) throw new Error(`Traffic key is too short: ${path}`);
		chmodSync(path, 0o600);
		return key;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const key = randomBytes(32);
	let fd: number | undefined;
	try {
		fd = openSync(path, "wx", 0o600);
		writeFileSync(fd, key);
		closeSync(fd);
		fd = undefined;
		chmodSync(path, 0o600);
		return key;
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return readOrCreateKey(path);
		throw error;
	}
};

export const getNetworkIdentity = (options: { keyPath?: string; exec?: Exec } = {}): NetworkIdentity => {
	const run = options.exec ?? ((command, args) => execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}));
	let route: string;
	try {
		route = run("route", ["-n", "get", "default"]);
	} catch {
		return { status: "OFFLINE" };
	}
	const networkInterface = route.match(/^\s*interface:\s*(\S+)/m)?.[1];
	if (!networkInterface) return { status: "OFFLINE" };
	const gateway = route.match(/^\s*gateway:\s*(\S+)/m)?.[1] ?? "";
	let ssid = "";
	try {
		const output = run("networksetup", ["-getairportnetwork", networkInterface]);
		ssid = output.match(/^Current Wi-Fi Network:\s*(.+)$/m)?.[1]?.trim() ?? "";
	} catch {}
	const signals = ["route", ...(gateway ? ["gateway"] : []), ...(ssid ? ["wifi"] : [])];
	const key = readOrCreateKey(options.keyPath ?? DEFAULT_KEY_PATH);
	const digest = createHmac("sha256", key)
		.update(JSON.stringify([networkInterface, gateway, ssid]))
		.digest("hex");
	return { status: "ONLINE", networkId: `hmac:${digest}`, signals };
};

const activeClass = (state: TrafficState, identity: NetworkIdentity): TrafficMode | undefined => {
	if (identity.status !== "ONLINE" || !state.networkLabel) return undefined;
	if (identity.networkId !== state.networkLabel.networkId) return undefined;
	return state.networkLabel.class.toUpperCase() as TrafficMode;
};

export const addTrafficSample = (
	state: TrafficState,
	sample: WireBytes,
	isLocal: boolean,
	now = Date.now(),
	identity: NetworkIdentity = { status: "OFFLINE" },
): TrafficState => {
	const next = structuredClone(parseState(state, now) ?? newTrafficState(now));
	const classification = activeClass(next, identity);
	const target = isLocal
		? next.local
		: classification === "HOTSPOT"
			? next.cycle.hotspot
			: classification === "LAN"
				? next.cycle.lan
				: next.cycle.unknown;
	target.bytesIn += Math.max(0, sample.bytesIn);
	target.bytesOut += Math.max(0, sample.bytesOut);
	return next;
};

const formatBytes = (bytes: WireBytes): string => {
	const total = bytes.bytesIn + bytes.bytesOut;
	return total < 1_000_000_000
		? `${(total / 1_000_000).toFixed(1)} MB`
		: `${(total / 1_000_000_000).toFixed(1)} GB`;
};

export const trafficRow = (
	state: TrafficState,
	isLocal: boolean,
	formatTimer: (milliseconds: number) => string,
	now = Date.now(),
	identity: NetworkIdentity = { status: "OFFLINE" },
	degraded = false,
): TrafficRow => {
	const current = parseState(state, now) ?? newTrafficState(now);
	const health = degraded ? "!" : "";
	if (isLocal) return { type: "LOCAL", data: `${formatBytes(current.local)}${health}`, time: "-" };
	if (identity.status === "OFFLINE") return { type: "OFFLINE", data: "!", time: "-" };
	const classification = activeClass(current, identity);
	if (classification === "HOTSPOT") {
		return {
			type: "HOTSPOT:manual",
			data: `${formatBytes(current.cycle.hotspot)}/25 GB${health}`,
			time: formatTimer(current.cycle.resetAt - now),
		};
	}
	if (classification === "LAN") {
		return {
			type: "LAN:manual",
			data: `${formatBytes(current.cycle.lan)}${health}`,
			time: formatTimer(current.cycle.resetAt - now),
		};
	}
	return { type: "UNKNOWN", data: `${formatBytes(current.cycle.unknown)}!`, time: "-" };
};

export const nettopArgs = (pid = process.pid): string[] => [
	"-n", "-P", "-x", "-d", "-L", "2", "-s", "5",
	"-J", "bytes_in,bytes_out", "-p", String(pid),
];

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
	const condensed = `TRAF ${row.type} ${row.data.replaceAll(" GB", "GB")}${row.time === "-" ? "" : ` ${row.time}`}`;
	if (available >= measure(condensed)) {
		append(1, condensed);
		return "condensed";
	}
	return "skipped";
};

export const runTrafficCommand = (
	args: string,
	options: TrafficCommandOptions = {},
): TrafficCommandResult => {
	const argument = args.trim().toLowerCase();
	if (argument && argument !== "hotspot" && argument !== "lan") {
		return { level: "warning", text: USAGE };
	}
	const identity = options.identity?.() ?? getNetworkIdentity({ keyPath: options.keyPath });
	if (identity.status === "OFFLINE") {
		return { level: "error", text: "OFFLINE — no default route; cannot classify." };
	}
	const path = options.path ?? DEFAULT_STATE_PATH;
	if (argument) {
		const networkClass = argument as NetworkClass;
		const setAt = new Date(options.now?.() ?? Date.now()).toISOString();
		updateTrafficState(path, (state) => ({
			...state,
			mode: networkClass.toUpperCase() as TrafficMode,
			networkLabel: {
				kind: "network_label",
				networkId: identity.networkId,
				class: networkClass,
				setAt,
				profileRevision: 1,
				signals: identity.signals,
				reason: "manual",
			},
		}));
		options.changed?.();
		return {
			level: "info",
			text: `${networkClass.toUpperCase()}:manual set for ${identity.networkId} (signals: ${identity.signals.join(",")})`,
		};
	}
	const state = readTrafficState(path, options.now?.() ?? Date.now());
	const matches = state.networkLabel?.networkId === identity.networkId;
	const currentClass = matches && state.networkLabel
		? `${state.networkLabel.class.toUpperCase()}:manual`
		: "UNKNOWN";
	const setAt = state.networkLabel?.setAt ?? "-";
	const prompt = matches ? "" : " Re-classify with /traffic hotspot or /traffic lan.";
	return {
		level: matches ? "info" : "warning",
		text: `Network ${identity.networkId} (signals: ${identity.signals.join(",")}) | class ${currentClass} | setAt ${setAt} | matches ${matches ? "yes" : "no"}.${prompt}`,
	};
};

type TrafficCommandRegistrar = {
	registerCommand: (name: string, options: {
		description: string;
		handler: (args: string, ctx: {
			ui: { notify: (message: string, level: CommandLevel) => void };
		}) => void;
	}) => void;
};

export const registerTrafficCommand = (
	pi: TrafficCommandRegistrar,
	options: TrafficCommandOptions = {},
): void => {
	pi.registerCommand("traffic", {
		description: "Classify this network as hotspot or LAN, or show its current classification",
		handler: (args, ctx) => {
			const result = runTrafficCommand(args, options);
			ctx.ui.notify(result.text, result.level);
		},
	});
};

export class TrafficMeter {
	private state: TrafficState;
	private child?: ReturnType<typeof spawn>;
	private buffer = "";
	private headers = 0;
	private bytesInColumn = -1;
	private bytesOutColumn = -1;
	private detected?: { at: number; identity: NetworkIdentity };
	private startedAt?: number;
	private lastSampleAt?: number;
	readonly path: string;

	constructor(
		private readonly isLocal: () => boolean,
		private readonly changed: () => void,
		path = DEFAULT_STATE_PATH,
		private readonly detect: () => NetworkIdentity = () => getNetworkIdentity(),
	) {
		this.path = path;
		this.state = readTrafficState(path);
	}

	snapshot(): TrafficState {
		this.state = readTrafficState(this.path);
		return structuredClone(this.state);
	}

	currentIdentity(now = Date.now()): NetworkIdentity {
		if (!this.detected || now - this.detected.at >= 5000) {
			this.detected = { at: now, identity: this.detect() };
		}
		return this.detected.identity;
	}

	start(): void {
		if (this.startedAt !== undefined) return;
		this.startedAt = Date.now();
		this.lastSampleAt = undefined;
		this.launch();
	}

	private launch(): void {
		this.buffer = "";
		this.headers = 0;
		this.bytesInColumn = -1;
		this.bytesOutColumn = -1;
		const child = spawn("nettop", nettopArgs(), { stdio: ["ignore", "pipe", "ignore"] });
		this.child = child;
		let failed = false;
		child.on("error", () => {
			failed = true;
			if (this.child === child) this.child = undefined;
		});
		child.on("close", () => {
			if (this.child === child) this.child = undefined;
			if (!failed && this.startedAt !== undefined) this.launch();
		});
		child.stdout?.on("data", (chunk: Buffer) => this.consume(String(chunk)));
	}

	stop(): void {
		this.child?.kill("SIGTERM");
		this.child = undefined;
		this.startedAt = undefined;
		this.lastSampleAt = undefined;
	}

	degraded(now = Date.now()): boolean {
		return this.startedAt !== undefined && now - (this.lastSampleAt ?? this.startedAt) >= 90_000;
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
			if (this.headers < 2) continue;
			const bytesIn = Number(fields[this.bytesInColumn]);
			const bytesOut = Number(fields[this.bytesOutColumn]);
			if (!Number.isFinite(bytesIn) || !Number.isFinite(bytesOut)) continue;
			const now = Date.now();
			this.lastSampleAt = now;
			this.state = updateTrafficState(
				this.path,
				(state) => addTrafficSample(
					state,
					{ bytesIn, bytesOut },
					this.isLocal(),
					now,
					this.currentIdentity(now),
				),
				now,
			);
			this.changed();
		}
	}
}
