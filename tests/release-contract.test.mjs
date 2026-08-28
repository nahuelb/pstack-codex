import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the default release gate includes offline verification and the installed Codex smoke", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.scripts.test, "npm run verify:release");
  assert.equal(manifest.scripts.verify, "npm run verify:offline");
  assert.match(manifest.scripts["verify:release"], /npm run verify:offline/);
  assert.match(manifest.scripts["verify:release"], /npm run test:installed/);
  assert.match(manifest.scripts["test:installed"], /PSTACK_RUN_INSTALLED_SMOKE=1/);
});

test("the push wrapper reinstalls the local plugin only after a successful push", async () => {
  const [manifest, script, instructions] = await Promise.all([
    fs.readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(root, "scripts/push-and-reinstall-local-plugin.sh"), "utf8"),
    fs.readFile(path.join(root, "AGENTS.md"), "utf8"),
  ]);
  assert.equal(manifest.scripts["push:local-plugin"], "./scripts/push-and-reinstall-local-plugin.sh");
  assert.ok(script.indexOf("git push") < script.indexOf("codex plugin add"));
  assert.match(script, /git status --porcelain/);
  assert.match(instructions, /update_plugin_cachebuster\.py/);
  assert.match(instructions, /push-and-reinstall-local-plugin\.sh/);
});
