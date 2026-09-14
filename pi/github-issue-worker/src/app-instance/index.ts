import type { CgroupController } from "../agent/cgroup.js";
import type { WorkerConfig } from "../config.js";
import type { QaManifest } from "../qa-manifest.js";
import { startAppInstance, type AppInstance, type AppInstanceOptions } from "./instance.js";

export * from "./instance.js";
export type { Endpoints } from "./endpoints.js";

/** The worker-level service the flows inject; tests replace `start` with a fake. */
export class AppInstanceService {
  constructor(private readonly config: WorkerConfig, private readonly cgroups: CgroupController) {}

  start(worktree: string, manifest: QaManifest, options: Omit<AppInstanceOptions, "cgroups">): Promise<AppInstance> {
    return startAppInstance(this.config, worktree, manifest, { ...options, cgroups: this.cgroups });
  }
}
