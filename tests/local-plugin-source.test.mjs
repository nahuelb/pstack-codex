import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkLocalPluginSource } from "../scripts/check-local-plugin-source.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-source-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await fs.writeFile(path.join(root, "skill"), "first");
  git("add", ".");
  git("commit", "-m", "initial");
  return { root, git, tree: git("rev-parse", "HEAD^{tree}") };
}

const catalog = (source) => ({ installed: [{ pluginId: "pstack-for-codex@pstack-for-codex-local", source: { source: "local", path: source } }], available: [] });

test("release source accepts equal trees in separate clean checkouts", async (t) => {
  const pushed = await fixture(t);
  const source = await fixture(t);
  assert.equal(checkLocalPluginSource(pushed.root, pushed.tree, catalog(source.root)), source.root);
});

test("release source rejects stale commits and dirty sources", async (t) => {
  const pushed = await fixture(t);
  const source = await fixture(t);
  await fs.writeFile(path.join(source.root, "skill"), "second");
  assert.throws(() => checkLocalPluginSource(pushed.root, pushed.tree, catalog(source.root)), /uncommitted/);
  source.git("commit", "-am", "change");
  assert.throws(() => checkLocalPluginSource(pushed.root, pushed.tree, catalog(source.root)), /differs/);
});

test("release source rejects missing, remote, and nested plugin sources", async (t) => {
  const pushed = await fixture(t);
  assert.throws(() => checkLocalPluginSource(pushed.root, pushed.tree, {}), /exactly one/);
  const remote = catalog(pushed.root);
  remote.installed[0].source.source = "git";
  assert.throws(() => checkLocalPluginSource(pushed.root, pushed.tree, remote), /local checkout/);
  await fs.mkdir(path.join(pushed.root, "nested"));
  assert.throws(() => checkLocalPluginSource(pushed.root, pushed.tree, catalog(path.join(pushed.root, "nested"))), /repository root/);
});

test("wrapper never installs after failed push or mismatched source", async (t) => {
  const { root } = await fixture(t);
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  await fs.mkdir(path.join(root, "scripts"));
  await fs.copyFile(new URL("../scripts/push-and-reinstall-local-plugin.sh", import.meta.url), path.join(root, "scripts/push-and-reinstall-local-plugin.sh"));
  await fs.writeFile(path.join(bin, "git"), '#!/bin/sh\ncase "$1" in\nstatus) exit 0;;\nrev-parse) echo tree;;\npush) exit "${PUSH_EXIT:-0}";;\nesac\n', { mode: 0o755 });
  await fs.writeFile(path.join(bin, "node"), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await fs.writeFile(path.join(bin, "codex"), '#!/bin/sh\necho INSTALL_CALLED\n', { mode: 0o755 });
  for (const pushExit of ["0", "1"]) {
    const result = spawnSync("bash", [path.join(root, "scripts/push-and-reinstall-local-plugin.sh")], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PUSH_EXIT: pushExit },
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /INSTALL_CALLED/);
    if (pushExit === "0") assert.match(result.stderr, /Push succeeded; plugin release blocked/);
  }
});
