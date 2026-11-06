/** Shared Pi and Codex presentation of measured local-inference progress. */
export const CHUNK_MIN_TOKENS = 256;
const BAR_WIDTH = 20;
const MAX_CHUNK_CELLS = 12;
export interface ProgressData {
	phase: "prefill" | "decode";
	processed: number;
	total: number;
	tokens: number;
	tok_s: number;
	eta?: number;
	count?: number;
	origin?: string;
}
function numeric(value: unknown): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}
function getItemSpeed(item: any): number {
	return numeric(item?.speed ?? item?.tok_s ?? item?.tokens_per_second);
}
const PARTIAL_BLOCKS: Record<number, string> = {
	1: "\u258F",
	2: "\u258E",
	3: "\u258D",
	4: "\u258C",
	5: "\u258B",
	6: "\u258A",
	7: "\u2589",
};

function buildBar(filled: number, total: number): string {
	const pct = total > 0 ? Math.min(filled / total, 1) : 0;
	const eighths = Math.floor(pct * BAR_WIDTH * 8);
	const full = Math.floor(eighths / 8);
	const rem = eighths % 8;
	const empty = BAR_WIDTH - full - (rem > 0 ? 1 : 0);
	return (
		"\u2588".repeat(full) +
		(rem > 0 ? PARTIAL_BLOCKS[rem] : "") +
		"\u2591".repeat(empty)
	);
}

/* One cell per bite, separated so the segmentation is visible. Cells fill only
 * when a bite completes; the final (possibly token-by-token) bite fills its
 * cell gradually. Scaled down to MAX_CHUNK_CELLS when there are more bites. */
export function buildChunkBar(
	processed: number,
	total: number,
	cellTokens: number,
	cellsTotal: number,
	cells: number,
): string {
	if (cellTokens <= 0 || cellsTotal <= 0 || cells <= 0) return "";
	const fullBites = Math.floor(processed / cellTokens);
	const cellsFilled = Math.min(
		cells,
		Math.floor((fullBites * cells) / cellsTotal),
	);
	const unscaled = cells === cellsTotal;
	const finalBite = Math.max(1, total - (cellsTotal - 1) * cellTokens);
	const parts: string[] = [];
	for (let i = 0; i < cells; i++) {
		if (i < cellsFilled) {
			parts.push("\u2588");
			continue;
		}
		if (unscaled && i === cellsFilled && fullBites >= cellsTotal - 1) {
			const frac = Math.min(
				1,
				(processed - (cellsTotal - 1) * cellTokens) / finalBite,
			);
			if (frac > 0) {
				const eighth = Math.round(frac * 8);
				parts.push(
					eighth >= 8
						? "\u2588"
						: (PARTIAL_BLOCKS[Math.max(1, eighth)] ?? "\u2591"),
				);
				continue;
			}
		}
		parts.push("\u2591");
	}
	return parts.join(" ");
}

function formatTokS(tok_s: number): string {
	if (tok_s <= 0) return "";
	if (tok_s >= 1000) return `${(tok_s / 1000).toFixed(1)}k tok/s`;
	return `${Math.round(tok_s)} tok/s`;
}

function formatRemaining(seconds: number): string {
	if (!seconds || seconds <= 0 || seconds > 36000) return "";
	if (seconds >= 60)
		return `, ${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s left`;
	return `, ${Math.round(seconds)}s left`;
}

export function originLabel(origin?: string): string {
	const value = typeof origin === "string" ? origin.trim() : "";
	return !value || value.toLowerCase() === "user"
		? ""
		: ` (${value.toUpperCase()})`;
}

export function formatPrefill(
	data: ProgressData,
	interpolated: number,
): string {
	const clamped = Math.min(Math.max(interpolated, 0), data.total);
	const bar = buildBar(clamped, data.total);
	const speed = formatTokS(data.tok_s);
	const clbl =
		data.count != null && data.count > 1 ? ` (${data.count} PP)` : "";
	const eta = formatRemaining(data.eta ?? 0);
	const sp = speed ? `  (${speed})` : "";
	return `Prefill${originLabel(data.origin)}${clbl} ${bar}  ${Math.floor(clamped)}/${data.total} tokens${eta}${sp}`;
}

