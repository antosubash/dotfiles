import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import {
	accountIdFromToken, countdown, fetchUsage, formatStatus, parseUsage, POLL_MS, SPARK_MODEL, STALE_MS, USAGE_URL, usageScope, type UsageScope,
} from "../../pi/agent/extensions/usage-status/usage.ts";
import { registerUsageStatus } from "../../pi/agent/extensions/usage-status/index.ts";

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

function harness(loader = async (_scope?: UsageScope) => parseUsage(payload, NOW)) {
	let clock = NOW;
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const statuses: (string | undefined)[] = [];
	let interval: (() => void) | undefined;
	let loads = 0;
	let lastSignal: AbortSignal | undefined;
	const pi = {
		on: (event: string, callback: Function) => handlers.set(event, callback),
		registerCommand: (name: string, command: any) => commands.set(name, command),
	};
	const ctx: any = {
		mode: "tui", hasUI: true, model: { provider: "openai-codex", id: "gpt-6-astra" },
		modelRegistry: { getApiKeyForProvider: async () => token },
		ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			theme: { fg: (_color: string, text: string) => text }, notify: () => {} },
	};
	registerUsageStatus(pi as any, {
		now: () => clock,
		load: async (_getToken, signal, _request, _now, scope) => { loads++; lastSignal = signal; return loader(scope); },
		repeat: ((fn: () => void) => { interval = fn; return { unref() {} }; }) as any,
		cancelRepeat: (() => { interval = undefined; }) as any,
	});
	return {
		ctx, commands, statuses,
		event: (name: string) => handlers.get(name)!({}, ctx),
		tick: (ms = 0) => { clock += ms; interval?.(); },
		get loads() { return loads; },
		get timer() { return interval; },
		get signal() { return lastSignal; },
	};
}

test("no factory side effects or headless/non-Codex polling", async () => {
	const h = harness();
	assert.equal(h.loads, 0);
	assert.equal(h.timer, undefined);
	for (const mode of ["print", "json", "rpc"]) {
		h.ctx.mode = mode;
		h.event("session_start");
		assert.equal(h.loads, 0);
	}
	h.ctx.mode = "tui";
	h.ctx.model.provider = "anthropic";
	h.event("model_select");
	assert.equal(h.timer, undefined);
	assert.equal(h.loads, 0);
});

test("polling throttles, updates idle countdowns, supports forced refresh and cleans up", async () => {
	const h = harness();
	h.event("session_start");
	await flush();
	assert.equal(h.loads, 1);
	assert.match(h.statuses.at(-1)!, /25%/);
	h.tick(15_000);
	h.event("agent_settled");
	assert.equal(h.loads, 1);
	h.tick(POLL_MS);
	await flush();
	assert.equal(h.loads, 2);
	await h.commands.get("usage-refresh").handler("", h.ctx);
	assert.equal(h.loads, 3);
	h.event("session_shutdown");
	assert.equal(h.timer, undefined);
	assert.equal(h.statuses.at(-1), undefined);
	h.tick(POLL_MS);
	assert.equal(h.loads, 3);
	h.event("session_shutdown"); // idempotent
});

test("single-flight fetches and late responses cannot update a replacement session", async () => {
	let finish!: (value: any) => void;
	const h = harness(() => new Promise((resolve) => { finish = resolve; }));
	h.event("session_start");
	h.tick(POLL_MS * 2);
	await h.commands.get("usage-refresh").handler("", h.ctx);
	assert.equal(h.loads, 1);
	h.ctx.model.provider = "anthropic";
	h.event("model_select");
	assert.equal(h.signal?.aborted, true);
	finish(parseUsage(payload, NOW));
	await flush();
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.timer, undefined);
});

test("a hung request times out, releases single-flight state and can be retried", async () => {
	let hang = true;
	const h = harness(() => hang ? new Promise(() => {}) : Promise.resolve(parseUsage(payload, NOW)));
	h.event("session_start");
	await delay(10_100);
	assert.equal(h.signal?.aborted, true);
	assert.match(h.statuses.at(-1)!, /unavailable/);
	hang = false;
	await h.commands.get("usage-refresh").handler("", h.ctx);
	assert.match(h.statuses.at(-1)!, /25%/);
	h.event("session_shutdown");
});

test("session reload isolates old completions from the new runtime", async () => {
	let finish!: (value: any) => void;
	let first = true;
	const h = harness(() => {
		if (first) {
			first = false;
			return new Promise((resolve) => { finish = resolve; });
		}
		return Promise.resolve(parseUsage(payload, NOW));
	});
	h.event("session_start");
	const oldSignal = h.signal;
	h.event("session_shutdown");
	h.event("session_start");
	await flush();
	assert.equal(oldSignal?.aborted, true);
	const expected = h.statuses.at(-1);
	finish({ fetchedAt: NOW, weekly: { usedPercent: 99 } });
	await flush();
	assert.equal(h.statuses.at(-1), expected);
	assert.equal(h.loads, 2);
	h.event("session_shutdown");
});

test("switching Astra → Spark → Astra clears cached quotas and selects the right scope", async () => {
	const h = harness(async (scope) => parseUsage(withSpark, NOW, scope));
	h.event("session_start");
	await flush();
	assert.match(h.statuses.at(-1)!, /^Codex used.*80%/);
	h.ctx.model.id = SPARK_MODEL;
	h.event("model_select");
	assert.match(h.statuses.at(-1)!, /^Spark limits: loading/);
	await flush();
	assert.match(h.statuses.at(-1)!, /^Spark used.*wk.*5%/);
	assert.doesNotMatch(h.statuses.at(-1)!, /80%/);
	h.ctx.model.id = "gpt-6-astra";
	h.event("model_select");
	await flush();
	assert.match(h.statuses.at(-1)!, /^Codex used.*80%/);
	h.event("session_shutdown");
});

test("late main-quota responses cannot overwrite Spark after switching models", async () => {
	let finish!: (value: any) => void;
	const h = harness((scope) => scope === "spark" ? Promise.resolve(parseUsage(withSpark, NOW, scope)) : new Promise((resolve) => { finish = resolve; }));
	h.event("session_start");
	h.ctx.model.id = SPARK_MODEL;
	h.event("model_select");
	await flush();
	finish(parseUsage(withSpark, NOW));
	await flush();
	assert.match(h.statuses.at(-1)!, /^Spark used.*wk.*5%/);
	assert.doesNotMatch(h.statuses.at(-1)!, /80%/);
	h.event("session_shutdown");
});

test("failed refresh keeps a good reading stale, then recovers", async () => {
	let fail = false;
	const h = harness(async () => { if (fail) throw new Error("sensitive internal error"); return parseUsage(payload, NOW); });
	h.event("session_start");
	await flush();
	fail = true;
	h.tick(POLL_MS);
	await flush();
	assert.match(h.statuses.at(-1)!, /25%.*stale/);
	assert.doesNotMatch(h.statuses.at(-1)!, /sensitive/);
	fail = false;
	h.tick(POLL_MS);
	await flush();
	assert.doesNotMatch(h.statuses.at(-1)!, /stale/);
	h.event("session_shutdown");
});
