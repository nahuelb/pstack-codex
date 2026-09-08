import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginId = "pstack-for-codex@pstack-for-codex-local";

function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
}

export function checkLocalPluginSource(repoRoot, releaseTree, catalog) {
  const entries = [...(catalog.installed ?? []), ...(catalog.available ?? [])]
    .filter((entry) => entry.pluginId === pluginId);
  if (entries.length !== 1) throw new Error("Cannot resolve exactly one marketplace plugin source.");
  const entry = entries[0];
  if (entry.source?.source !== "local" || !path.isAbsolute(entry.source.path ?? "")) {
    throw new Error("The marketplace plugin source must be an absolute local checkout.");
  }
  const source = entry.source.path;
  for (const directory of [repoRoot, source]) {
    if (git(directory, "status", "--porcelain", "--untracked-files=all")) {
      throw new Error(`Release checkout has uncommitted files: ${directory}`);
    }
    if (git(directory, "rev-parse", "HEAD^{tree}") !== releaseTree) {
      throw new Error(`Release tree differs from the pushed tree: ${directory}`);
    }
    if (realpathSync(git(directory, "rev-parse", "--show-toplevel")) !== realpathSync(directory)) {
      throw new Error(`Plugin source must be the repository root: ${directory}`);
    }
  }
  return source;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const catalog = JSON.parse(execFileSync("codex", ["plugin", "list", "--marketplace", "pstack-for-codex-local", "--available", "--json"], { encoding: "utf8" }));
    const source = checkLocalPluginSource(process.argv[2], process.argv[3], catalog);
    console.log(`Verified marketplace source: ${source}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
