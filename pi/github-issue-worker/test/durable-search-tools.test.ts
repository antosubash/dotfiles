import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { err, ExecutionError, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createSearchTools } from "../src/agent/durable/search-tools.js";

const tools = new Map(createSearchTools().map((tool) => [tool.name, tool]));

function api(env: ExecutionEnv | undefined): ToolExecutionApi {
  return { env } as unknown as ToolExecutionApi;
}

async function run(name: string, args: Record<string, unknown>, env: ExecutionEnv | undefined): Promise<string> {
  const tool = tools.get(name) as ToolRegistration;
  const result = await tool.execute(args as never, api(env) as never, BACKGROUND_CONTEXT);
  return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("durable search tools", () => {
  let dir: string;
  let env: NodeExecutionEnv;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "search-tools-"));
    env = new NodeExecutionEnv({ cwd: dir });
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "empty"));
    await mkdir(join(dir, "ignored"));
    await writeFile(join(dir, "src", "a.ts"), "const one = 1;\nconst needle = 2;\nconst three = 3;\n");
    await writeFile(join(dir, "src", "b.ts"), "export const other = 1;\n");
    await writeFile(join(dir, "notes.md"), "needle in notes\n");
    await writeFile(join(dir, ".hidden"), "needle hidden\n");
    await writeFile(join(dir, "ignored", "x.txt"), "needle ignored\n");
    await writeFile(join(dir, ".ignore"), "ignored/\n");
    await symlink(join(dir, "src"), join(dir, "link"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("exposes grep, find and ls as replay-safe tools", () => {
    assert.deepEqual([...tools.keys()], ["grep", "find", "ls"]);
    for (const tool of tools.values()) assert.equal(tool.replay, "safe");
  });

  it("throws without an execution environment", async () => {
    for (const [name, args] of [["grep", { pattern: "x" }], ["find", { pattern: "*" }], ["ls", {}]] as const) {
      await assert.rejects(run(name, args, undefined), /No execution environment/);
    }
  });

  it("grep reports file:line matches and honors glob", async () => {
    const output = await run("grep", { pattern: "needle", glob: "*.ts" }, env);
    assert.equal(output, "src/a.ts:2: const needle = 2;");
  });

  it("grep searches hidden files, skips ignored ones, and takes a file path", async () => {
    const output = await run("grep", { pattern: "needle" }, env);
    const lines = output.split("\n").sort();
    assert.deepEqual(lines, [".hidden:1: needle hidden", "notes.md:1: needle in notes", "src/a.ts:2: const needle = 2;"]);
    assert.equal(await run("grep", { pattern: "needle", path: "src/a.ts" }, env), "a.ts:2: const needle = 2;");
  });

  it("grep supports context, ignoreCase, literal and limit", async () => {
    const withContext = await run("grep", { pattern: "needle", path: "src", context: 1 }, env);
    assert.equal(withContext, "a.ts-1- const one = 1;\na.ts:2: const needle = 2;\na.ts-3- const three = 3;");
    assert.match(await run("grep", { pattern: "NEEDLE", path: "src", ignoreCase: true }, env), /a\.ts:2:/);
    assert.equal(await run("grep", { pattern: "NEEDLE", path: "src" }, env), "No matches found");
    assert.equal(await run("grep", { pattern: "(", path: "src", literal: true }, env), "No matches found");
    const limited = await run("grep", { pattern: "needle", limit: 1 }, env);
    assert.match(limited, /\[1 matches limit reached\. Use limit=2 for more, or refine pattern\]/);
  });

  it("grep with no match is a result, an invalid regex is an error", async () => {
    assert.equal(await run("grep", { pattern: "does-not-exist-anywhere" }, env), "No matches found");
    await assert.rejects(run("grep", { pattern: "(" }, env), /regex parse error/);
    await assert.rejects(run("grep", { pattern: "x", path: "missing" }, env), /Path not found/);
  });

  it("find matches by glob relative to the search path", async () => {
    assert.equal((await run("find", { pattern: "*.ts" }, env)).split("\n").sort().join("\n"), "src/a.ts\nsrc/b.ts");
    assert.equal(await run("find", { pattern: "*.ts", path: "src" }, env).then((o) => o.split("\n").sort().join("\n")), "a.ts\nb.ts");
    assert.equal(await run("find", { pattern: "src/*.ts" }, env).then((o) => o.split("\n").length), 2);
    assert.match(await run("find", { pattern: ".hidden" }, env), /^\.hidden$/);
    assert.equal(await run("find", { pattern: "*.nope" }, env), "No files found matching pattern");
    assert.doesNotMatch(await run("find", { pattern: "*.txt" }, env), /x\.txt/);
  });

  it("find respects limit", async () => {
    const output = await run("find", { pattern: "*.ts", limit: 1 }, env);
    assert.match(output, /\[1 results limit reached\. Use limit=2 for more, or refine pattern\]/);
    assert.equal(output.split("\n\n")[0]?.split("\n").length, 1);
  });

  it("find falls back to fdfind when fd is missing", async () => {
    const calls: string[] = [];
    const fake = new Proxy(env, {
      get(target, property) {
        if (property !== "exec") return Reflect.get(target, property, target);
        return (argv: readonly string[], ...rest: [never, never]) => {
          calls.push(argv[0] ?? "");
          if (argv[0] === "fd") return Promise.resolve(err(new ExecutionError("spawn_error", "spawn fd ENOENT")));
          return target.exec(argv, ...rest);
        };
      },
    }) as ExecutionEnv;
    const output = await run("find", { pattern: "*.md" }, fake);
    assert.equal(output, "notes.md");
    assert.deepEqual(calls, ["fd", "fdfind"]);
  });

  it("ls sorts, suffixes directories and lists dotfiles", async () => {
    const output = await run("ls", {}, env);
    assert.deepEqual(output.split("\n"), [".hidden", ".ignore", "empty/", "ignored/", "link/", "notes.md", "src/"]);
    assert.equal(await run("ls", { path: "src" }, env), "a.ts\nb.ts");
    assert.equal(await run("ls", { path: "empty" }, env), "(empty directory)");
  });

  it("ls respects limit", async () => {
    const output = await run("ls", { limit: 2 }, env);
    assert.equal(output, ".hidden\n.ignore\n\n[2 entries limit reached. Use limit=4 for more]");
  });

  it("ls errors on a missing path or a file", async () => {
    await assert.rejects(run("ls", { path: "nope" }, env), /Path not found/);
    await assert.rejects(run("ls", { path: "notes.md" }, env), /Not a directory/);
  });
});