export function formatDecode(data: ProgressData): string {
	const speed = formatTokS(data.tok_s);
	const clbl = data.count != null && data.count > 1 ? ` (${data.count})` : "";
	const sp = speed ? `  (${speed})` : "";
	return `Decoding${originLabel(data.origin)}${clbl} - ${data.tokens} tokens${sp}`;
}

export function formatQueued(position: number): string {
	const mod100 = position % 100;
	const suffix =
		mod100 >= 11 && mod100 <= 13
			? "th"
			: position % 10 === 1
				? "st"
				: position % 10 === 2
					? "nd"
					: position % 10 === 3
						? "rd"
						: "th";
	return `Queued (${position}${suffix})`;
}

export function formatPrefillChunks(data: {
	processed: number;
	total: number;
	cellTokens: number;
	cellsTotal: number;
	tok_s: number;
	eta?: number;
	origin?: string;
	count?: number;
}): string {
	const cells = Math.min(data.cellsTotal, MAX_CHUNK_CELLS);
	const bar = buildChunkBar(
		data.processed,
		data.total,
		data.cellTokens,
		data.cellsTotal,
		cells,
	);
	const done = Math.min(
		Math.floor(data.processed / data.cellTokens),
		data.cellsTotal,
	);
	const speed = formatTokS(data.tok_s);
	const clbl =
		data.count != null && data.count > 1 ? ` (${data.count} PP)` : "";
	const eta = formatRemaining(data.eta ?? 0).replace(/^,\s*/, "");
	const sp = speed ? ` (${speed})` : "";
	const left = eta ? ` ${eta}` : "";
	return `Prefill${originLabel(data.origin)}${clbl} ${bar} ${done}/${data.cellsTotal} chunks${sp}${left}`;
}

export class PrefillProgress {
	barPos = 0; // current bar position (tokens)
	barStart = 0; // when current motion segment began
	apiSpeed = 0; // real API tok/s (what we display as speed)
	dispSpeed = 0; // display speed: how fast barPos advances (tokens/s)

	gtProcessed = 0;
	gtTotal = 0;
	gtEta: number | undefined;
	gtCount: number | undefined;
	gtOrigin: string | undefined;
	gtSpeed = 0;
	gtLastPollTime = 0;

	// Chunk ledger
	cellTokens = 0; // tokens per bite, learned from completed bites
	cellsTotal = 0; // ceil(total / cellTokens)
	biteKnown = false; // the first real bite of this prefill has been seen
	bitesSeen = 0;
	lastProcessed = 0; // authoritative processed at the last observed bite
	lastBiteAt = 0;
	tailActive = false; // engine switched to token-by-token at the end
	tailBase = 0;
	tailRate = 0;
	tailStart = 0;

	reset() {
		this.barPos = 0;
		this.barStart = 0;
		this.apiSpeed = 0;
		this.dispSpeed = 0;
		this.gtProcessed = 0;
		this.gtTotal = 0;
		this.gtEta = undefined;
		this.gtCount = undefined;
		this.gtOrigin = undefined;
		this.gtSpeed = 0;
		this.gtLastPollTime = 0;
		this.cellTokens = 0;
		this.cellsTotal = 0;
		this.biteKnown = false;
		this.bitesSeen = 0;
		this.lastProcessed = 0;
		this.lastBiteAt = 0;
		this.tailActive = false;
		this.tailBase = 0;
		this.tailRate = 0;
		this.tailStart = 0;
	}

	interpolate(now: number): number {
		if (this.dispSpeed <= 0) return this.barPos;
		const elapsed = (now - this.barStart) / 1000;
		const ceiling =
			this.gtProcessed < this.gtTotal ? this.gtTotal - 1 : this.gtTotal;
		return Math.min(this.barPos + this.dispSpeed * elapsed, ceiling);
	}

