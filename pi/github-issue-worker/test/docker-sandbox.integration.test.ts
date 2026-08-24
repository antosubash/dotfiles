import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { loadConfig } from "../src/config.js";
import { sandboxConfig } from "../src/pi-agent.js";

const enabled = process.env.PI_WORKER_DOCKER_SMOKE === "1";

test(
  "explicit Docker sandbox can reach the configured daemon socket",
  { skip: enabled ? false : "set PI_WORKER_DOCKER_SMOKE=1 to run the privileged Docker smoke test" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-worker-docker-smoke-"));
    const worktree = join(root, "worktree");
    const privateTemp = await mkdtemp(join(`/run/user/${process.getuid?.()}`, "piw-"));
    await mkdir(worktree);
    const dockerSocket = process.env.PI_WORKER_DOCKER_SOCKET || "/var/run/docker.sock";
    const config = loadConfig({
      ...process.env,
      PI_WORKER_REPOSITORY: "example/widgets",
      PI_WORKER_BASE_BRANCH: "main",
      PI_WORKER_DATA_DIR: join(root, "data"),
      PI_WORKER_ALLOW_DOCKER: "1",
      PI_WORKER_DOCKER_SOCKET: dockerSocket,
    });
    try {
      await SandboxManager.initialize(
        sandboxConfig(worktree, config, {
          privateTemp,
          dockerSocket: config.dockerSocket,
        }),
      );
      const wrapped = await SandboxManager.wrapWithSandbox(
        "docker version --format '{{.Client.Version}} {{.Server.Version}}'",
      );
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(wrapped, {
            cwd: worktree,
            env: { ...process.env, DOCKER_HOST: `unix://${config.dockerSocket}` },
            shell: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => { stdout += chunk; });
          child.stderr.on("data", (chunk: string) => { stderr += chunk; });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^\S+ \S+\s*$/);
    } finally {
      await SandboxManager.reset();
      await rm(root, { recursive: true, force: true });
      await rm(privateTemp, { recursive: true, force: true });
    }
  },
);
