/** Native progress line in Codex's existing above-composer portal. */
import { ipcRenderer } from "electron";
import {
	PrefillProgress,
	formatQueued,
	formatDecode,
	formatPrefill,
} from "../extensions/local-llm-generation/progress.js";

type Sample = {
	processed?: number;
	total?: number;
	speed?: number;
	tok_s?: number;
	tokens_per_second?: number;
	eta?: number;
	generated_tokens?: number;
	tokens?: number;
	origin?: string;
};
type Snapshot = {
	version: number;
	thread_id: string;
	request_id?: string;
	model?: string;
	phase: string;
	queue_position?: number;
	prefill?: Sample[];
	decode?: Sample[];
};
type Entry = {
	portal: Element;
	element: HTMLElement;
	message: HTMLElement;
	threadId: string;
	prefill: PrefillProgress;
	snapshot?: Snapshot;
	polling: boolean;
	sampledAt: number;
};
const entries = new Map<Element, Entry>();
const guesses: Record<string, number> = {};
const storageKey = "codex.local-llm.chunk-sizes";
try {
	Object.assign(guesses, JSON.parse(localStorage.getItem(storageKey) || "{}"));
} catch {}
const speed = (sample: Sample) =>
	Number(sample.speed ?? sample.tok_s ?? sample.tokens_per_second ?? 0);
const now = () => performance.now();

function render(entry: Entry) {
	const snapshot = entry.snapshot;
	let text = "";
	if (snapshot && now() - entry.sampledAt < 4000) {
		switch (snapshot.phase) {
			case "queued":
				text = formatQueued(snapshot.queue_position || 1);
				break;
			case "loading":
				text = "Loading local model…";
				break;
			case "preparing":
				text = "Local model preparing…";
				break;
			case "stopping":
				text = "Local LLM stopping…";
				break;
			case "blocked":
				text = "Local model awaiting native completion";
				break;
			case "prefill": {
				const samples = snapshot.prefill || [];
				text =
					samples.length === 1
						? entry.prefill.text(now())
						: samples
								.map((p) =>
									formatPrefill(
										{
											phase: "prefill",
											processed: p.processed || 0,
											total: p.total || 0,
											tokens: 0,
											tok_s: speed(p),
											eta: p.eta,
											origin: p.origin,
										},
										p.processed || 0,
									),
								)
								.join(" | ");
				break;
			}
			case "decode":
				text = (snapshot.decode || [])
					.map((p) =>
						formatDecode({
							phase: "decode",
							processed: 0,
							total: 0,
							tokens: p.generated_tokens ?? p.tokens ?? 0,
							tok_s: speed(p),
							origin: p.origin,
						}),
					)
					.join(" | ");
				break;
		}
	}
	entry.element.hidden = !text;
	if (entry.message.textContent !== text) entry.message.textContent = text;
}

async function poll(entry: Entry) {
	if (entry.polling || !entry.portal.isConnected || document.hidden) return;
	entry.polling = true;
	try {
		const snapshot: Snapshot = await ipcRenderer.invoke(
			"local-llm:progress",
			entry.threadId,
		);
		if (
			!entry.portal.isConnected ||
			snapshot.thread_id !== entry.threadId ||
			snapshot.version !== 1
		)
			return;
		const previous = entry.snapshot;
		const sameRequest =
			!!snapshot.request_id && previous?.request_id === snapshot.request_id;
		if (!sameRequest || snapshot.phase !== "prefill") entry.prefill.reset();
		if (snapshot.phase === "prefill" && snapshot.prefill?.length === 1) {
			const model = snapshot.model || "";
			entry.prefill.observe(
				snapshot.prefill[0],
				1,
				now(),
				sameRequest && previous?.phase === "prefill",
				(bite) => {
					guesses[model] = bite;
					try {
						localStorage.setItem(storageKey, JSON.stringify(guesses));
					} catch {}
				},
				Number(guesses[model]) || 0,
			);
		}
		entry.snapshot = snapshot;
		entry.sampledAt = now();
		render(entry);
	} catch {
		entry.snapshot = undefined;
		render(entry);
	} finally {
		entry.polling = false;
	}
}

function reconcile() {
	for (const [portal, entry] of entries) {
		if (!portal.isConnected) {
			entry.element.remove();
			entries.delete(portal);
		}
	}
	for (const portal of document.querySelectorAll(
		"[data-above-composer-portal][data-above-composer-conversation-id]",
	)) {
		const rawId =
			portal.getAttribute("data-above-composer-conversation-id") || "";
		const threadId = rawId.match(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
		)?.[0];
		if (!threadId) continue;
		const previous = entries.get(portal);
		if (previous?.threadId === threadId && previous.element.isConnected)
			continue;
		previous?.element.remove();
		const element = document.createElement("div");
		element.setAttribute("data-local-llm-progress", "");
		element.hidden = true;
		const shadow = element.attachShadow({ mode: "closed" });
		const style = document.createElement("style");
		style.textContent =
			":host{display:block;min-width:0}:host([hidden]){display:none}.line{display:flex;align-items:baseline;gap:8px;padding:7px 10px;font-family:inherit;font-size:12px;color:var(--text-secondary,inherit)}.dot{flex:none;align-self:center;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.65}.message{white-space:normal;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;line-height:1.5}";
		const line = document.createElement("div");
		line.className = "line";
		line.setAttribute("aria-label", "Local model inference progress");
		const dot = document.createElement("span");
		dot.className = "dot";
		dot.setAttribute("aria-hidden", "true");
		const message = document.createElement("span");
		message.className = "message";
		line.append(dot, message);
		shadow.append(style, line);
		portal.append(element);
		const entry: Entry = {
			portal,
			element,
			message,
			threadId,
			prefill: new PrefillProgress(),
			polling: false,
			sampledAt: 0,
		};
		entries.set(portal, entry);
		void poll(entry);
	}
}

if (process.isMainFrame && location.origin === "app://-") {
	const observer = new MutationObserver(reconcile);
	const start = () => {
		observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-above-composer-conversation-id"],
		});
		reconcile();
	};
	if (document.documentElement) start();
	else document.addEventListener("DOMContentLoaded", start, { once: true });
	const polling = setInterval(() => {
		for (const entry of entries.values()) void poll(entry);
	}, 250);
	const animation = setInterval(() => {
		for (const entry of entries.values())
			if (entry.snapshot?.phase === "prefill") render(entry);
	}, 33);
	window.addEventListener(
		"beforeunload",
		() => {
			clearInterval(polling);
			clearInterval(animation);
			observer.disconnect();
		},
		{ once: true },
	);
}
