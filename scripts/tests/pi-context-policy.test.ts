import assert from "node:assert/strict";
import test from "node:test";
import { registerContextPolicy, thresholdForWindow } from "../../pi/agent/extensions/context-policy/policy.ts";

function harness() {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const operations: any[] = [];
	const notices: string[] = [];
	let now = 0;
	let enabled = true;
	let idle = true;
	let queued = false;
	let leaf = "entry-1";
	let usage: any = { tokens: 200_000, contextWindow: 272_000 };
	const model = { id: "gpt-6-astra", provider: "openai-codex", contextWindow: 272_000 };
	const ctx: any = {
		model, hasUI: true,
		getContextUsage: () => usage,
		isIdle: () => idle,
		hasPendingMessages: () => queued,
		sessionManager: { getLeafId: () => leaf },
		compact: (options: any) => { operations.push(options); idle = false; },
		abort: () => assert.fail("must not interrupt an active run"),
		ui: { notify: (message: string) => notices.push(message) },
	};
	registerContextPolicy({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
	} as any, { enabled: () => enabled, now: () => now });
	return {
		ctx, handlers, commands, operations, notices, model,
		event: (name: string, data = {}) => handlers.get(name)?.(data, ctx),
		setUsage: (tokens: any, window = model.contextWindow) => { usage = { tokens, contextWindow: window }; },
		setMissingUsage: () => { usage = undefined; },
		setIdle: (value: boolean) => { idle = value; },
		setQueued: (value: boolean) => { queued = value; },
		setEnabled: (value: boolean) => { enabled = value; },
		advance: (ms: number) => { now += ms; },
		complete: (tokens = 20_000) => {
			leaf += "-compacted";
			usage.tokens = tokens;
			idle = true;
			operations.at(-1).onComplete();
		},
		fail: () => { idle = true; operations.at(-1).onError(new Error("failure")); },
	};
}

test("80% thresholds use each model's registered full window", () => {
	assert.equal(thresholdForWindow(272_000), 217_600);
	assert.equal(thresholdForWindow(128_000), 102_400);
	assert.equal(thresholdForWindow(1_050_000), 840_000);
	for (const bad of [0, -1, NaN, Infinity]) assert.equal(thresholdForWindow(bad), undefined);
});

test("does nothing on factory load, below 80%, or with unknown usage", () => {
	const h = harness();
	assert.equal(h.operations.length, 0);
	h.event("session_start");
	h.setUsage(217_599);
	h.event("agent_settled");
	for (const tokens of [null, undefined, NaN, Infinity]) {
		h.setUsage(tokens);
		h.event("agent_settled");
	}
	h.setMissingUsage();
	h.event("agent_settled");
	assert.equal(h.operations.length, 0);
});

test("compacts at 80% on a safe boundary without modifying model capacity", () => {
	const h = harness();
	h.event("session_start");
	h.setUsage(217_600);
	h.event("agent_settled");
	assert.equal(h.operations.length, 1);
	assert.equal(h.model.contextWindow, 272_000);
	h.complete();
	h.event("agent_settled");
	assert.equal(h.operations.length, 1);
});

test("startup of an already-full idle session triggers compaction", () => {
	const h = harness();
	h.setUsage(250_000);
	h.event("session_start");
	assert.equal(h.operations.length, 1);
	h.complete();
});

test("input waits for compaction to finish instead of racing a new prompt", async () => {
	const h = harness();
	h.event("session_start");
	h.setUsage(220_000);
	let resumed = false;
	const input = h.event("input", { source: "interactive" }).then(() => { resumed = true; });
	await Promise.resolve();
	assert.equal(resumed, false);
	assert.equal(h.operations.length, 1);
	h.event("agent_settled");
	assert.equal(h.operations.length, 1);
	h.complete();
	await input;
	assert.equal(resumed, true);
});

test("active runs, steering, queued follow-ups and disabled compaction are left alone", async () => {
	const h = harness();
	h.event("session_start");
	h.setUsage(250_000);
	h.setIdle(false);
	h.event("agent_settled");
	await h.event("input", { streamingBehavior: "steer" });
	assert.equal(h.operations.length, 0);
	h.setIdle(true);
	h.setQueued(true);
	h.event("agent_settled");
	assert.equal(h.operations.length, 0);
	h.setQueued(false);
	h.setEnabled(false);
	await h.event("input");
	assert.equal(h.operations.length, 0);
	assert.equal(h.handlers.has("turn_end"), false);
});

test("switching to Spark recalculates the threshold instead of retaining Astra's budget", () => {
	const h = harness();
	h.setUsage(110_000);
	h.event("session_start");
	assert.equal(h.operations.length, 0);
	h.model.id = "gpt-5.3-codex-spark";
	h.model.contextWindow = 128_000;
	h.setUsage(110_000, 128_000);
	h.event("model_select");
	assert.equal(h.operations.length, 1);
	h.complete();
	assert.equal(h.model.contextWindow, 128_000);
});

test("does not loop when compaction leaves an unchanged checkpoint above threshold", () => {
	const h = harness();
	h.setUsage(220_000);
	h.event("session_start");
	h.complete(218_000);
	h.event("agent_settled");
	assert.equal(h.operations.length, 1);
	h.setUsage(20_000);
	h.event("agent_settled");
	h.setUsage(220_000);
	h.event("agent_settled");
	assert.equal(h.operations.length, 2);
	h.complete();
});

test("failed compactions release waiting input and apply a retry cooldown", async () => {
	const h = harness();
	h.event("session_start");
	h.setUsage(220_000);
	const input = h.event("input");
	h.fail();
	await input;
	assert.equal(h.notices.length, 1);
	await h.event("input");
	assert.equal(h.operations.length, 1);
	h.advance(60_001);
	h.event("agent_settled");
	assert.equal(h.operations.length, 2);
	h.complete();
});

test("shutdown and reload isolate old callbacks from new session state", () => {
	const h = harness();
	h.setUsage(220_000);
	h.event("session_start");
	const old = h.operations[0];
	h.event("session_shutdown");
	h.setIdle(true);
	h.event("agent_settled");
	assert.equal(h.operations.length, 1);
	h.event("session_start");
	assert.equal(h.operations.length, 2);
	old.onError();
	assert.equal(h.notices.length, 0);
	h.complete();
});

test("policy inspection reports capacity and threshold without causing compaction", async () => {
	const h = harness();
	await h.commands.get("context-policy").handler("", h.ctx);
	assert.match(h.notices.at(-1)!, /272000.*217600.*80%.*idle\/input/);
	assert.equal(h.operations.length, 0);
});
