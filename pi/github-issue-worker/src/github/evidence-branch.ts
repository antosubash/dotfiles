import type { WorkerConfig } from "../config.js";
import type { EvidenceAttachment } from "../evidence.js";
import type { GhRunner } from "./gh.js";

async function ensureEvidenceBranch(
  gh: GhRunner,
  config: WorkerConfig,
): Promise<{
  headSha: string;
  treeSha: string;
  paths: ReadonlyMap<string, string>;
}> {
  const branchPath = config.evidenceBranch.split("/").map(encodeURIComponent).join("/");
  try {
    const ref = JSON.parse(
      await gh(["api", `/repos/${config.repository}/git/ref/heads/${branchPath}`]),
    ) as { object: { sha: string } };
    const head = JSON.parse(
      await gh(["api", `/repos/${config.repository}/git/commits/${ref.object.sha}`]),
    ) as { tree: { sha: string } };
    const tree = JSON.parse(
      await gh([
        "api",
        `/repos/${config.repository}/git/trees/${head.tree.sha}?recursive=1`,
      ]),
    ) as { tree: Array<{ path: string; type?: string; sha?: string }>; truncated?: boolean };
    if (tree.truncated) {
      throw new Error(`Refusing evidence branch ${config.evidenceBranch}: tree listing is truncated`);
    }
    const unsafe = tree.tree.find(
      (entry) => entry.path !== "qa" && !entry.path.startsWith("qa/"),
    );
    if (unsafe) {
      throw new Error(
        `Refusing evidence branch ${config.evidenceBranch}: unexpected path ${unsafe.path}`,
      );
    }
    const pages = JSON.parse(
      await gh([
        "api",
        "--paginate",
        "--slurp",
        `/repos/${config.repository}/commits?sha=${encodeURIComponent(config.evidenceBranch)}&per_page=100`,
      ]),
    ) as Array<Array<{
      sha: string;
      parents: Array<{ sha: string }>;
      commit: { message: string; tree: { sha: string } };
    }>>;
    const history = pages.flat();
    if (history.length === 0 || history.length > 10_000 || history[0]!.sha !== ref.object.sha) {
      throw new Error(`Refusing evidence branch ${config.evidenceBranch}: invalid history`);
    }
    for (let index = 0; index < history.length - 1; index += 1) {
      const current = history[index]!;
      const parent = history[index + 1]!;
      if (
        current.parents.length !== 1 ||
        current.parents[0]!.sha !== parent.sha ||
        !current.commit.message.startsWith("qa: publish evidence for PR #")
      ) {
        throw new Error(`Refusing evidence branch ${config.evidenceBranch}: untrusted ancestry`);
      }
    }
    const root = history.at(-1)!;
    if (
      root.parents.length !== 0 ||
      root.commit.tree.sha !== "4b825dc642cb6eb9a060e54bf8d69288fbee4904" ||
      root.commit.message !== "Initialize Pi QA evidence branch"
    ) {
      throw new Error(`Refusing evidence branch ${config.evidenceBranch}: root is not worker-owned`);
    }
    const [owner, name] = config.repository.split("/") as [string, string];
    for (let offset = 0; offset < history.length; offset += 50) {
      const commits = history.slice(offset, offset + 50);
      const selections = commits
        .map(
          (commit, index) =>
            `t${index}: object(oid: \"${commit.commit.tree.sha}\") { ... on Tree { entries { name type } } }`,
        )
        .join("\n");
      const response = JSON.parse(
        await gh([
          "api",
          "graphql",
          "-f",
          `query=query { repository(owner: \"${owner}\", name: \"${name}\") { ${selections} } }`,
        ]),
      ) as {
        data?: { repository?: Record<string, { entries?: Array<{ name: string; type: string }> } | null> };
      };
      for (let index = 0; index < commits.length; index += 1) {
        const entries = response.data?.repository?.[`t${index}`]?.entries;
        if (!entries || entries.some((entry) => entry.name !== "qa")) {
          throw new Error(
            `Refusing evidence branch ${config.evidenceBranch}: historical tree contains an unexpected path`,
          );
        }
      }
    }
    return {
      headSha: ref.object.sha,
      treeSha: head.tree.sha,
      paths: new Map(
        tree.tree
          .filter((entry) => entry.type === "blob" && entry.sha)
          .map((entry) => [entry.path, entry.sha!] as const),
      ),
    };
  } catch (error) {
    if (!/HTTP 404|Not Found/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
  }
  const emptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const commit = JSON.parse(
    await gh(
      ["api", "--method", "POST", `/repos/${config.repository}/git/commits`, "--input", "-"],
      JSON.stringify({ message: "Initialize Pi QA evidence branch", tree: emptyTreeSha, parents: [] }),
    ),
  ) as { sha: string };
  try {
    await gh(
      ["api", "--method", "POST", `/repos/${config.repository}/git/refs`, "--input", "-"],
      JSON.stringify({ ref: `refs/heads/${config.evidenceBranch}`, sha: commit.sha }),
    );
    return { headSha: commit.sha, treeSha: emptyTreeSha, paths: new Map() };
  } catch (error) {
    if (!/HTTP 422|Reference already exists/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
    return await ensureEvidenceBranch(gh, config);
  }
}

export async function publishEvidence(
  gh: GhRunner,
  config: WorkerConfig,
  prNumber: number,
  headSha: string,
  runId: string,
  attachments: readonly EvidenceAttachment[],
): Promise<string> {
  if (!config.publishEvidence || attachments.length === 0) return "";
  const branch = await ensureEvidenceBranch(gh, config);
  const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  const published: Array<{ name: string; mediaType: EvidenceAttachment["mediaType"]; htmlUrl: string }> = [];
  for (const attachment of attachments) {
    const relativeParts = [
      "qa",
      `pr-${prNumber}`,
      headSha.slice(0, 12),
      runId,
      attachment.name,
    ];
    const relativePath = relativeParts.join("/");
    const blob = JSON.parse(
      await gh(
        ["api", "--method", "POST", `/repos/${config.repository}/git/blobs`, "--input", "-"],
        JSON.stringify({ content: attachment.content.toString("base64"), encoding: "base64" }),
      ),
    ) as { sha: string };
    treeEntries.push({ path: relativePath, mode: "100644", type: "blob", sha: blob.sha });
    const encodedPath = relativeParts.map(encodeURIComponent).join("/");
    const htmlUrl = `https://github.com/${config.repository}/blob/${encodeURIComponent(config.evidenceBranch)}/${encodedPath}`;
    published.push({ name: attachment.name, mediaType: attachment.mediaType, htmlUrl });
  }
  const markdown = () => {
    const lines = published.map((item) =>
      item.mediaType.startsWith("image/")
        ? `[![${item.name}](${item.htmlUrl}?raw=1)](${item.htmlUrl})`
        : `- [Download ${item.name}](${item.htmlUrl}?raw=1)`,
    );
    return `\n\n### Attached QA evidence\n${lines.join("\n\n")}`;
  };
  if (treeEntries.every((entry) => branch.paths.get(entry.path) === entry.sha)) {
    return markdown();
  }
  const tree = JSON.parse(
    await gh(
      ["api", "--method", "POST", `/repos/${config.repository}/git/trees`, "--input", "-"],
      JSON.stringify({ base_tree: branch.treeSha, tree: treeEntries }),
    ),
  ) as { sha: string };
  const commit = JSON.parse(
    await gh(
      ["api", "--method", "POST", `/repos/${config.repository}/git/commits`, "--input", "-"],
      JSON.stringify({
        message: `qa: publish evidence for PR #${prNumber}`,
        tree: tree.sha,
        parents: [branch.headSha],
      }),
    ),
  ) as { sha: string };
  const branchPath = config.evidenceBranch.split("/").map(encodeURIComponent).join("/");
  await gh(
    [
      "api",
      "--method",
      "PATCH",
      `/repos/${config.repository}/git/refs/heads/${branchPath}`,
      "--input",
      "-",
    ],
    JSON.stringify({ sha: commit.sha, force: false }),
  );
  return markdown();
}
