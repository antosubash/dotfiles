import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export function signalProcessTree(
	proc: import("node:child_process").ChildProcess,
	signal: "SIGTERM" | "SIGKILL",
): import("node:child_process").ChildProcess | undefined {
	if (proc.pid === undefined) return undefined;

	if (process.platform === "win32") {
		// Windows has no POSIX process groups. taskkill /T is the process-tree
		// equivalent and is safe to invoke without a shell. The direct kill is a
		// fallback for restricted environments where taskkill is unavailable or
		// reports failure (for example, because a descendant already exited).
		const taskkillArgs = ["/PID", String(proc.pid), "/T"];
		if (signal === "SIGKILL") taskkillArgs.push("/F");
		const treeKiller = spawn("taskkill", taskkillArgs, {
			stdio: "ignore",
			windowsHide: true,
		});
		let fallbackUsed = false;
		const fallback = () => {
			if (fallbackUsed) return;
			fallbackUsed = true;
			try {
				proc.kill(signal);
			} catch {
				/* the process may already have exited */
			}
		};
		treeKiller.once("error", fallback);
		treeKiller.once("close", (code) => {
			// A nonzero taskkill result is not proof that the tree was cleaned up.
			// Try the direct handle as a best-effort fallback before the settlement
			// deadline closes the retained pipes and fails the invocation.
			if (code !== 0) fallback();
		});
		return treeKiller;
	}

	try {
		// detached:true below makes the Pi child the process-group leader.
		process.kill(-proc.pid, signal);
	} catch {
		try {
			proc.kill(signal);
		} catch {
			/* the process may already have exited */
		}
	}
	return undefined;
}
