import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { MAX_CHAIN_STEPS } from "./limits.ts";
import { type DispatchDefaults, type OnUpdateCallback, runSingleAgent } from "./run.ts";
import { getFinalOutput, getResultOutput, isFailedResult, type SingleResult, type SubagentDetails } from "./results.ts";
import type { SubagentParamsType } from "./schema.ts";

export async function runChain(
	chain: SubagentParamsType["chain"] & object,
	ctx: ExtensionContext,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
) {
	if (chain.length > MAX_CHAIN_STEPS) {
		return {
			content: [
				{
					type: "text",
					text: `Too many chain steps (${chain.length}). Max is ${MAX_CHAIN_STEPS}.`,
				},
			],
			details: makeDetails("chain")([]),
			isError: true,
		};
	}

	const results: SingleResult[] = [];
	let previousOutput = "";

	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];
		const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

		// Create update callback that includes all previous results
		const chainUpdate: OnUpdateCallback | undefined = onUpdate
			? (partial) => {
					// Combine completed results with current streaming result
					const currentResult = partial.details?.results[0];
					if (currentResult) {
						const allResults = [...results, currentResult];
						onUpdate({
							content: partial.content,
							details: makeDetails("chain")(allResults),
						});
					}
				}
			: undefined;

		const result = await runSingleAgent(
			ctx.cwd,
			dispatchDefaults,
			agents,
			step.agent,
			taskWithContext,
			step.cwd,
			i + 1,
			signal,
			chainUpdate,
			makeDetails("chain"),
		);
		results.push(result);

		const isError = isFailedResult(result);
		if (isError) {
			const errorMsg = getResultOutput(result);
			return {
				content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
				details: makeDetails("chain")(results),
				isError: true,
			};
		}
		previousOutput = getFinalOutput(result.messages);
	}
	return {
		content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
		details: makeDetails("chain")(results),
	};
}
