import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortable, fetchUsage, formatStatus, POLL_MS, usageScope, type UsageSnapshot } from "./usage.ts";

const STATUS_KEY = "codex-usage";
const REQUEST_TIMEOUT_MS = 10_000;

interface Dependencies {
	load?: typeof fetchUsage;
	now?: () => number;
	repeat?: typeof setInterval;
	cancelRepeat?: typeof clearInterval;
}

export function registerUsageStatus(pi: ExtensionAPI, dependencies: Dependencies = {}): void {
	const load = dependencies.load ?? fetchUsage;
	const now = dependencies.now ?? Date.now;
	const repeat = dependencies.repeat ?? setInterval;
	const cancelRepeat = dependencies.cancelRepeat ?? clearInterval;
	let context: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let request: AbortController | undefined;
	let generation = 0;
	let lastAttempt = -Infinity;
	let snapshot: UsageSnapshot | undefined;
	let failed = false;

	function render(): void {
		if (!context) return;
		const theme = context.ui.theme;
		context.ui.setStatus(STATUS_KEY, formatStatus(
			snapshot, now(), failed, (color, text) => theme.fg(color, text), usageScope(context.model?.id),
		));
	}

	async function refresh(force = false): Promise<void> {
		if (!context || request || (!force && now() - lastAttempt < POLL_MS)) return;
		const ctx = context;
		const currentGeneration = generation;
		const controller = new AbortController();
		request = controller;
		lastAttempt = now();
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
		try {
			const result = await abortable(load(
				() => ctx.modelRegistry.getApiKeyForProvider("openai-codex"), signal,
				undefined, now, usageScope(ctx.model?.id),
			), signal);
			if (currentGeneration !== generation) return;
			snapshot = result;
			failed = false;
		} catch {
			if (currentGeneration !== generation) return;
			// Keep the last good reading visibly stale, never report failures as 0%.
			failed = true;
		} finally {
			if (currentGeneration === generation) {
				request = undefined;
				render();
			}
		}
	}

	function stop(): void {
		generation++;
		if (timer) cancelRepeat(timer);
		timer = undefined;
		request?.abort();
		request = undefined;
		context?.ui.setStatus(STATUS_KEY, undefined);
		context = undefined;
		snapshot = undefined;
		failed = false;
		lastAttempt = -Infinity;
	}

	function start(ctx: ExtensionContext): void {
		stop();
		// No background polling for worker/subagent, JSON, print, or RPC sessions.
		if (ctx.mode !== "tui" || ctx.model?.provider !== "openai-codex") return;
		context = ctx;
		render();
		void refresh();
		timer = repeat(() => {
			render(); // Update reset countdowns while idle; fetch at most once a minute.
			void refresh();
		}, 15_000);
		timer.unref();
	}

	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("model_select", (_event, ctx) => start(ctx));
	pi.on("agent_settled", () => { render(); void refresh(); });
	pi.on("session_shutdown", () => stop());
	pi.registerCommand("usage-refresh", {
		description: "Refresh the active Codex or Spark model's 5-hour and weekly limits",
		handler: async (_args, ctx) => {
			if (!context) {
				if (ctx.hasUI) ctx.ui.notify("Usage footer requires an interactive OpenAI Codex session.", "info");
				return;
			}
			await refresh(true);
		},
	});
}

export default function (pi: ExtensionAPI): void {
	registerUsageStatus(pi);
}
