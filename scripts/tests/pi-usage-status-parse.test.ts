import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
	accountIdFromToken, countdown, fetchUsage, formatStatus, parseUsage, SPARK_MODEL, STALE_MS, USAGE_URL, usageScope,
} from "../../pi/agent/extensions/usage-status/usage.ts";

const NOW = 1_800_000_000_000;
const window = (duration: number, used = 25) => ({
	used_percent: used, limit_window_seconds: duration, reset_at: NOW / 1000 + 3600,
});
const payload = { rate_limit: { primary_window: window(18_000), secondary_window: window(604_800, 80) } };
const withSpark = {
	...payload,
	additional_rate_limits: [{
		limit_name: "GPT-5.3-Codex-Spark", metered_feature: "codex_bengalfox", normal_model_slug: null,
		rate_limit: { primary_window: window(18_000, 0), secondary_window: window(604_800, 5) },
	}],
};
const token = `dummy.${Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.dummy`;
const flush = async () => { await setImmediate(); await setImmediate(); };

// The real account currently returns weekly as primary, and no 5h window.
test("identifies windows by duration, not their primary/secondary positions", () => {
	const normal = parseUsage(payload, NOW);
	assert.equal(normal.fiveHour?.usedPercent, 25);
	assert.equal(normal.weekly?.usedPercent, 80);
	const weeklyOnly = parseUsage({ rate_limit: { primary_window: window(604_800, 11), secondary_window: null } }, NOW);
	assert.equal(weeklyOnly.fiveHour, undefined);
	assert.equal(weeklyOnly.weekly?.usedPercent, 11);
	assert.match(formatStatus(weeklyOnly, NOW, false), /5h n\/a.*wk.*11%/);
	assert.equal(parseUsage({ rate_limit: { primary_window: window(604_800), secondary_window: window(18_000) } }, NOW).fiveHour?.usedPercent, 25);
});

test("rejects missing, non-finite, out-of-range and nonnumeric percentages", () => {
	for (const bad of [undefined, {}, null, [], { rate_limit: {} }, { rate_limit: { primary_window: window(60) } }]) {
		assert.throws(() => parseUsage(bad, NOW));
	}
	for (const bad of [null, "5", -1, 101, NaN, Infinity]) {
		assert.throws(() => parseUsage({ rate_limit: { primary_window: { ...window(18_000), used_percent: bad } } }, NOW));
	}
	for (const pct of [0, 100]) {
		assert.equal(parseUsage({ rate_limit: { primary_window: window(18_000, pct) } }, NOW).fiveHour?.usedPercent, pct);
	}
});

test("does not substitute review or unrelated model-specific limits", () => {
	const result = parseUsage({
		rate_limit: { primary_window: window(604_800, 11) },
		code_review_rate_limit: payload.rate_limit,
		additional_rate_limits: [{ limit_name: "Spark", rate_limit: payload.rate_limit }],
	}, NOW);
	assert.equal(result.fiveHour, undefined);
	assert.equal(result.weekly?.usedPercent, 11);
});

test("selects Spark's own allowance only for the Spark model", () => {
	assert.equal(usageScope(SPARK_MODEL), "spark");
	for (const model of [undefined, "gpt-6-astra", "gpt-5.6-terra", "my-spark-proxy"]) {
		assert.equal(usageScope(model), "codex");
	}
	const spark = parseUsage(withSpark, NOW, "spark");
	assert.equal(spark.fiveHour?.usedPercent, 0);
	assert.equal(spark.weekly?.usedPercent, 5);
	assert.match(formatStatus(spark, NOW, false, undefined, "spark"), /^Spark used.*5h.*0%.*wk.*5%/);
	assert.match(formatStatus(undefined, NOW, false, undefined, "spark"), /^Spark limits: loading/);
	assert.match(formatStatus(undefined, NOW, true, undefined, "spark"), /^Spark limits: unavailable/);
	assert.equal(parseUsage(withSpark, NOW, "codex").weekly?.usedPercent, 80);
});

test("matches supported Spark identifiers without falling back to main or unrelated quotas", () => {
	for (const identifier of [{ normal_model_slug: SPARK_MODEL }, { metered_feature: "codex_bengalfox" }, { limit_name: "GPT-5.3-Codex-Spark" }]) {
		const input = { ...payload, additional_rate_limits: [null, { limit_name: "other", rate_limit: payload.rate_limit }, { ...identifier, rate_limit: payload.rate_limit }] };
		assert.equal(parseUsage(input, NOW, "spark").fiveHour?.usedPercent, 25);
	}
	for (const additional of [undefined, null, {}, [], [{ limit_name: "Other Spark", rate_limit: payload.rate_limit }], [{ limit_name: "GPT-5.3-Codex-Spark", rate_limit: {} }]]) {
		assert.throws(() => parseUsage({ ...payload, additional_rate_limits: additional }, NOW, "spark"));
	}
});

