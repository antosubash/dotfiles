import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const COMPACT_FRACTION = 0.8;
const RETRY_DELAY_MS = 60_000;

export function thresholdForWindow(contextWindow: number): number | undefined {
	return Number.isFinite(contextWindow) && contextWindow > 0
		? Math.ceil(contextWindow * COMPACT_FRACTION) : undefined;
}

interface Dependencies {
	enabled: (ctx: ExtensionContext) => boolean;
	now?: () => number;
}

// Use only the public manual-compaction API, and only while idle. Calling
// ctx.compact() from turn_end would abort tool runs rather than resume them.
export function registerContextPolicy(pi: ExtensionAPI, dependencies: Dependencies): void {
	const now = dependencies.now ?? Date.now;
	let generation = 0;
	let active = false;
	let pending: Promise<void> | undefined;
	let retryAfter = 0;
	let lastCompactedKey: string | undefined;

	const keyFor = (ctx: ExtensionContext) =>
		`${ctx.model?.provider}/${ctx.model?.id}:${ctx.model?.contextWindow}:${ctx.sessionManager.getLeafId()}`;

	function check(ctx: ExtensionContext): Promise<void> | undefined {
		if (!active) return;
		if (pending) return pending;
		if (!ctx.isIdle() || ctx.hasPendingMessages() || !dependencies.enabled(ctx)) return;
		const usage = ctx.getContextUsage();
		const threshold = usage && thresholdForWindow(usage.contextWindow);
		if (threshold === undefined || !usage || usage.tokens === null || !Number.isFinite(usage.tokens)) return;
		if (usage.tokens < threshold) {
			lastCompactedKey = undefined;
			return;
		}
		if (now() < retryAfter || keyFor(ctx) === lastCompactedKey) return;

		const run = generation;
		let finish!: () => void;
		const operation = new Promise<void>((resolve) => { finish = resolve; });
		pending = operation;
		const complete = (failed: boolean) => {
			if (run === generation) {
				pending = undefined;
				if (failed) {
					retryAfter = now() + RETRY_DELAY_MS;
					if (ctx.hasUI) ctx.ui.notify("80% auto-compaction failed; try /compact. Native overflow protection remains enabled if configured.", "warning");
				} else {
					retryAfter = 0;
					lastCompactedKey = keyFor(ctx);
				}
			}
			finish();
		};
		try {
			ctx.compact({ onComplete: () => complete(false), onError: () => complete(true) });
		} catch {
			complete(true);
		}
		return operation;
	}

	pi.on("session_start", (_event, ctx) => {
		generation++;
		active = true;
		pending = undefined;
		retryAfter = 0;
		lastCompactedKey = undefined;
		void check(ctx);
	});
	pi.on("session_shutdown", () => {
		generation++;
		active = false;
		pending = undefined;
	});
	pi.on("model_select", (_event, ctx) => { void check(ctx); });
	// No await here: do not hold the agent's lifecycle event queue while
	// compaction emits its own lifecycle events.
	pi.on("agent_settled", (_event, ctx) => { void check(ctx); });
	pi.on("input", async (event, ctx) => {
		if (event.streamingBehavior) return;
		// If idle compaction is still running, finish it before accepting input.
		await check(ctx);
	});
	pi.registerCommand("context-policy", {
		description: "Show the model's context window and 80% idle-compaction threshold",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const window = ctx.model?.contextWindow;
			const threshold = window === undefined ? undefined : thresholdForWindow(window);
			ctx.ui.notify(threshold === undefined
				? "No model context window available."
				: `${ctx.model?.id}: ${window} tokens; compact at ~${threshold} (80%) at idle/input boundaries. Auto-compaction ${dependencies.enabled(ctx) ? "enabled" : "disabled"}. Model window is not reduced.`, "info");
		},
	});
}
