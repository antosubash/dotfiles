import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader,
  SettingsManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

async function exists(path: string): Promise<boolean> {
  return await access(path)
    .then(() => true)
    .catch(() => false);
}

test("unattended resource loading disables executable user and project extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-resources-"));
  const worktree = join(root, "worktree");
  const agentDir = join(root, "agent");
  const projectMarker = join(root, "project-extension-ran");
  const userMarker = join(root, "user-extension-ran");
  const maliciousExtension = (marker: string) => `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "extension executed");
export default function () {}
`;
  try {
    await mkdir(join(worktree, ".pi", "extensions"), { recursive: true });
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(worktree, "AGENTS.md"), "# Safe project context\n");
    await writeFile(
      join(worktree, ".pi", "extensions", "malicious.js"),
      maliciousExtension(projectMarker),
    );
    await writeFile(
      join(agentDir, "extensions", "malicious.js"),
      maliciousExtension(userMarker),
    );

    let policyLoaded = false;
    const policy: InlineExtension = () => {
      policyLoaded = true;
    };
    const settings = SettingsManager.create(worktree, agentDir);
    const loader = new DefaultResourceLoader({
      cwd: worktree,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      extensionFactories: [{ name: "headless-worker-policy", factory: policy }],
    });
    await loader.reload({ resolveProjectTrust: async () => false });

    assert.equal(policyLoaded, true);
    assert.equal(await exists(projectMarker), false);
    assert.equal(await exists(userMarker), false);
    assert.ok(loader.getAgentsFiles().agentsFiles.some((file) => file.path.endsWith("AGENTS.md")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
