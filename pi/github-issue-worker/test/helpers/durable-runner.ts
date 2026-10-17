import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { loadConfig } from "../../src/config.js";
import { cgroupController, PiAgentRunner } from "../../src/pi-agent.js";

/** A PiAgentRunner on a faux model in `root`: the worktree is `root/worktree`, state under `root/data`. */
export async function fauxRunner(root: string, responses: FauxResponseStep[]) {
  const faux = fauxProvider({ provider: "faux-worker" });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const config = loadConfig({
    HOME: root,
    PI_WORKER_REPOSITORY: "example/widgets",
    PI_WORKER_BASE_BRANCH: "main",
    PI_WORKER_DATA_DIR: join(root, "data"),
    PI_WORKER_MODEL: `faux-worker/${faux.getModel().id}`,
    PI_CODING_AGENT_DIR: join(root, "agent"),
  });
  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  const runner = new PiAgentRunner(config, { models, cgroups: cgroupController(null) });
  const run = (prompt: string, extra: Partial<Parameters<PiAgentRunner["run"]>[0]> = {}) => runner.run({
    worktree,
    sessionDir: join(root, "data", "sessions", "issue-1"),
    sessionFile: null,
    prompt,
    logFile: join(root, "data", "logs", "issue-1.log"),
    ...extra,
  });
  return { faux, worktree, run };
}
