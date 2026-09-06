#!/usr/bin/env bash
# Runtime smoke checks for the vendored Pi extension and agent discovery.
# Pi is optional on machines that only use the shell dotfiles, so absence is a
# successful skip rather than a failed test.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if ! command -v pi >/dev/null 2>&1; then
    printf 'SKIP: pi is not installed\n'
    exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PROJECT="$TMP/project"
PI_HOME="$TMP/pi-home"
MARKER="$TMP/runtime-marker"
mkdir -p "$PROJECT/.pi/agents" "$PI_HOME"
cp "$ROOT/pi/agent/agents/scout.md" "$PROJECT/.pi/agents/scout.md"
cat > "$PROJECT/.pi/agents/runtime-fable.md" <<'EOF'
---
name: runtime-fable
description: Fable alias fixture
model: fable
---
A fixture for preserving GPT-6 as the Fable substitute.
EOF
cat > "$PROJECT/.pi/agents/runtime-alias.md" <<'EOF'
---
name: runtime-alias
description: runtime alias fixture
model: claude-haiku-4-5
tools: read, grep
---
A fixture used only to verify Pi's agent discovery path.
EOF

# This probe executes during Pi extension loading. It checks the same runtime
# discovery and non-interactive project-agent gate without making a provider
# request. Fake JSON children exercise capture and termination without models.
cat > "$TMP/probe.ts" <<EOF
import * as fs from "node:fs";
import assert from "node:assert/strict";
import { discoverAgents } from "${ROOT}/pi/agent/extensions/subagent/agents.ts";
import subagentExtension, { buildChildPiArgs, MAX_CHAIN_STEPS, runSingleAgent } from "${ROOT}/pi/agent/extensions/subagent/index.ts";
import approvalExtension, { destructiveCommandRisks } from "${ROOT}/pi/agent/extensions/destructive-command-approval.ts";

