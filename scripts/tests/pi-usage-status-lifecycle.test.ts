import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import {
	parseUsage, POLL_MS, SPARK_MODEL, type UsageScope,
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
