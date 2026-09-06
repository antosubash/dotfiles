import { scanShell } from "./shell.ts";

const base = (value: string) => value.split("/").pop() ?? value;
const beforeDoubleDash = (args: string[]) => args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
const option = (args: string[], short: RegExp, long: string[] = []) =>
	beforeDoubleDash(args).some((arg) => /^-[^-\s]+$/.test(arg) && short.test(arg.slice(1)) || long.includes(arg));
const shellNames = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const sqlNames = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlcmd"]);

function skipOptions(words: string[], operands: Set<string>): string[] {
	let i = 0;
	while (i < words.length && words[i].startsWith("-")) {
		if (words[i++] === "--") break;
		if (operands.has(words[i - 1])) i++;
	}
	return words.slice(i);
}

function gitArgs(args: string[]): string[] {
	return skipOptions(args, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]));
}

function readOnlySudo(words: string[]): boolean {
	const [raw, ...args] = words;
	const command = base(raw ?? "");
	if (command === "systemctl") {
		const action = skipOptions(args, new Set(["-H", "--host", "-M", "--machine", "-t", "--type", "--state"]))[0];
		return ["status", "show", "is-active", "is-enabled", "list-units", "list-unit-files", "list-jobs"].includes(action);
	}
	if (command === "journalctl") {
		return !args.some((arg) => /^--(?:vacuum(?:-|=|$)|rotate(?:=|$)|flush(?:=|$)|relinquish-var(?:=|$)|sync(?:=|$)|setup-keys(?:=|$)|update-catalog(?:=|$)|smart-relinquish-var(?:=|$))/.test(arg));
	}
	return command === "docker" && ["ps", "logs", "inspect", "info", "version", "stats", "images"].includes(args[0]);
}

