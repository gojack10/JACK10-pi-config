/**
 * Temperature Control Extension
 *
 * /temp command opens a horizontal slider (0 – 2, step 0.5) with a free-text
 * fallback for arbitrary one-decimal values.  Persists to settings.json so
 * the value survives restarts.  Injects the chosen temperature into every
 * provider request via before_provider_request.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	matchesKey,
	Key,
} from "@mariozechner/pi-tui";

const VALUES = [0, 0.5, 1, 1.5, 2] as const;
const CONFIG_FILE = join(require("node:os").homedir(), ".pi", "agent", "temperature.json");

/* ── Persistence ─────────────────────────────────────────────────────── */

function loadTemp(): number | null {
	if (!existsSync(CONFIG_FILE)) return null;
	try {
		const d = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as { temp?: number };
		return d.temp ?? null;
	} catch {
		return null;
	}
}

function saveTemp(v: number | null) {
	writeFileSync(CONFIG_FILE, JSON.stringify({ temp: v }), "utf-8");
}

/* ── Slider component ────────────────────────────────────────────────── */

class TempSlider {
	public selected = 1; // index into VALUES (starts at 1.0)
	public mode: "slider" | "other" = "slider";

	private positions: number[] = [];

	private refresh: (() => void) | null = null;

	constructor(currentTemp: number | null) {
		if (currentTemp !== null) {
			const idx = VALUES.indexOf(currentTemp);
			if (idx !== -1) this.selected = idx;
		}
	}

	component(
		tui: { requestRender: () => void },
		theme: { fg: (c: string, s: string) => string; bold: (s: string) => string },
		done: (value: number | null) => void,
	) {
		this.refresh = () => {
			tui.requestRender();
		};

		return {
			render: (width: number) => this.renderRow(width, theme),
			handleInput: (data: string) => this.handleInput(data, tui, done),
		};
	}

	private renderRow(
		width: number,
		theme: { fg: (c: string, s: string) => string; bold: (s: string) => string },
	): string[] {
		const lines: string[] = [];
		const add = (s: string) => lines.push(s.padEnd(width).slice(0, width));

		// ── Title ──────────────────────────────────────────────
		add(theme.fg("accent", theme.bold("  Temperature")));
		add("");

		// ── Compute positions ──────────────────────────────────
		const trackWidth = Math.max(width - 4, 20);
		const positions = VALUES.map((_, i) =>
			Math.round((i / (VALUES.length - 1)) * (trackWidth - 2)),
		);
		this.positions = positions;

		// ── Numbers row (above track) ──────────────────────────
		const numLine = Array.from({ length: width }, () => " ");
		for (let i = 0; i < VALUES.length; i++) {
			const label = String(VALUES[i]);
			const col = 2 + positions[i] - Math.floor(label.length / 2);
			for (let c = 0; c < label.length; c++) {
				const idx = col + c;
				if (idx >= 0 && idx < width) {
					numLine[idx] = label[c] || " ";
				}
			}
		}
		add(numLine.join(""));

		// ── Track row ──────────────────────────────────────────
		if (this.mode === "slider") {
			const trackChars: string[] = [];
			trackChars.push("> ");
			for (let c = 0; c < trackWidth; c++) {
				trackChars.push(c === positions[this.selected] ? "\u2588" : "\u2500");
			}
			trackChars.push("  ");
			add(trackChars.join("").padEnd(width).slice(0, width));
		} else {
			const trackChars: string[] = [];
			trackChars.push("  ");
			for (let c = 0; c < trackWidth; c++) {
				trackChars.push("\u2500");
			}
			trackChars.push("  ");
			add(trackChars.join("").padEnd(width).slice(0, width));
		}

		// ── Spacer ─────────────────────────────────────────────
		add("");

		// ── Other row ──────────────────────────────────────────
		const selected = this.mode === "other";
		const text = selected
			? theme.fg("accent", "> Other")
			: "  Other";
		add(text.padEnd(width).slice(0, width));

		// ── Spacer + help ──────────────────────────────────────
		add("");
		add(theme.fg("dim", "  \u2190\u2192 slide \u2022 \u2191\u2193 navigate \u2022 enter set \u2022 esc cancel"));

		return lines;
	}

	private handleInput(
		data: string,
		tui: { requestRender: () => void },
		done: (v: number | null) => void,
	) {
		const refresh = () => tui.requestRender();

		// ── Slider mode ────────────────────────────────────────
		if (this.mode === "slider") {
			if (matchesKey(data, Key.left)) {
				if (this.selected > 0) {
					this.selected--;
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.right)) {
				if (this.selected < VALUES.length - 1) {
					this.selected++;
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.mode = "other";
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				done(VALUES[this.selected]);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done("cancel" as unknown as number);
				return;
			}
			return;
		}

		// ── Other mode ─────────────────────────────────────────
		if (this.mode === "other") {
			if (matchesKey(data, Key.up)) {
				this.mode = "slider";
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				done("other" as unknown as number);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done("cancel" as unknown as number);
				return;
			}
			return;
		}
	}
}

/* ── Extension ───────────────────────────────────────────────────────── */

export default function (pi: ExtensionAPI) {
	let currentTemp: number | null = loadTemp();

	pi.on("session_start", () => {
		currentTemp = loadTemp();
	});

	// Inject temperature into every provider request.
	// Codex rejects `temperature` with 400 "Unsupported parameter", so skip it there.
	pi.on("before_provider_request", (event) => {
		if (currentTemp === null) return undefined;
		if (event.provider.includes("codex")) return undefined;
		return { ...event.payload, temperature: currentTemp };
	});

	pi.registerCommand("temp", {
		description: "Set model temperature (0-2)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Temperature control requires interactive mode", "warning");
				return;
			}

		const showSlider = async (): Promise<number | "other" | "cancel"> => {
			const slider = new TempSlider(currentTemp);
			const result = await ctx.ui.custom<number | string | null>((tui, theme, _kb, done) => {
				const comp = slider.component(tui, theme, done);
				return comp;
			});
			return (result ?? "cancel") as number | "other" | "cancel";
		};

		let done = false;
		while (!done) {
			const result = await showSlider();
			if (result === "cancel") break;

			if (result === "other") {
				const input = await ctx.ui.input("Custom temperature (0–2, one decimal):", "");
				if (!input) continue; // esc in input → back to slider
				const trimmed = input.trim();
				const val = parseFloat(trimmed);
				if (isNaN(val) || val < 0 || val > 2) {
					ctx.ui.notify("Value must be between 0 and 2", "error");
					continue;
				}
				if (trimmed.includes(".") && trimmed.split(".")[1].length > 1) {
					ctx.ui.notify("One decimal place only (e.g. 0.7)", "error");
					continue;
				}
				currentTemp = Math.round(val * 10) / 10;
				saveTemp(currentTemp);
				ctx.ui.notify(`Temperature set to ${currentTemp}`, "info");
				done = true;
			} else {
				currentTemp = result;
				saveTemp(result);
				ctx.ui.notify(`Temperature set to ${result}`, "info");
				done = true;
			}
		}
		},
	});
}
