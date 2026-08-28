import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installAgents, uninstallAgents } from "../skills/setup-pstack/scripts/manage-agents.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "pstack-receipt-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  const userHome = path.join(temporary, "home");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(userHome, { recursive: true });
  return { projectRoot, userHome };
}

test("an unchanged project-scoped install is reversible from its hash receipt", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const receipt = JSON.parse(await fs.readFile(path.join(projectRoot, installed.receiptPath), "utf8"));
  assert.equal(receipt.schema_version, 2);
  assert.equal(receipt.scope, "project");
  assert.equal(receipt.files.length, 3);
  assert.ok(receipt.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));

  const removed = await uninstallAgents({ projectRoot, userHome, scope: "project" });
  assert.equal(removed.status, "uninstalled");
  for (const file of receipt.files) {
    await assert.rejects(fs.stat(path.join(projectRoot, file.path)), { code: "ENOENT" });
  }
});

test("a locally modified installed profile requires review and remains untouched", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const target = path.join(projectRoot, installed.files[0].path);
  const unchanged = path.join(projectRoot, installed.files[1].path);
  await fs.appendFile(target, "\n# local change\n");

  await assert.rejects(
    installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" }),
    /review required for divergent pstack-owned files.*modified.*run uninstall to preserve changed files/,
  );

  const removed = await uninstallAgents({ projectRoot, userHome, scope: "project" });
  assert.equal(removed.status, "uninstalled-with-preserved-files");
  assert.deepEqual(removed.modified, [installed.files[0].path]);
  assert.deepEqual(removed.diagnostics.map(({ path: file, status }) => ({ path: file, status })), [
    { path: installed.files[0].path, status: "modified" },
  ]);
  assert.match(removed.recovery, /Move or remove them before reinstalling/);
  assert.match(await fs.readFile(target, "utf8"), /local change/);
  await assert.rejects(fs.stat(unchanged), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(projectRoot, installed.receiptPath)), { code: "ENOENT" });
  await fs.stat(path.join(projectRoot, removed.archivedReceipt));
});

test("a missing managed profile is diagnosed and uninstall remains recoverable", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  await fs.rm(path.join(projectRoot, installed.files[0].path));

  await assert.rejects(
    installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" }),
    /\(missing\).*run uninstall to preserve changed files/,
  );
  const removed = await uninstallAgents({ projectRoot, userHome, scope: "project" });
  assert.equal(removed.status, "uninstalled-with-preserved-files");
  assert.equal(removed.diagnostics[0].status, "missing");
  await fs.stat(path.join(projectRoot, removed.archivedReceipt));
});

test("forged receipt paths cannot select uninstall targets", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
  const receiptPath = path.join(projectRoot, installed.receiptPath);
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  const victim = path.join(projectRoot, ".codex/keep-me.txt");
  await fs.writeFile(victim, "user data\n");
  receipt.files[0].path = ".codex/keep-me.txt";
  receipt.files[0].sha256 = "0".repeat(64);
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  await assert.rejects(uninstallAgents({ projectRoot, userHome, scope: "project" }), /unexpected path/);
  assert.equal(await fs.readFile(victim, "utf8"), "user data\n");
  for (const file of installed.files) await fs.stat(path.join(projectRoot, file.path));
  await fs.stat(receiptPath);
});

test("duplicate and missing role paths invalidate a setup receipt", async (t) => {
  await t.test("duplicate", async (t) => {
    const { projectRoot, userHome } = await fixture(t);
    const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
    const receiptPath = path.join(projectRoot, installed.receiptPath);
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    receipt.files[1].path = receipt.files[0].path;
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    await assert.rejects(uninstallAgents({ projectRoot, userHome, scope: "project" }), /duplicate path/);
  });

  await t.test("missing", async (t) => {
    const { projectRoot, userHome } = await fixture(t);
    const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });
    const receiptPath = path.join(projectRoot, installed.receiptPath);
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    receipt.files.pop();
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    await assert.rejects(uninstallAgents({ projectRoot, userHome, scope: "project" }), /missing expected path/);
  });
});

test("user-scoped installs write only beneath the supplied Codex home", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const installed = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "user" });
  assert.deepEqual(
    installed.files.map((file) => file.path),
    ["agents/pstack-poteto-agent.toml", "agents/pstack-comment-sicko.toml", "pstack-models.json"],
  );
  for (const file of installed.files) await fs.stat(path.join(userHome, ".codex", file.path));
  await assert.rejects(fs.stat(path.join(projectRoot, ".codex/agents")), { code: "ENOENT" });
});

test("an existing unowned model registry is never overwritten", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const codexDirectory = path.join(projectRoot, ".codex");
  const registry = path.join(codexDirectory, "pstack-models.json");
  await fs.mkdir(codexDirectory, { recursive: true });
  await fs.writeFile(registry, '{"belongs_to":"user"}\n');

  await assert.rejects(
    installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" }),
    /already exists and is not owned by pstack/,
  );
  assert.equal(await fs.readFile(registry, "utf8"), '{"belongs_to":"user"}\n');
  await assert.rejects(fs.stat(path.join(codexDirectory, "agents/pstack-poteto-agent.toml")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(codexDirectory, "agents/pstack-comment-sicko.toml")), { code: "ENOENT" });
});

