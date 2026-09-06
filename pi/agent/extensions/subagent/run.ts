import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { SubagentCapture } from "./capture.ts";
import { TERMINATION_GRACE_MS, TERMINATION_SETTLEMENT_DEADLINE_MS } from "./limits.ts";
import { getPiInvocation, signalProcessTree, writePromptToTempFile } from "./process.ts";
import { getFinalOutput, type SingleResult, type SubagentDetails } from "./results.ts";

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export function buildChildPiArgs(agent: AgentConfig, dispatchDefaults: DispatchDefaults): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	// Keep child extensions (including safety guards), but never expose this
	// extension's tool to a child, regardless of its agent tools configuration.
	args.push("--exclude-tools", "subagent");
	return args;
}

export async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args = buildChildPiArgs(agent, dispatchDefaults);
	const model = agent.model ?? dispatchDefaults.model;

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		let captureLimitExceeded = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				// On POSIX this creates a new process group whose leader is the Pi
				// child. That lets abort/limits terminate descendants holding pipes.
				detached: process.platform !== "win32",
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let settled = false;
			let terminationRequested = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let settlementTimer: ReturnType<typeof setTimeout> | undefined;
			let abortHandler: (() => void) | undefined;
			let terminationForcedFailure = false;
			const treeKillers = new Set<import("node:child_process").ChildProcess>();

			const cleanup = () => {
				if (killTimer) {
					clearTimeout(killTimer);
					killTimer = undefined;
				}
				if (settlementTimer) {
					clearTimeout(settlementTimer);
					settlementTimer = undefined;
				}
				for (const treeKiller of treeKillers) {
					if (!treeKiller.killed) {
						try {
							treeKiller.kill();
						} catch {
							/* the taskkill helper may already have exited */
						}
					}
				}
				treeKillers.clear();
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
			};
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(terminationForcedFailure ? 1 : code);
			};
			const requestTermination = (aborted: boolean) => {
				if (aborted) wasAborted = true;
				if (terminationRequested) return;
				terminationRequested = true;
				// Signal the group/tree even if the leader has emitted `exit`: a
				// descendant can otherwise keep stdout/stderr pipes open.
				const firstKiller = signalProcessTree(proc, "SIGTERM");
				if (firstKiller) treeKillers.add(firstKiller);
				killTimer = setTimeout(() => {
					// `close` waits for inherited stdio to close. If it has not fired,
					// descendants may still hold the pipes even after the group leader
					// emitted `exit`, so escalate against the whole process group/tree.
					if (settled) return;
					const finalKiller = signalProcessTree(proc, "SIGKILL");
					if (finalKiller) treeKillers.add(finalKiller);
				}, TERMINATION_GRACE_MS);
				settlementTimer = setTimeout(() => {
					if (settled) return;
					terminationForcedFailure = true;
					currentResult.stopReason = "error";
					currentResult.errorMessage ||= "Subagent termination did not settle before the hard deadline.";
					// Do not let inherited descriptors keep the parent waiting forever.
					proc.stdout?.destroy();
					proc.stderr?.destroy();
					for (const treeKiller of treeKillers) {
						try {
							treeKiller.kill();
						} catch {
							/* helper may already have exited */
						}
					}
					finish(1);
				}, TERMINATION_SETTLEMENT_DEADLINE_MS);
			};
			const capture = new SubagentCapture(
				(message) => {
					const msg = message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				},
				(text) => { currentResult.stderr += text; },
				(reason) => {
					captureLimitExceeded = true;
					currentResult.stopReason = "error";
					currentResult.errorMessage = reason;
					requestTermination(false);
				},
			);

			proc.stdout.on("data", (data: Buffer) => {
				if (!settled) capture.stdout(data);
			});

			proc.stderr.on("data", (data: Buffer) => {
				if (!settled) capture.stderr(data);
			});

			proc.once("close", (code) => {
				if (!settled) capture.end();
				// A null code means the child did not exit normally (for example, it
				// was terminated by a signal), so it must never be reported as success.
				finish(code ?? 1);
			});

			proc.once("error", () => {
				currentResult.errorMessage ||= "Unable to start the subagent process.";
				requestTermination(false);
				finish(1);
			});

			if (signal) {
				abortHandler = () => requestTermination(true);
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		currentResult.exitCode = captureLimitExceeded ? 1 : exitCode;
		if (captureLimitExceeded) return currentResult;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}
