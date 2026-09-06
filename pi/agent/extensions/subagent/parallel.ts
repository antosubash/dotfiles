import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from "./limits.ts";
import { type DispatchDefaults, mapWithConcurrencyLimit, type OnUpdateCallback, runSingleAgent } from "./run.ts";
import { getResultOutput, isFailedResult, type SingleResult, type SubagentDetails, truncateParallelOutput } from "./results.ts";
import type { SubagentParamsType } from "./schema.ts";

export async function runParallel(
	tasks: SubagentParamsType["tasks"] & object,
	ctx: ExtensionContext,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
) {
	if (tasks.length > MAX_PARALLEL_TASKS)
		return {
			content: [
				{
					type: "text",
					text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
				},
			],
			details: makeDetails("parallel")([]),
		};

	// Track all results for streaming updates
	const allResults: SingleResult[] = new Array(tasks.length);

	// Initialize placeholder results
	for (let i = 0; i < tasks.length; i++) {
		allResults[i] = {
			agent: tasks[i].agent,
			agentSource: "unknown",
			task: tasks[i].task,
			exitCode: -1, // -1 = still running
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const emitParallelUpdate = () => {
		if (onUpdate) {
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			onUpdate({
				content: [
					{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
				],
				details: makeDetails("parallel")([...allResults]),
			});
		}
	};

	const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
		const result = await runSingleAgent(
			ctx.cwd,
			dispatchDefaults,
			agents,
			t.agent,
			t.task,
			t.cwd,
			undefined,
			signal,
			// Per-task update callback
			(partial) => {
				if (partial.details?.results[0]) {
					allResults[index] = partial.details.results[0];
					emitParallelUpdate();
				}
			},
			makeDetails("parallel"),
		);
		allResults[index] = result;
		emitParallelUpdate();
		return result;
	});

	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const summaries = results.map((r) => {
		const output = truncateParallelOutput(getResultOutput(r));
		const status = isFailedResult(r)
			? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
			: "completed";
		return `### [${r.agent}] ${status}\n\n${output}`;
	});
	return {
		content: [
			{
				type: "text",
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
			},
		],
		details: makeDetails("parallel")(results),
	};
}
