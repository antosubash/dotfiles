import { StringDecoder } from "node:string_decoder";

// JSON transport contains deltas and repeated turn/agent snapshots. It must not
// share the much smaller budget for results actually retained by the parent.
export const CAPTURE_LIMITS = Object.freeze({
	stdout: 64 * 1024 * 1024,
	line: 16 * 1024 * 1024,
	retained: 8 * 1024 * 1024,
	stderr: 256 * 1024,
});

type CaptureLimits = typeof CAPTURE_LIMITS;
type CapturedMessage = { role: string; [key: string]: any };

export class SubagentCapture {
	private readonly limits: CaptureLimits;
	private stdoutBytes = 0;
	private stderrBytes = 0;
	private retainedBytes = 0;
	private lineBytes = 0;
	private line = "";
	private stdoutDecoder = new StringDecoder("utf8");
	private stderrDecoder = new StringDecoder("utf8");
	private failed = false;
	private ended = false;

	private readonly onMessage: (message: CapturedMessage) => void;
	private readonly onStderr: (text: string) => void;
	private readonly onLimit: (reason: string) => void;

	constructor(
		onMessage: (message: CapturedMessage) => void,
		onStderr: (text: string) => void,
		onLimit: (reason: string) => void,
		limits: Partial<CaptureLimits> = {},
	) {
		this.onMessage = onMessage;
		this.onStderr = onStderr;
		this.onLimit = onLimit;
		this.limits = { ...CAPTURE_LIMITS, ...limits };
		for (const value of Object.values(this.limits)) {
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Capture limits must be positive safe integers");
		}
	}

	private fail(kind: keyof CaptureLimits): void {
		if (this.failed) return;
		this.failed = true;
		this.line = "";
		const names = { stdout: "JSON event stream", line: "JSON event line", retained: "retained transcript", stderr: "stderr" };
		this.onLimit(`Subagent ${names[kind]} limit exceeded (${this.limits[kind]} bytes maximum). Narrow the task or reduce verbose tool output.`);
	}

	private processLine(line: string): void {
		if (this.failed || !line.trim()) return;
		let event: any;
		try { event = JSON.parse(line); } catch { return; }
		// message_end is authoritative. Updates, tool_execution_end, turn_end,
		// and agent_end duplicate content and are deliberately not retained.
		// Keep the older example's tool_result_end compatibility as well.
		if (event?.type !== "message_end" && event?.type !== "tool_result_end") return;
		const message = event.message;
		if (!message || typeof message !== "object" || typeof message.role !== "string") return;
		const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
		if (this.retainedBytes + bytes > this.limits.retained) { this.fail("retained"); return; }
		this.retainedBytes += bytes;
		this.onMessage(message);
	}

	stdout(data: Buffer): void {
		if (this.failed || this.ended) return;
		if (this.stdoutBytes + data.byteLength > this.limits.stdout) { this.fail("stdout"); return; }
		this.stdoutBytes += data.byteLength;
		let start = 0;
		while (start < data.length && !this.failed) {
			const newline = data.indexOf(10, start);
			const end = newline < 0 ? data.length : newline;
			const part = data.subarray(start, end);
			// Bound an unterminated or oversized line BEFORE decoding/retaining it.
			if (this.lineBytes + part.byteLength > this.limits.line) { this.fail("line"); return; }
			this.lineBytes += part.byteLength;
			this.line += this.stdoutDecoder.write(part);
			if (newline < 0) break;
			const line = this.line + this.stdoutDecoder.end();
			this.line = "";
			this.lineBytes = 0;
			this.stdoutDecoder = new StringDecoder("utf8");
			this.processLine(line);
			start = newline + 1;
		}
	}

	stderr(data: Buffer): void {
		if (this.failed || this.ended) return;
		if (this.stderrBytes + data.byteLength > this.limits.stderr) { this.fail("stderr"); return; }
		this.stderrBytes += data.byteLength;
		this.onStderr(this.stderrDecoder.write(data));
	}

	end(): void {
		if (this.failed || this.ended) return;
		this.ended = true;
		this.processLine(this.line + this.stdoutDecoder.end());
		this.line = "";
		this.lineBytes = 0;
		this.onStderr(this.stderrDecoder.end());
	}
}
