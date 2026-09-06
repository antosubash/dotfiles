import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { AgentScope } from "./agents.ts";
import type { SubagentParamsType } from "./schema.ts";

export function renderSubagentCall(args: SubagentParamsType, theme: Theme) {
	const scope: AgentScope = args.agentScope ?? "user";
	if (args.chain && args.chain.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `chain (${args.chain.length} steps)`) +
			theme.fg("muted", ` [${scope}]`);
		for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
			const step = args.chain[i];
			// Clean up {previous} placeholder for display
			const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
			const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
			text +=
				"\n  " +
				theme.fg("muted", `${i + 1}.`) +
				" " +
				theme.fg("accent", step.agent) +
				theme.fg("dim", ` ${preview}`);
		}
		if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	if (args.tasks && args.tasks.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
			theme.fg("muted", ` [${scope}]`);
		for (const t of args.tasks.slice(0, 3)) {
			const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
			text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
		}
		if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	const agentName = args.agent || "...";
	const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		theme.fg("muted", ` [${scope}]`);
	text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}
