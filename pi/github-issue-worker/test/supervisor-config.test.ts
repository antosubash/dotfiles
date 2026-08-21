import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import {
  loadSupervisorProfiles,
  parseSupervisorOptions,
  type SupervisorOptions,
} from "../src/supervisor-config.js";

function options(configDir: string, profiles: readonly string[] = []): SupervisorOptions {
  return { configDir, profiles, mode: "check", restartSeconds: 15 };
}

async function writeProfile(
  directory: string,
  name: string,
  repository: string,
  dataDir?: string,
  extra: readonly string[] = [],
): Promise<string> {
  const path = join(directory, `${name}.env`);
  await writeFile(
    path,
    [
      `PI_WORKER_REPOSITORY=${repository}`,
      "PI_WORKER_BASE_BRANCH=main",
      ...(dataDir ? [`PI_WORKER_DATA_DIR=${dataDir}`] : []),
      ...extra,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  return path;
}

test("supervisor options select profiles and expand the config directory", () => {
  const parsed = parseSupervisorOptions(
    ["--config-dir", "~/workers", "--profile", "widgets.env", "--profile", "blog", "--once"],
    { HOME: "/home/test", PI_WORKER_SUPERVISOR_RESTART_SECONDS: "9" },
  );
  assert.equal(parsed.configDir, "/home/test/workers");
  assert.deepEqual(parsed.profiles, ["widgets", "blog"]);
  assert.equal(parsed.mode, "once");
  assert.equal(parsed.restartSeconds, 9);
  assert.throws(() => parseSupervisorOptions(["--check", "--once"]), /only one/);
  assert.throws(() => parseSupervisorOptions(["--profile", "../escape"]), /Invalid profile/);
});

test("supervisor loads sorted isolated repository profiles without shell evaluation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-supervisor-"));
  try {
    await mkdir(root, { recursive: true });
    const shellMarker = join(root, "shell-was-evaluated");
    await writeProfile(root, "widgets", "acme/widgets", join(root, "widgets-data"));
    await writeProfile(root, "blog", "acme/blog", join(root, "blog-data"), [
      "GH_TOKEN=profile-token",
      `UNUSED_LITERAL=$(touch ${shellMarker})`,
    ]);
    const profiles = await loadSupervisorProfiles(options(root), {
      HOME: root,
      PATH: "/usr/bin",
      PI_WORKER_REPOSITORY: "stale/repository",
      PI_WORKER_DATA_DIR: "/stale/data",
      GH_TOKEN: "inherited-token",
    });

    assert.deepEqual(
      profiles.map((profile) => profile.name),
      ["blog", "widgets"],
    );
    assert.deepEqual(
      profiles.map((profile) => profile.config.repository),
      ["acme/blog", "acme/widgets"],
    );
    assert.equal(profiles[0]?.env.GH_TOKEN, "profile-token");
    assert.equal(profiles[1]?.env.GH_TOKEN, undefined);
    assert.equal(profiles[0]?.env.UNUSED_LITERAL, `$(touch ${shellMarker})`);
    assert.equal(profiles[0]?.env.PI_WORKER_PROFILE, "blog");
    assert.equal(profiles[0]?.env.PI_WORKER_DATA_DIR, join(root, "blog-data"));
    await assert.rejects(access(shellMarker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor freezes the validated default data directory for each child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-supervisor-"));
  try {
    await writeProfile(root, "widgets", "acme/widgets");
    const [profile] = await loadSupervisorProfiles(options(root), { HOME: root });
    assert.ok(profile);
    const validatedDataDir = profile.config.dataDir;
    await mkdir(join(root, ".local/share/pi-issue-worker/acme-widgets"), { recursive: true });
    assert.equal(loadConfig(profile.env).dataDir, validatedDataDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor rejects duplicate repositories and shared state directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-supervisor-"));
  try {
    await writeProfile(root, "first", "acme/widgets", join(root, "first-data"));
    await writeProfile(root, "second", "ACME/WIDGETS", join(root, "second-data"));
    await assert.rejects(loadSupervisorProfiles(options(root), { HOME: root }), /same repository/);

    await writeProfile(root, "second", "acme/blog", join(root, "first-data"));
    await assert.rejects(loadSupervisorProfiles(options(root), { HOME: root }), /share PI_WORKER_DATA_DIR/);

    if (platform() !== "win32") {
      await mkdir(join(root, "shared-parent"));
      await symlink(join(root, "shared-parent"), join(root, "shared-alias"));
      await writeProfile(root, "first", "acme/widgets", join(root, "shared-parent", "data"));
      await writeProfile(root, "second", "acme/blog", join(root, "shared-alias", "data"));
      await assert.rejects(loadSupervisorProfiles(options(root), { HOME: root }), /share PI_WORKER_DATA_DIR/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor rejects missing, permissive, and symlinked profiles", async (context) => {
  if (platform() === "win32") context.skip("POSIX profile permissions are not available on Windows");
  const root = await mkdtemp(join(tmpdir(), "pi-worker-supervisor-"));
  try {
    const profile = await writeProfile(root, "widgets", "acme/widgets");
    await chmod(profile, 0o644);
    await assert.rejects(
      loadSupervisorProfiles(options(root, ["widgets"]), { HOME: root }),
      /permissions must be 0600/,
    );
    await assert.rejects(
      loadSupervisorProfiles(options(root, ["missing"]), { HOME: root }),
      /profile not found/,
    );

    await chmod(profile, 0o600);
    await chmod(root, 0o777);
    await assert.rejects(
      loadSupervisorProfiles(options(root, ["widgets"]), { HOME: root }),
      /directory must not be group\/world writable/,
    );
    await chmod(root, 0o700);
    await symlink(profile, join(root, "linked.env"));
    await assert.rejects(
      loadSupervisorProfiles(options(root, ["linked"]), { HOME: root }),
      /profile not found|regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