test("fetch selects the requested scope from the shared usage response", async () => {
	const request = (async () => new Response(JSON.stringify(withSpark))) as any;
	const result = await fetchUsage(async () => token, new AbortController().signal, request, () => NOW, "spark");
	assert.equal(result.weekly?.usedPercent, 5);
	assert.equal(result.fiveHour?.usedPercent, 0);
});

test("handles optional/relative reset times and countdown boundaries", () => {
	const w = { ...window(18_000), reset_at: undefined, reset_after_seconds: 120 };
	assert.equal(parseUsage({ rate_limit: { primary_window: w } }, NOW).fiveHour?.resetAt, NOW + 120_000);
	assert.equal(parseUsage({ rate_limit: { primary_window: { ...w, reset_after_seconds: -1 } } }, NOW).fiveHour?.resetAt, undefined);
	assert.equal(countdown(NOW - 1000, NOW), "now");
	assert.equal(countdown(NOW + 1000, NOW), "1m");
	assert.equal(countdown(NOW + 3600_000, NOW), "1h0m");
	assert.equal(countdown(NOW + 26 * 3600_000, NOW), "1d2h");
});

test("renders loading, unavailable, stale and reset-pending states honestly", () => {
	assert.match(formatStatus(undefined, NOW, false), /loading/);
	assert.match(formatStatus(undefined, NOW, true), /unavailable/);
	const sample = parseUsage(payload, NOW);
	assert.match(formatStatus(sample, NOW, false), /Codex used.*5h.*25%.*↻1h0m.*wk.*80%/);
	assert.match(formatStatus(sample, NOW, true), /25%.*stale/);
	assert.match(formatStatus(sample, NOW + STALE_MS, false), /stale/);
	const expired = formatStatus(sample, NOW + 3600_000, false);
	assert.match(expired, /reset pending/);
	assert.doesNotMatch(expired, /0%/);
	const paint = (color: string, text: string) => `<${color}>${text}</${color}>`;
	assert.match(formatStatus(sample, NOW, false, paint), /<success>5h.*<warning>wk/);
	assert.match(formatStatus({ fetchedAt: NOW, fiveHour: { usedPercent: 95 } }, NOW, false, paint), /<error>5h/);
});

test("auth parsing fails closed without exposing the token", () => {
	assert.equal(accountIdFromToken(token), "test-account");
	for (const bad of ["secret", "x.not-json.y", "a.e30.b"]) assert.equal(accountIdFromToken(bad), undefined);
});

test("fetch uses only the fixed usage endpoint, abort signal and no redirects", async () => {
	const controller = new AbortController();
	const request = async (url: unknown, options: any) => {
		assert.equal(url, USAGE_URL);
		assert.equal(options.redirect, "error");
		assert.equal(options.signal, controller.signal);
		assert.equal(options.headers.Authorization, `Bearer ${token}`);
		assert.equal(options.headers["ChatGPT-Account-Id"], "test-account");
		return new Response(JSON.stringify(payload));
	};
	const result = await fetchUsage(async () => token, controller.signal, request as any, () => NOW);
	assert.equal(result.fetchedAt, NOW);
	assert.equal(result.fiveHour?.usedPercent, 25);
});

test("HTTP failures never surface response content; missing auth never requests", async () => {
	for (const status of [401, 429, 500]) {
		await assert.rejects(fetchUsage(async () => token, new AbortController().signal,
			(async () => new Response("secret-body", { status })) as any), { message: "Usage request failed" });
	}
	await assert.rejects(fetchUsage(async () => undefined, new AbortController().signal,
		(async () => { assert.fail("must not fetch"); }) as any), { message: "Codex login required" });
});

test("cancels pending auth and never fetches after it eventually resolves", async () => {
	const controller = new AbortController();
	let finish!: (value: string) => void;
	const auth = new Promise<string>((resolve) => { finish = resolve; });
	const operation = fetchUsage(() => auth, controller.signal, (async () => assert.fail("late fetch")) as any);
	controller.abort();
	await assert.rejects(operation);
	finish(token);
	await flush();
});
