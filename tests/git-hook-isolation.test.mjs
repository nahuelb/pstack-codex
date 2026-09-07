import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).trim().split("\n")) {
  delete env[name];
}

for (const linked of [false, true]) {
  test(`pre-push isolates verification Git commands in a ${linked ? "linked worktree" : "checkout"}`, (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "pstack-hook-isolation-"));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const repo = join(fixture, "repository");
    const remote = join(fixture, "remote.git");
    const bin = join(fixture, "bin");
    const git = (...args) => execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--initial-branch=main", repo);
    git("init", "--bare", remote);
    git("-C", repo, "config", "user.name", "Real User");
    git("-C", repo, "config", "user.email", "real@example.invalid");
    git("-C", repo, "config", "core.hooksPath", ".githooks");
    mkdirSync(join(repo, ".githooks"));
    mkdirSync(join(repo, ".codex-plugin"));
    copyFileSync(join(root, ".githooks/pre-push"), join(repo, ".githooks/pre-push"));
    chmodSync(join(repo, ".githooks/pre-push"), 0o755);
    const manifest = join(repo, ".codex-plugin/plugin.json");
    writeFileSync(manifest, JSON.stringify({ version: "0.2.0+codex.before" }));
    git("-C", repo, "add", ".");
    git("-C", repo, "commit", "-m", "baseline");
    writeFileSync(manifest, JSON.stringify({ version: "0.2.0+codex.after" }));
    git("-C", repo, "add", ".");
    git("-C", repo, "commit", "-m", "release");
    const checkout = linked ? join(fixture, "linked worktree") : repo;
    if (linked) git("-C", repo, "worktree", "add", "-b", "release", checkout);
    mkdirSync(bin);
    const runner = join(bin, "verify.mjs");
    writeFileSync(runner, `
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
const nested = ${JSON.stringify(join(fixture, "test repository"))};
mkdirSync(nested);
execFileSync("git", ["-C", nested, "init"]);
execFileSync("git", ["-C", nested, "config", "user.name", "Pstack Test"]);
execFileSync("git", ["-C", nested, "config", "user.email", "pstack@example.invalid"]);
`);
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(bin, "npm"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)}\n`);
    chmodSync(join(bin, "npm"), 0o755);
    const config = readFileSync(join(repo, ".git/config"), "utf8");
    const refs = git("-C", repo, "show-ref");
    const result = spawnSync("git", ["-C", checkout, "push", remote, "HEAD:refs/heads/main"], {
      env: { ...env, PATH: `${bin}:${env.PATH}`, PSTACK_LOCAL_PLUGIN_PUSH: "1" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(repo, ".git/config"), "utf8"), config);
    assert.equal(git("-C", repo, "show-ref"), refs);
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), git("-C", repo, "rev-parse", "HEAD"));
  });
}