export default async function () {
  const found = discoverAgents(process.cwd(), "project").agents.find((agent) => agent.name === "runtime-alias");
  if (!found || found.model !== "openai-codex/gpt-5.6-luna" || found.tools?.join(",") !== "read,grep") {
    throw new Error("agent alias/tool discovery failed");
  }

  const agents = discoverAgents(process.cwd(), "project").agents;
  if (agents.find((agent) => agent.name === "scout")?.model !== "openai-codex/gpt-5.3-codex-spark") {
    throw new Error("scout must use Spark");
  }
  if (agents.find((agent) => agent.name === "runtime-fable")?.model !== "openai-codex/gpt-6-astra") {
    throw new Error("Fable must retain GPT-6 Astra");
  }
  const settings = JSON.parse(fs.readFileSync("${ROOT}/pi/agent/settings.json", "utf8"));
  if (settings.defaultModel !== "gpt-6-astra" || !settings.enabledModels.includes("openai-codex/gpt-5.3-codex-spark:medium")) {
    throw new Error("Spark enablement or GPT-6 default regressed");
  }

  if (destructiveCommandRisks("rm -f /tmp/stale-log").length !== 0) {
    throw new Error("routine forced cleanup should not prompt");
  }
  if (!destructiveCommandRisks("rm -rf build").includes("recursive file deletion")) {
    throw new Error("recursive deletion approval guard regressed");
  }

  if (destructiveCommandRisks("rg 'rm -rf|sudo' scripts").length !== 0) {
    throw new Error("read-only search should not prompt");
  }
  let approvalHandler: any;
  approvalExtension({ on(_name: string, handler: any) { approvalHandler = handler; } } as any);
  const riskEvent = { type: "tool_call", toolName: "bash", input: { command: "git reset --hard" } };
  const safeEvent = { ...riskEvent, input: { command: "sudo systemctl status example" } };
  if (await approvalHandler(safeEvent, { hasUI: false })) throw new Error("routine command blocked headlessly");
  if (!(await approvalHandler(riskEvent, { hasUI: false }))?.block) throw new Error("headless destructive command was not blocked");
  if (!(await approvalHandler(riskEvent, { hasUI: true, ui: { confirm: async () => false } }))?.block) throw new Error("rejected destructive command was not blocked");
  if (await approvalHandler(riskEvent, { hasUI: true, ui: { confirm: async () => true } })) throw new Error("approved command blocked");

  const baseAgent: any = {
    name: "runtime-agent",
    description: "runtime fixture",
    systemPrompt: "",
    source: "user",
    filePath: "",
  };
  const unrestrictedChildArgs = buildChildPiArgs(baseAgent, {});
  const explicitlyRequestedChildArgs = buildChildPiArgs(
    { ...baseAgent, tools: ["read", "subagent"] },
    {},
  );
  for (const childArgs of [unrestrictedChildArgs, explicitlyRequestedChildArgs]) {
    const exclusionIndex = childArgs.indexOf("--exclude-tools");
    if (exclusionIndex < 0 || childArgs[exclusionIndex + 1] !== "subagent") {
      throw new Error("child subagent tool exclusion missing");
    }
    if (childArgs.includes("--no-extensions")) {
      throw new Error("child extension preservation regressed");
    }
  }
  if (unrestrictedChildArgs.includes("--tools")) {
    throw new Error("unrestricted child unexpectedly received a tools allowlist");
  }
  if (!explicitlyRequestedChildArgs.includes("read,subagent")) {
    throw new Error("explicit child tools fixture was not preserved");
  }

  let tool: any;
  subagentExtension({ registerTool(value: any) { tool = value; } } as any);
  if (!tool || tool.name !== "subagent") throw new Error("subagent tool registration failed");

  // Use the real spawn/capture/termination path, but a deterministic fake Pi.
  const originalScript = process.argv[1];
  process.argv[1] = "${ROOT}/scripts/tests/fixtures/pi-subagent-child.mjs";
  try {
    const runFixture = (task: string, signal?: AbortSignal) => runSingleAgent(
      process.cwd(), {}, [baseAgent], baseAgent.name, task, undefined, undefined,
      signal, undefined,
      (results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
    );
    const completed = await runFixture("capture-fixture");
    assert.equal(completed.exitCode, 0, completed.errorMessage);
    assert.equal(completed.messages.length, 21);
    assert.equal((completed.messages.at(-1) as any)?.content[0]?.text, "SUBAGENT_CAPTURE_OK 🦊");
    assert.equal(completed.usage.turns, 1);
    assert.equal(completed.usage.input, 100);
    assert.equal(completed.usage.output, 20);
    const overflow = await runFixture("stderr-overflow");
    assert.equal(overflow.exitCode, 1);
    assert.equal(overflow.stopReason, "error");
    assert.match(overflow.errorMessage ?? "", /stderr limit exceeded/);
    assert.ok(Buffer.byteLength(overflow.stderr) <= 256 * 1024);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 100);
    try {
      await assert.rejects(runFixture("abort-fixture", controller.signal), /Subagent was aborted/);
    } finally { clearTimeout(abortTimer); }
  } finally { process.argv[1] = originalScript; }

  const overBound = await tool.execute(
    "chain-bound",
    { chain: Array.from({ length: MAX_CHAIN_STEPS + 1 }, (_, index) => ({ agent: "missing-" + index, task: "must not run" })) },
    undefined,
    undefined,
    { cwd: process.cwd(), model: undefined, thinkingLevel: "off", hasUI: false },
  );
  const overBoundText = overBound.content?.[0]?.text ?? "";
  const expectedBoundMessage = "Too many chain steps (" + (MAX_CHAIN_STEPS + 1) + "). Max is " + MAX_CHAIN_STEPS + ".";
  if (!overBound.isError || !overBoundText.includes(expectedBoundMessage)) {
    throw new Error("chain-step bound failed");
  }

  const blocked = await tool.execute(
    "test-call",
    { agent: "runtime-alias", task: "must not run", agentScope: "project", confirmProjectAgents: true },
    undefined,
    undefined,
    { cwd: process.cwd(), model: undefined, thinkingLevel: "off", hasUI: false },
  );
  const text = blocked.content?.[0]?.text ?? "";
  if (!text.includes("Blocked: project-local agents require interactive confirmation")) {
    throw new Error("non-interactive project-agent gate failed");
  }

  const marker = process.env.PI_RUNTIME_MARKER;
  if (!marker) throw new Error("PI_RUNTIME_MARKER is missing");
  fs.writeFileSync(marker, "ok");
}
EOF

# --list-models loads extensions but never contacts a model provider. This is
# deterministic, offline, and portable to macOS systems without `timeout`.
(cd "$PROJECT" && \
    PI_CODING_AGENT_DIR="$PI_HOME" PI_RUNTIME_MARKER="$MARKER" \
    pi --offline --no-extensions \
      --extension "$ROOT/pi/agent/extensions/subagent/index.ts" \
      --extension "$ROOT/pi/agent/extensions/usage-status/index.ts" \
      --extension "$ROOT/pi/agent/extensions/context-policy/index.ts" \
      --extension "$TMP/probe.ts" \
      --list-models) >"$TMP/pi.out" 2>"$TMP/pi.err"
status=$?

if [ "$status" -ne 0 ] || [ ! -f "$MARKER" ]; then
    printf 'FAIL: Pi could not load or validate the subagent extension\n' >&2
    cat "$TMP/pi.err" >&2
    exit 1
fi

printf 'PASS: Pi extension, agent model alias, project-agent gate, and model catalog\n'
