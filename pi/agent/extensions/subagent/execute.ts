import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { runChain } from "./chain.ts";
import { runParallel } from "./parallel.ts";
import { type DispatchDefaults, type OnUpdateCallback, runSingleAgent } from "./run.ts";
import { getFinalOutput, getResultOutput, isFailedResult, type SingleResult, type SubagentDetails } from "./results.ts";
import type { SubagentParamsType } from "./schema.ts";

export async function executeSubagent(
	params: SubagentParamsType,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	ctx: ExtensionContext,
) {
	const agentScope: AgentScope = params.agentScope ?? "user";
	const dispatchDefaults: DispatchDefaults = {
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinkingLevel: ctx.thinkingLevel,
	};
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;
	const confirmProjectAgents = params.confirmProjectAgents ?? true;

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

	const makeDetails =
		(mode: "single" | "parallel" | "chain") =>
		(results: SingleResult[]): SubagentDetails => ({
			mode,
			agentScope,
			projectAgentsDir: discovery.projectAgentsDir,
			results,
		});

	if (modeCount !== 1) {
		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			content: [
				{
					type: "text",
					text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
				},
			],
			details: makeDetails("single")([]),
		};
	}

	if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents) {
		const requestedAgentNames = new Set<string>();
		if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
		if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
		if (params.agent) requestedAgentNames.add(params.agent);

		const projectAgentsRequested = Array.from(requestedAgentNames)
			.map((name) => agents.find((a) => a.name === name))
			.filter((a): a is AgentConfig => a?.source === "project");

		if (projectAgentsRequested.length > 0) {
			const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const names = projectAgentsRequested.map((a) => a.name).join(", ");
			const dir = discovery.projectAgentsDir ?? "(unknown)";
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: `Blocked: project-local agents require interactive confirmation (requested: ${names}; source: ${dir}).`,
						},
					],
					details: makeDetails(mode)([]),
					isError: true,
				};
			}

			const ok = await ctx.ui.confirm(
				"Run project-local agents?",
				`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
			);
			if (!ok)
				return {
					content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
					details: makeDetails(mode)([]),
				};
		}
	}

	if (params.chain && params.chain.length > 0) {
		return runChain(params.chain, ctx, dispatchDefaults, agents, signal, onUpdate, makeDetails);
	}

	if (params.tasks && params.tasks.length > 0) {
		return runParallel(params.tasks, ctx, dispatchDefaults, agents, signal, onUpdate, makeDetails);
	}

	if (params.agent && params.task) {
		const result = await runSingleAgent(
			ctx.cwd,
			dispatchDefaults,
			agents,
			params.agent,
			params.task,
			params.cwd,
			undefined,
			signal,
			onUpdate,
			makeDetails("single"),
		);
		const isError = isFailedResult(result);
		if (isError) {
			const errorMsg = getResultOutput(result);
			return {
				content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
				details: makeDetails("single")([result]),
				isError: true,
			};
		}
		return {
			content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
			details: makeDetails("single")([result]),
		};
	}

	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	return {
		content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
		details: makeDetails("single")([]),
	};
}
