import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { section, type PromptSection } from "@earendil-works/pi-durable";
import { AGENT_POLICY, type VerificationOptions } from "../policy.js";

const PREAMBLE =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const RULES = ["Be concise in your responses", "Show file paths clearly when working with files"]
  .map((rule) => `- ${rule}`).join("\n");

export interface WorkerPromptInput {
  worktree: string;
  agentDir: string;
  verification?: VerificationOptions;
}

export interface WorkerPrompt {
  /** Project instructions (`AGENTS.md` and friends) found from the worktree upwards, as the coding agent finds them. */
  readonly contextFiles: ReadonlyArray<{ path: string; content: string }>;
  /** The worker policy, the verifier addendum, and the agent directory's `APPEND_SYSTEM.md`. */
  readonly addendum: string;
}

/**
 * The text the coding agent's resource loader would add to the system prompt for this worktree. Project trust stays
 * off and skills are left out: a skill file lives outside the worktree, where the tool policy refuses every read.
 */
export async function loadWorkerPrompt(input: WorkerPromptInput): Promise<WorkerPrompt> {
  const verifier = input.verification
    ? `Independent verification mode: do not modify source. Read-only access is limited to ${JSON.stringify(input.verification.readPaths)} and writes to ${JSON.stringify(input.verification.evidenceDir)}. Return an independent verdict, never implementation changes.`
    : undefined;
  const loader = new DefaultResourceLoader({
    cwd: input.worktree,
    agentDir: input.agentDir,
    settingsManager: SettingsManager.create(input.worktree, input.agentDir),
    appendSystemPrompt: [AGENT_POLICY, ...(verifier ? [verifier] : [])],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload({ resolveProjectTrust: async () => false });
  return {
    contextFiles: loader.getAgentsFiles().agentsFiles,
    addendum: loader.getAppendSystemPrompt().map((text) => text.trim()).filter(Boolean).join("\n\n"),
  };
}

/** System prompt sections in the coding agent's order; the run's working directory comes from the environment. */
export function workerPromptSections(prompt: WorkerPrompt): PromptSection[] {
  return [
    section("preamble", () => PREAMBLE, { tag: false }),
    section("rules", () => RULES),
    section("addendum", () => prompt.addendum || undefined),
    section("project_context", () => prompt.contextFiles.length === 0 ? undefined : [
      "Project-specific instructions and guidelines:",
      ...prompt.contextFiles.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
    ].join("\n\n")),
    section("cwd", (input) => input.env?.cwd.replace(/\\/g, "/")),
  ];
}
