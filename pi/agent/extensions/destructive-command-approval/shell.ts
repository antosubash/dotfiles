// A small shell-aware scanner for a best-effort approval prompt, NOT a shell
// interpreter or security boundary. It separates commands from quoted data and
// comments, and inspects explicit shell payloads/substitutions separately.
export interface ShellCommand {
	words: string[];
	heredocs: string[];
	pipedFrom?: ShellCommand;
}

export interface ShellScan {
	commands: ShellCommand[];
	nested: string[];
}

function substitutionEnd(text: string, start: number): number {
	let depth = 1;
	let quote = "";
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (c === "\\" && quote !== "'") { i++; continue; }
		if (quote) {
			if (c === quote) quote = "";
			continue;
		}
		if (c === "'" || c === '"') { quote = c; continue; }
		if (c === "(") depth++;
		if (c === ")" && --depth === 0) return i;
	}
	return text.length;
}

function heredocSubstitutions(text: string): string[] {
	const scripts: string[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\\") { i++; continue; }
		if (text[i] === "$" && text[i + 1] === "(") {
			const end = substitutionEnd(text, i + 2);
			scripts.push(text.slice(i + 2, end));
			i = end;
		} else if (text[i] === "`") {
			const end = text.indexOf("`", i + 1);
			if (end < 0) break;
			scripts.push(text.slice(i + 1, end));
			i = end;
		}
	}
	return scripts;
}

export function scanShell(text: string): ShellScan {
	const result: ShellScan = { commands: [], nested: [] };
	let current: ShellCommand = { words: [], heredocs: [] };
	let word = "";
	let started = false;
	let quoted = false;
	let quote = "";
	let delimiter: { tabs: boolean } | undefined;
	const documents: { marker: string; tabs: boolean; quoted: boolean; owner: ShellCommand }[] = [];
	const pushWord = () => {
		if (!started) return;
		if (delimiter) {
			documents.push({ marker: word, tabs: delimiter.tabs, quoted, owner: current });
			delimiter = undefined;
		} else current.words.push(word);
		word = "";
		started = false;
		quoted = false;
	};
	const pushCommand = () => {
		pushWord();
		if (current.words.length) result.commands.push(current);
		current = { words: [], heredocs: [] };
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote === "'") {
			if (c === "'") quote = "";
			else word += c;
			continue;
		}
		if (c === "\\" && i + 1 < text.length) {
			quoted = true;
			const next = text[++i];
			if (next !== "\n") { word += next; started = true; }
			continue;
		}
		if (c === "$" && text[i + 1] === "(") {
			const end = substitutionEnd(text, i + 2);
			result.nested.push(text.slice(i + 2, end));
			word += text.slice(i, Math.min(end + 1, text.length));
			started = true;
			i = end;
			continue;
		}
		if (c === "`") {
			let end = i + 1;
			while (end < text.length && text[end] !== "`") {
				if (text[end] === "\\") end++;
				end++;
			}
			result.nested.push(text.slice(i + 1, end));
			word += text.slice(i, Math.min(end + 1, text.length));
			started = true;
			i = end;
			continue;
		}
		if (quote === '"') {
			if (c === '"') quote = "";
			else word += c;
			continue;
		}
		if (c === "'" || c === '"') { quote = c; quoted = true; started = true; continue; }
		if (c === "#" && !started) {
			while (i + 1 < text.length && text[i + 1] !== "\n") i++;
			continue;
		}
		if (text.slice(i, i + 3) === "<<<") {
			pushWord();
			current.words.push("<<<");
			i += 2;
			continue;
		}
		if (c === "<" && text[i + 1] === "<") {
			pushWord();
			delimiter = { tabs: text[i + 2] === "-" };
			i += delimiter.tabs ? 2 : 1;
			continue;
		}
		if (c === "\n") {
			const continuation = !started && current.words.length === 0 ? current.pipedFrom : undefined;
			pushCommand();
			if (continuation) current.pipedFrom = continuation;
			for (const doc of documents.splice(0)) {
				const lines: string[] = [];
				while (i + 1 < text.length) {
					let end = text.indexOf("\n", i + 1);
					if (end < 0) end = text.length;
					const line = text.slice(i + 1, end);
					i = end;
					if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.marker) break;
					lines.push(line);
				}
				const body = lines.join("\n");
				doc.owner.heredocs.push(body);
				if (!doc.quoted) result.nested.push(...heredocSubstitutions(body));
			}
			continue;
		}
		if (c === "|" && text[i + 1] !== "|" && text[i - 1] !== "|") {
			const source = current;
			pushCommand();
			current.pipedFrom = source;
			if (text[i + 1] === "&") i++;
			continue;
		}
		if (";|&()".includes(c) || ((c === "{" || c === "}") && !started && /\s|$/.test(text[i + 1] ?? ""))) {
			pushCommand();
			continue;
		}
		if (/\s/.test(c)) { pushWord(); continue; }
		word += c;
		started = true;
	}
	pushCommand();
	return result;
}