	chunkDisplayProcessed(now: number): number {
		if (!this.tailActive || this.tailRate <= 0) return this.gtProcessed;
		return Math.min(
			this.tailBase + (this.tailRate * (now - this.tailStart)) / 1000,
			this.gtTotal,
		);
	}

	text(now: number): string {
		if (this.cellTokens > 0 && this.cellsTotal > 0) {
			return formatPrefillChunks({
				processed: this.chunkDisplayProcessed(now),
				total: this.gtTotal,
				cellTokens: this.cellTokens,
				cellsTotal: this.cellsTotal,
				tok_s: this.gtSpeed,
				eta: this.gtEta,
				origin: this.gtOrigin,
				count: this.gtCount,
			});
		}
		const interpolated = this.interpolate(now);
		return formatPrefill(
			{
				phase: "prefill",
				processed: interpolated,
				total: this.gtTotal,
				tokens: 0,
				tok_s: this.apiSpeed,
				eta: this.gtEta,
				count: this.gtCount,
				origin: this.gtOrigin,
			},
			interpolated,
		);
	}

	observe(
		first: any,
		count: number,
		now: number,
		wasActivity: boolean,
		rememberBite: (bite: number) => void = () => {},
		guess = 0,
	) {
		const processed = numeric(first.processed);
		const total = numeric(first.total);
		const speed = getItemSpeed(first);
		const pf = { length: count };
		if (
			!wasActivity ||
			total !== this.gtTotal ||
			processed < this.lastProcessed
		) {
			this.reset();
			// Reuse the learned bite size so the ledger shows from the start,
			// but only while it still describes this prompt scale; the first
			// completed bite corrects it.
			if (guess > 0 && total > 0 && total <= guess * 8) {
				this.cellTokens = guess;
				this.cellsTotal = Math.ceil(total / this.cellTokens);
			}
		}

		if (processed > this.lastProcessed) {
			const delta = processed - this.lastProcessed;
			const bite = this.lastBiteAt > 0 ? (now - this.lastBiteAt) / 1000 : 0;
			if (delta >= CHUNK_MIN_TOKENS) {
				this.bitesSeen += 1;
				if (!this.biteKnown) {
					this.biteKnown = true;
					if (delta !== this.cellTokens) {
						this.cellTokens = delta;
						this.cellsTotal = Math.ceil(total / this.cellTokens);
					}
					// Only remember a bite that is part of a multi-bite prompt; a
					// one-bite total would poison the next prompt's guess.
					if (delta < total) rememberBite(delta);
				}
			} else if (this.bitesSeen === 0) {
				// Whole prefill is token-by-token: keep the smooth bar.
				this.cellTokens = 0;
				this.cellsTotal = 0;
			} else {
				// Token-level tail: let the final cell fill smoothly.
				this.tailActive = true;
				this.tailBase = processed;
				this.tailStart = now;
				if (bite > 0) {
					const inst = delta / bite;
					this.tailRate =
						this.tailRate > 0
							? this.tailRate + (inst - this.tailRate) * 0.3
							: inst;
				}
			}
			this.lastProcessed = processed;
			this.lastBiteAt = now;
		}

		if (this.cellTokens === 0) {
			if (speed > 0)
				this.apiSpeed =
					this.apiSpeed === 0
						? speed
						: this.apiSpeed + (speed - this.apiSpeed) * 0.2;
			this.barPos = processed;
			this.barStart = now;
			this.dispSpeed = this.apiSpeed;
		}

		this.gtProcessed = processed;
		this.gtTotal = total;
		this.gtEta = numeric(first.eta);
		this.gtCount = pf.length;
		this.gtOrigin = first.origin;
		this.gtSpeed = speed;
		this.gtLastPollTime = now;
	}
}
