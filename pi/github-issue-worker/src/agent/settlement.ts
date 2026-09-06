export function createAgentSettlementWatchdog(timeoutMs: number): {
  failure: Promise<never>;
  arm: () => void;
  progress: () => void;
  settled: () => void;
  close: () => void;
} {
  let armed = false;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let rejectFailure: ((error: Error) => void) | undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const reset = () => {
    clear();
    if (!armed || closed) return;
    timer = setTimeout(
      () => rejectFailure?.(new Error("Pi agent made no progress after its terminal agent_end event")),
      timeoutMs,
    );
  };
  return {
    failure,
    arm: () => {
      if (closed) return;
      armed = true;
      reset();
    },
    progress: reset,
    settled: () => {
      armed = false;
      clear();
    },
    close: () => {
      closed = true;
      armed = false;
      clear();
    },
  };
}

export async function awaitAgentPromptCompletion(
  prompt: Promise<void>,
  agentSettled: Promise<void>,
  timeoutMs: number,
  terminalGraceMs = 3_000,
  settlementStall?: Promise<never>,
): Promise<"prompt" | "agent_settled"> {
  let closed = false;
  let hardTimeout: NodeJS.Timeout | undefined;
  let terminalGrace: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    hardTimeout = setTimeout(
      () => reject(new Error(`Pi agent run exceeded ${Math.ceil(timeoutMs / 60_000)} minutes`)),
      timeoutMs,
    );
  });
  const terminal = agentSettled.then(() => {
    if (closed) return new Promise<never>(() => undefined);
    // Once the SDK declares the complete run settled, the run timeout must not race its short
    // prompt-settlement grace period and discard an already-finished final result.
    if (hardTimeout) clearTimeout(hardTimeout);
    return new Promise<"agent_settled">((resolveTerminal) => {
      if (closed) return;
      terminalGrace = setTimeout(() => resolveTerminal("agent_settled"), terminalGraceMs);
    });
  });
  try {
    return await Promise.race([
      prompt.then(() => "prompt" as const),
      terminal,
      timedOut,
      settlementStall ?? new Promise<never>(() => undefined),
    ]);
  } finally {
    closed = true;
    if (hardTimeout) clearTimeout(hardTimeout);
    if (terminalGrace) clearTimeout(terminalGrace);
  }
}

export function extractAssistantText(messages: readonly unknown[]): {
  text: string;
  stopReason: string | undefined;
  error: string | undefined;
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
      stopReason?: string;
      errorMessage?: string;
    };
    if (message.role !== "assistant") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content || [])
            .filter((item) => item.type === "text")
            .map((item) => item.text || "")
            .join("\n");
    return { text, stopReason: message.stopReason, error: message.errorMessage };
  }
  return { text: "", stopReason: undefined, error: undefined };
}
