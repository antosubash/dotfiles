// Fake Pi JSON child for offline subprocess tests. Never calls a model/provider.
import { once } from "node:events";

const task = process.argv.at(-1) ?? "";
async function emit(event) {
	if (!process.stdout.write(JSON.stringify(event) + "\n")) await once(process.stdout, "drain");
}
if (task.includes("stderr-overflow")) {
	process.stderr.write("x".repeat(512 * 1024));
	setInterval(() => {}, 1000); // Parent must terminate this process on overflow.
} else if (task.includes("abort-fixture")) {
	setInterval(() => {}, 1000);
} else {
	const messages = [];
	for (let i = 0; i < 20; i++) {
		await emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(16 * 1024) } });
		const message = { role: "toolResult", toolCallId: String(i), content: [{ type: "text", text: "x".repeat(32 * 1024) }] };
		messages.push(message);
		await emit({ type: "message_end", message });
		await emit({ type: "tool_execution_end", result: message });
	}
	const message = {
		role: "assistant", content: [{ type: "text", text: "SUBAGENT_CAPTURE_OK 🦊" }],
		stopReason: "stop", model: "fixture",
		usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0 } },
	};
	messages.push(message);
	await emit({ type: "message_end", message });
	await emit({ type: "turn_end", message });
	await emit({ type: "agent_end", messages });
}
