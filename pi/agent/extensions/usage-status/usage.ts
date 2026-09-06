// ChatGPT subscription limits, not token/context usage or API billing quotas.
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const POLL_MS = 60_000;
export const STALE_MS = 5 * POLL_MS;
export const SPARK_MODEL = "gpt-5.3-codex-spark";
export type UsageScope = "codex" | "spark";
export const usageScope = (modelId: string | undefined): UsageScope => modelId === SPARK_MODEL ? "spark" : "codex";

export interface UsageWindow {
	usedPercent: number;
	resetAt?: number; // Unix milliseconds
}

export interface UsageSnapshot {
	fiveHour?: UsageWindow;
	weekly?: UsageWindow;
	fetchedAt: number;
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function parseUsage(payload: unknown, now = Date.now(), scope: UsageScope = "codex"): UsageSnapshot {
	const data = object(payload);
	const additional = Array.isArray(data?.additional_rate_limits) ? data.additional_rate_limits : [];
	const spark = additional.map(object).find((entry) => entry && (
		entry.normal_model_slug === SPARK_MODEL ||
		entry.metered_feature === "codex_bengalfox" ||
		entry.limit_name === "GPT-5.3-Codex-Spark"
	));
	// Never fall back to the main allowance when Spark's separate quota is absent.
	const rate = object(scope === "spark" ? spark?.rate_limit : data?.rate_limit);
	if (!rate) throw new Error("Usage data unavailable");
	const result: UsageSnapshot = { fetchedAt: now };
	for (const raw of [rate.primary_window, rate.secondary_window]) {
		const window = object(raw);
		if (!window || !finite(window.used_percent) || window.used_percent < 0 || window.used_percent > 100) continue;
		const duration = window.limit_window_seconds;
		// Primary is not always 5h: some subscriptions only return a weekly primary.
		if (duration !== 18_000 && duration !== 604_800) continue;
		const resetAt = finite(window.reset_at) && window.reset_at > 0
			? window.reset_at * 1000
			: finite(window.reset_after_seconds) && window.reset_after_seconds >= 0
				? now + window.reset_after_seconds * 1000 : undefined;
		result[duration === 18_000 ? "fiveHour" : "weekly"] = { usedPercent: window.used_percent, resetAt };
	}
	if (!result.fiveHour && !result.weekly) throw new Error("Usage windows unavailable");
	return result;
}

export function accountIdFromToken(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = object(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
		const id = object(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
		return typeof id === "string" && /^[\w-]+$/.test(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

// Registry auth resolution has no signal argument. Stop waiting on cancellation,
// and check the signal again before sending any request if auth finishes later.
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Usage request cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		if (signal.aborted) abort();
	});
}

export async function fetchUsage(
	getToken: () => Promise<string | undefined>,
	signal: AbortSignal,
	request: typeof fetch = fetch,
	now: () => number = Date.now,
	scope: UsageScope = "codex",
): Promise<UsageSnapshot> {
	signal.throwIfAborted();
	const token = await abortable(getToken(), signal);
	signal.throwIfAborted();
	const accountId = token && accountIdFromToken(token);
	if (!token || !accountId) throw new Error("Codex login required");
	const response = await request(USAGE_URL, {
		headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId, Accept: "application/json" },
		signal,
		redirect: "error", // Never forward credentials to a redirect target.
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error("Usage request failed"); // Never expose response bodies or credentials.
	}
	return parseUsage(await response.json(), now(), scope);
}

export function countdown(resetAt: number, now: number): string {
	const minutes = Math.ceil((resetAt - now) / 60_000);
	if (minutes <= 0) return "now";
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor(minutes / 60) % 24;
	if (days) return `${days}d${hours}h`;
	if (hours) return `${hours}h${minutes % 60}m`;
	return `${minutes}m`;
}

type Color = "dim" | "success" | "warning" | "error";
export type Paint = (color: Color, text: string) => string;

export function formatStatus(
	snapshot: UsageSnapshot | undefined,
	now: number,
	failed: boolean,
	paint: Paint = (_color, text) => text,
	scope: UsageScope = "codex",
): string {
	const name = scope === "spark" ? "Spark" : "Codex";
	if (!snapshot) return `${name} limits: ${failed ? "unavailable" : "loading…"}`;
	const stale = failed || now - snapshot.fetchedAt >= STALE_MS;
	const parts = [paint("dim", `${name} used`)];
	for (const [label, window] of [["5h", snapshot.fiveHour], ["wk", snapshot.weekly]] as const) {
		if (!window) {
			parts.push(paint("dim", `${label} n/a`));
			continue;
		}
		const expired = window.resetAt !== undefined && window.resetAt <= now;
		// A passed reset does not prove that the allowance is now unused.
		if (expired) {
			parts.push(paint("warning", `${label} reset pending`));
			continue;
		}
		const color = stale ? "dim" : window.usedPercent >= 90 ? "error" : window.usedPercent >= 70 ? "warning" : "success";
		const filled = Math.round(window.usedPercent / 20);
		const bar = "█".repeat(filled) + "░".repeat(5 - filled);
		const reset = window.resetAt === undefined ? "" : ` ↻${countdown(window.resetAt, now)}`;
		parts.push(paint(color, `${label} ${bar} ${Math.round(window.usedPercent)}%`) + paint("dim", reset));
	}
	if (stale) parts.push(paint("warning", "stale"));
	return parts.join(paint("dim", " · "));
}
