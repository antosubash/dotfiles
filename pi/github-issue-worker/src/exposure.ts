import type { GhRunner } from "./github/gh.js";

/** Exit code (EX_CONFIG) for a worker that refuses its profile; the supervisor does not restart it. */
export const REFUSED_EXIT_CODE = 78;

/**
 * Anyone can open or edit issues on a public repository, so an approved issue there is attacker
 * input. Without the OS sandbox the agent's bash runs as this user with its GitHub login, SSH keys
 * and open network, behind only the tool-level command policy. Refuse that combination unless the
 * profile accepts it explicitly. A failed visibility lookup throws, so the worker never runs unchecked.
 */
export async function unsafeExposureReason(
  gh: GhRunner,
  repository: string,
  sandbox: boolean,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (sandbox || env.PI_WORKER_ALLOW_UNSANDBOXED_PUBLIC === "1") return null;
  const visibility = await gh(["repo", "view", repository, "--json", "visibility", "-q", ".visibility"]);
  if (visibility.trim().toUpperCase() !== "PUBLIC") return null;
  return (
    `${repository} is public and PI_WORKER_SANDBOX=0: an approved issue would run an unsandboxed agent ` +
    `with this machine's GitHub credentials. Set PI_WORKER_SANDBOX=1, or PI_WORKER_ALLOW_UNSANDBOXED_PUBLIC=1 ` +
    `to accept the risk.`
  );
}
