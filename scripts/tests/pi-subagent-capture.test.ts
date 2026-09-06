import assert from "node:assert/strict";
import test from "node:test";
import { CAPTURE_LIMITS, SubagentCapture } from "../../pi/agent/extensions/subagent/capture.ts";

const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const line = (event: unknown) => Buffer.from(JSON.stringify(event) + "\n");
function harness(limits: Partial<typeof CAPTURE_LIMITS> = {}) {
	const messages: any[] = [];
	const errors: string[] = [];
	let stderr = "";
	const capture = new SubagentCapture((msg) => messages.push(msg), (text) => { stderr += text; }, (error) => errors.push(error), limits);
	return { capture, messages, errors, stderr: () => stderr };
}

test("streaming and repeated snapshots above 256 KiB do not consume the transcript budget", () => {
	const h = harness({ retained: 1024 });
	const update = line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(1024) } });
	for (let i = 0; i < 2000; i++) h.capture.stdout(update);
	for (const type of ["message_start", "tool_execution_update", "tool_execution_end", "turn_end", "agent_end"]) {
		h.capture.stdout(line({ type, message: message("x".repeat(128 * 1024)), messages: [message("duplicate")] }));
	}
	h.capture.stdout(line({ type: "message_end", message: message("CAPTURE_OK") }));
	h.capture.end();
	assert.deepEqual(h.errors, []);
	assert.deepEqual(h.messages, [message("CAPTURE_OK")]);
});

test("routine multi-file reads exceeding the old cap retain all completed results", () => {
	const h = harness();
	for (let i = 0; i < 20; i++) {
		h.capture.stdout(line({ type: "message_end", message: { role: "toolResult", toolCallId: String(i), content: [{ type: "text", text: "x".repeat(32 * 1024) }] } }));
	}
	h.capture.stdout(line({ type: "message_end", message: message("READS_OK") }));
	h.capture.end();
	assert.equal(h.messages.length, 21);
	assert.deepEqual(h.messages.at(-1), message("READS_OK"));
	assert.deepEqual(h.errors, []);
});

test("handles every UTF-8 byte boundary and a final line without newline", () => {
	const h = harness();
	const msg = message("café 世界 🦊");
	const data = Buffer.from(JSON.stringify({ type: "message_end", message: msg }));
	for (const byte of data) h.capture.stdout(Buffer.from([byte]));
	h.capture.end();
	h.capture.end();
	assert.deepEqual(h.messages, [msg]);
	assert.deepEqual(h.errors, []);
});

test("handles multiple records per chunk, CRLF, blank, malformed, and unknown events", () => {
	const h = harness();
	h.capture.stdout(Buffer.from('\nnot JSON\r\nnull\n{}\n{"type":"message_end"}\n'));
	h.capture.stdout(Buffer.concat([line({ type: "message_end", message: message("one") }), line({ type: "message_end", message: message("two") })]));
	h.capture.end();
	assert.deepEqual(h.messages, [message("one"), message("two")]);
	assert.deepEqual(h.errors, []);
});

test("legacy tool_result_end remains supported", () => {
	const h = harness();
	const result = { role: "toolResult", content: [{ type: "text", text: "fixture" }] };
	h.capture.stdout(line({ type: "tool_result_end", message: result }));
	assert.deepEqual(h.messages, [result]);
});

test("bounds the total wire stream even if every event is ignored", () => {
	const h = harness({ stdout: 128 });
	for (let i = 0; i < 100; i++) h.capture.stdout(line({ type: "agent_start" }));
	h.capture.stdout(line({ type: "message_end", message: message("must not retain") }));
	h.capture.end();
	assert.equal(h.errors.length, 1);
	assert.match(h.errors[0], /JSON event stream limit exceeded \(128 bytes/);
	assert.deepEqual(h.messages, []);
});

test("bounds unterminated lines before retaining them, including across chunks", () => {
	const h = harness({ line: 32 });
	h.capture.stdout(Buffer.alloc(32, 120));
	assert.deepEqual(h.errors, []);
	h.capture.stdout(Buffer.from("x"));
	assert.equal(h.errors.length, 1);
	assert.match(h.errors[0], /JSON event line limit exceeded \(32 bytes/);
});

test("line limit applies per record, not per large multi-record data chunk", () => {
	const h = harness({ line: 32 });
	h.capture.stdout(Buffer.from('{"type":"agent_start"}\n'.repeat(100)));
	assert.deepEqual(h.errors, []);
});

test("line limit counts UTF-8 bytes, not characters", () => {
	const h = harness({ line: 4 });
	h.capture.stdout(Buffer.from("🦊"));
	assert.deepEqual(h.errors, []);
	h.capture.stdout(Buffer.from("a"));
	assert.match(h.errors[0], /JSON event line/);
});

test("retained messages use a distinct finite budget with exact boundary behavior", () => {
	const msg = message("fits exactly");
	const bytes = Buffer.byteLength(JSON.stringify(msg));
	const h = harness({ retained: bytes });
	h.capture.stdout(line({ type: "message_end", message: msg }));
	assert.deepEqual(h.errors, []);
	assert.deepEqual(h.messages, [msg]);
	h.capture.stdout(line({ type: "message_end", message: message("too much") }));
	assert.match(h.errors[0], /retained transcript limit exceeded/);
	assert.equal(h.messages.length, 1);
});

test("oversized retained message is rejected without invoking the message callback", () => {
	const h = harness({ retained: 32 });
	h.capture.stdout(line({ type: "message_end", message: message("too large") }));
	assert.match(h.errors[0], /retained transcript/);
	assert.deepEqual(h.messages, []);
});

test("stderr has its own budget and preserves split UTF-8", () => {
	const h = harness({ stdout: 32, stderr: 12 });
	for (const byte of Buffer.from("hello 🦊")) h.capture.stderr(Buffer.from([byte]));
	h.capture.stdout(line({ type: "agent_start" }));
	h.capture.end();
	assert.equal(h.stderr(), "hello 🦊");
	assert.deepEqual(h.errors, []);
});

test("stderr flood trips exactly once and ignores later output", () => {
	const h = harness({ stderr: 16 });
	h.capture.stderr(Buffer.from("diagnostic"));
	h.capture.stderr(Buffer.alloc(32, 120));
	h.capture.stderr(Buffer.alloc(32, 120));
	h.capture.stdout(line({ type: "message_end", message: message("late") }));
	h.capture.end();
	assert.equal(h.stderr(), "diagnostic");
	assert.equal(h.errors.length, 1);
	assert.match(h.errors[0], /stderr limit exceeded \(16 bytes/);
	assert.deepEqual(h.messages, []);
});

test("ignores writes after end", () => {
	const h = harness();
	h.capture.end();
	h.capture.stdout(line({ type: "message_end", message: message("late") }));
	h.capture.stderr(Buffer.from("late"));
	assert.deepEqual(h.messages, []);
	assert.equal(h.stderr(), "");
});

test("rejects invalid budgets", () => {
	for (const stdout of [0, -1, Infinity, NaN, 1.5]) assert.throws(() => harness({ stdout }), /positive safe integers/);
});