export function destructiveCommandRisks(script: string): string[] {
	const risks = new Set<string>();
	function inspect(text: string, depth = 0): void {
		if (depth > 12) { risks.add("deeply nested shell execution"); return; }
		const scanned = scanShell(text);
		for (const nested of scanned.nested) inspect(nested, depth + 1);
		for (const item of scanned.commands) {
			let words = item.words.slice();
			while (words.length && (/^[A-Za-z_][\w]*=/.test(words[0]) || ["if", "then", "elif", "else", "do", "!", "time"].includes(words[0]))) words.shift();
			// Recognize common execution wrappers without treating their arguments
			// (e.g. grep patterns and log messages) as independent commands.
			for (let i = 0; i < 20 && words.length; i++) {
				const name = base(words[0]);
				if (name === "sudo") {
					words = skipOptions(words.slice(1), new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-T", "--command-timeout"]));
					if (!readOnlySudo(words)) risks.add("privileged command");
				} else if (["command", "builtin", "exec", "nohup"].includes(name)) {
					words = skipOptions(words.slice(1), new Set(name === "exec" ? ["-a"] : []));
				} else if (name === "env") {
					const split = words.findIndex((word) => word === "-S" || word === "--split-string");
					if (split >= 0 && words[split + 1]) inspect(words[split + 1], depth + 1);
					words = skipOptions(words.slice(1), new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]));
					while (words[0] && /^[A-Za-z_][\w]*=/.test(words[0])) words.shift();
				} else if (name === "timeout") {
					words = skipOptions(words.slice(1), new Set(["-s", "--signal", "-k", "--kill-after"])).slice(1);
				} else if (name === "nice") {
					words = skipOptions(words.slice(1), new Set(["-n", "--adjustment"]));
				} else if (name === "xargs") {
					words = skipOptions(words.slice(1), new Set(["-I", "-n", "-P", "-s", "-E", "-L", "-d", "--replace", "--max-args", "--max-procs", "--max-chars", "--eof", "--max-lines", "--delimiter"]));
				} else break;
			}
			const [raw, ...args] = words;
			const name = base(raw ?? "");
			if (beforeDoubleDash(args).includes("--help")) continue;
			if (shellNames.has(name)) {
				const c = args.findIndex((arg) => /^-[^-]*c/.test(arg));
				if (item.pipedFrom && c < 0) risks.add("piped shell execution");
				if (c >= 0 && args[c + 1]) inspect(args[c + 1], depth + 1);
				const hereString = args.indexOf("<<<");
				if (hereString >= 0 && args[hereString + 1]) inspect(args[hereString + 1], depth + 1);
				for (const body of item.heredocs) inspect(body, depth + 1);
			}
			if (name === "eval") inspect(args.join(" "), depth + 1);
			if (name === "trap") inspect(args[args[0] === "--" ? 1 : 0] ?? "", depth + 1);
			if (name === "rm" && option(args, /[rR]/, ["--recursive"])) risks.add("recursive file deletion");
			if (name === "find") {
				for (let i = 0; i < args.length; i++) {
					if (["-name", "-iname", "-path", "-ipath", "-regex", "-iregex"].includes(args[i])) { i++; continue; }
					if (args[i] === "-delete") risks.add("find command deleting files");
					if (args[i] === "-exec" || args[i] === "-execdir") {
						let end = i + 1;
						while (end < args.length && args[end] !== ";" && args[end] !== "+") end++;
						// Requote each argument so literal data is not reinterpreted.
						inspect(args.slice(i + 1, end).map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" "), depth + 1);
						i = end;
					}
				}
			}
			if (name === "git") {
				const [action, ...options] = gitArgs(args);
				if ((action === "reset" && options.includes("--hard")) ||
					(action === "clean" && option(options, /f/, ["--force"]) && !option(options, /n/, ["--dry-run"])) ||
					(action === "checkout" && options.includes("--") && options.indexOf("--") < options.length - 1) ||
					action === "restore") risks.add("discarding Git working-tree or index changes");
				if (action === "push" && (option(options, /f/, ["--force", "--force-with-lease"]) || options.some((arg) => arg.startsWith("--force-with-lease=") || arg.startsWith("+")))) risks.add("force-pushing Git history");
			}
			if (["chmod", "chown"].includes(name) && option(args, /R/, ["--recursive"])) risks.add("recursive ownership or permission change");
			if (/^mkfs(?:\.[a-z0-9]+)?$/.test(name) || ["fdisk", "parted", "shred"].includes(name) || (name === "dd" && args.some((arg) => arg.startsWith("of=")))) risks.add("disk or filesystem overwrite");
			if ((name === "terraform" && (args.includes("destroy") || (args.includes("apply") && args.includes("-destroy")))) ||
				(name === "kubectl" && args.includes("delete")) || (name === "helm" && args.includes("uninstall"))) risks.add("infrastructure destruction");
			if (name === "docker" && ((["system", "volume", "network"].includes(args[0]) && args[1] === "prune") ||
				(args[0] === "rm" && option(args.slice(1), /f/, ["--force"])))) risks.add("broad Docker cleanup");
			if (sqlNames.has(name) && /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i.test([...args, ...item.heredocs].join("\n"))) risks.add("database object or data deletion");
			const forced = args.some((arg) => ["-9", "-KILL", "-SIGKILL", "--signal=KILL", "--signal=SIGKILL", "--signal=9"].includes(arg)) ||
				args.some((arg, i) => ["-s", "--signal"].includes(arg) && ["9", "KILL", "SIGKILL"].includes(args[i + 1]));
			const exactProcess = option(args, /x/, ["--exact"]) && !option(args, /f/, ["--full"]) && /^[A-Za-z0-9_-]+$/.test(args.at(-1) ?? "");
			const processGroup = args.some((arg, i) => arg === "0" || (i > 0 && /^-\d+$/.test(arg)));
			if ((name === "kill" && (forced || processGroup)) || (name === "pkill" && (forced || !exactProcess)) || name === "killall") risks.add("forced or broad process termination");
		}
	}
	inspect(script);
	return [...risks];
}