test("a schema-one receipt upgrades without losing validated persona choices", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const requested = { model: "gpt-5.6-sol", reasoning_effort: "high" };
  const installed = await installAgents({
    pluginRoot: root,
    projectRoot,
    userHome,
    scope: "project",
    profile: { "pstack-poteto-agent": requested },
    observableModels: [{ slug: "gpt-5.6-sol", reasoning_efforts: ["high"] }],
  });
  const receiptPath = path.join(projectRoot, installed.receiptPath);
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  await fs.rm(path.join(projectRoot, installed.registryPath));
  receipt.schema_version = 1;
  receipt.files = receipt.files.filter((file) => file.path.endsWith(".toml"));
  delete receipt.role_policies;
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const upgraded = await installAgents({
    pluginRoot: root,
    projectRoot,
    userHome,
    scope: "project",
    observableModels: [{ slug: "gpt-5.6-sol", reasoning_efforts: ["high"] }],
  });
  const profile = await fs.readFile(path.join(projectRoot, ".codex/agents/pstack-poteto-agent.toml"), "utf8");
  assert.match(profile, /^model = "gpt-5\.6-sol"$/m);
  assert.equal(JSON.parse(await fs.readFile(path.join(projectRoot, upgraded.receiptPath), "utf8")).schema_version, 2);
  await fs.stat(path.join(projectRoot, upgraded.registryPath));
});

test("a partial role update preserves every omitted lane", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const sol = { model: "gpt-5.6-sol", reasoning_effort: "high" };
  const luna = { model: "gpt-5.6-luna", reasoning_effort: "max" };
  const observableModels = [
    { slug: "gpt-5.6-sol", reasoning_efforts: ["high"] },
    { slug: "gpt-5.6-luna", reasoning_efforts: ["max"] },
  ];
  const first = await installAgents({
    pluginRoot: root,
    projectRoot,
    userHome,
    scope: "project",
    roleProfile: { "bug-fix": sol, "perf-issue": sol },
    observableModels,
  });
  const updated = await installAgents({
    pluginRoot: root,
    projectRoot,
    userHome,
    scope: "project",
    roleProfile: { "bug-fix": luna },
    observableModels,
  });

  assert.deepEqual(first.roles["perf-issue"], [sol]);
  assert.deepEqual(updated.roles["perf-issue"], [sol]);
  assert.deepEqual(updated.roles["bug-fix"], [luna]);
  assert.deepEqual(updated.roles["hillclimb"], [{ use_skill_default: true }]);
  assert.equal(updated.roles["how critics"].length, 4);
});

test("an update without model discovery preserves validated explicit lanes", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const requested = { model: "gpt-5.6-sol", reasoning_effort: "high" };
  const first = await installAgents({
    pluginRoot: root,
    projectRoot,
    userHome,
    scope: "project",
    roleProfile: { "bug-fix": requested },
    observableModels: [{ slug: "gpt-5.6-sol", reasoning_efforts: ["high"] }],
  });
  const updated = await installAgents({ pluginRoot: root, projectRoot, userHome, scope: "project" });

  assert.deepEqual(first.roles["bug-fix"], [requested]);
  assert.deepEqual(updated.roles["bug-fix"], [requested]);
  assert.deepEqual(updated.roles["perf-issue"], [{ use_skill_default: true }]);
  const receipt = JSON.parse(await fs.readFile(path.join(projectRoot, updated.receiptPath), "utf8"));
  assert.equal(receipt.role_policies["bug-fix"][0].status, "verified-explicit");
});

test("a partial update can restore an explicit role to its skill default", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const requested = { model: "gpt-5.6-sol", reasoning_effort: "high" };
  await installAgents({
    pluginRoot: root,
    projectRoot,
    userHome,
    scope: "project",
    roleProfile: { "bug-fix": requested },
    observableModels: [{ slug: "gpt-5.6-sol", reasoning_efforts: ["high"] }],
  });
  const updated = await installAgents({
    pluginRoot: root,
    projectRoot,
    userHome,
    scope: "project",
    roleProfile: { "bug-fix": "skill-default" },
  });

  assert.deepEqual(updated.roles["bug-fix"], [{ use_skill_default: true }]);
  assert.equal(updated.roles["how critics"].length, 4);
});

test("a partial update stops when a preserved model is no longer observable", async (t) => {
  const { projectRoot, userHome } = await fixture(t);
  const sol = { model: "gpt-5.6-sol", reasoning_effort: "high" };
  const luna = { model: "gpt-5.6-luna", reasoning_effort: "max" };
  const installed = await installAgents({
    pluginRoot: root,
    projectRoot,
    userHome,
    scope: "project",
    roleProfile: { "bug-fix": sol },
    observableModels: [{ slug: "gpt-5.6-sol", reasoning_efforts: ["high"] }],
  });
  const receiptPath = path.join(projectRoot, installed.receiptPath);
  const registryPath = path.join(projectRoot, installed.registryPath);
  const [receiptBefore, registryBefore] = await Promise.all([
    fs.readFile(receiptPath, "utf8"),
    fs.readFile(registryPath, "utf8"),
  ]);

  await assert.rejects(
    installAgents({
      pluginRoot: root,
      projectRoot,
      userHome,
      scope: "project",
      roleProfile: { "perf-issue": luna },
      observableModels: [{ slug: "gpt-5.6-luna", reasoning_efforts: ["max"] }],
    }),
    /model "gpt-5.6-sol" is not in the observable model list/,
  );
  assert.equal(await fs.readFile(receiptPath, "utf8"), receiptBefore);
  assert.equal(await fs.readFile(registryPath, "utf8"), registryBefore);
});
