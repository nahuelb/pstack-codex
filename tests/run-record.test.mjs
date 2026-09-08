import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendEvent, attachProof, evaluateRun, initializeRun, readRun, runCheck, validateManifest } from "../scripts/lib/run-record.mjs";

async function fixture(t, command = [process.execPath, "-e", "process.exit(0)"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pstack-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, "source.txt"), "initial");
  const runDir = path.join(root, "run");
  const manifest = {
    schemaVersion: 1, runId: "test", objective: "Establish source-bound proof", sourceRoot, createdAt: new Date().toISOString(),
    decisions: [{ id: "stable", text: "Evidence describes the current source" }], units: [{ id: "impl", title: "Implementation", dependsOn: [] }],
    criteria: [{ id: "proof", description: "Changes invalidate affected evidence", decisionIds: ["stable"], checkIds: ["test"] }],
    checks: [{ id: "test", description: "Fixture check", sourcePaths: ["source.txt"], command }],
  };
  await initializeRun(runDir, manifest);
  return { root, sourceRoot, runDir, manifest };
}

test("proof starts missing, becomes current, ignores unrelated files and invalidates changed source", async (t) => {
  const { runDir, sourceRoot } = await fixture(t);
  assert.equal((await evaluateRun(runDir)).checks[0].status, "missing");
  const receipt = await runCheck(runDir, "test");
  assert.equal(receipt.origin, "command");
  assert.equal((await evaluateRun(runDir)).acceptanceComplete, true);
  await writeFile(path.join(sourceRoot, "unrelated.txt"), "unrelated");
  assert.equal((await evaluateRun(runDir)).acceptanceComplete, true);
  await writeFile(path.join(sourceRoot, "source.txt"), "changed");
  assert.equal((await evaluateRun(runDir)).checks[0].status, "stale");
});

test("failed commands and changed-during-check sources cannot satisfy acceptance", async (t) => {
  const failed = await fixture(t, [process.execPath, "-e", "console.error('expected failure');process.exit(7)"]);
  const receipt = await runCheck(failed.runDir, "test");
  assert.equal(receipt.exitCode, 7);
  assert.match(await readFile(receipt.artifact, "utf8"), /expected failure/);
  assert.equal((await evaluateRun(failed.runDir)).checks[0].status, "failed");
  const raced = await fixture(t, [process.execPath, "-e", "require('fs').writeFileSync('source.txt','changed')"]);
  assert.equal((await runCheck(raced.runDir, "test")).status, "stale");
  assert.equal((await evaluateRun(raced.runDir)).acceptanceComplete, false);
});

test("missing executable records failed evidence without hanging", async (t) => {
  const { runDir } = await fixture(t, ["pstack-nonexistent-test-executable-14935"]);
  assert.equal((await runCheck(runDir, "test")).status, "failed");
});

test("modified artifacts, deleted sources and changed criteria invalidate proof", async (t) => {
  const first = await fixture(t);
  const proof = await runCheck(first.runDir, "test");
  await writeFile(proof.artifact, "modified");
  assert.equal((await evaluateRun(first.runDir)).checks[0].status, "stale");
  await runCheck(first.runDir, "test");
  await rm(path.join(first.sourceRoot, "source.txt"));
  assert.equal((await evaluateRun(first.runDir)).checks[0].status, "stale");
  const second = await fixture(t);
  await runCheck(second.runDir, "test");
  second.manifest.criteria[0].description = "Changed contract";
  await writeFile(path.join(second.runDir, "manifest.json"), JSON.stringify(second.manifest));
  assert.equal((await evaluateRun(second.runDir)).acceptanceComplete, false);
});

test("reviewed artifacts retain provenance and a later failure supersedes a pass", async (t) => {
  const { root, runDir } = await fixture(t);
  const artifact = path.join(root, "review.md");
  await writeFile(artifact, "Reviewed source against acceptance criteria");
  const actor = { kind: "main", threadId: "main-test" };
  const receipt = await attachProof(runDir, "test", { artifact, verdict: "passed", summary: "Reviewed fixture", actor });
  assert.equal(receipt.origin, "reviewed-artifact");
  assert.equal(receipt.exitCode, null);
  assert.equal((await evaluateRun(runDir)).acceptanceComplete, true);
  await attachProof(runDir, "test", { artifact, verdict: "failed", summary: "Missed acceptance case", actor });
  assert.equal((await evaluateRun(runDir)).checks[0].status, "failed");
});

test("acceptance contract rejects unmapped decisions, missing checks, cycles and escaped source paths", async (t) => {
  const { manifest } = await fixture(t);
  const alter = (change, pattern) => {
    const copy = structuredClone(manifest);
    change(copy);
    assert.throws(() => validateManifest(copy), pattern);
  };
  alter((m) => m.decisions.push({ id: "unmapped", text: "Missing test" }), /no acceptance/);
  alter((m) => m.criteria[0].checkIds = [], /needs checks/);
  alter((m) => m.units[0].dependsOn = ["impl"], /Cyclic/);
  alter((m) => m.checks[0].sourcePaths = ["../secret"], /stay inside/);
  alter((m) => m.checks[0].command = "echo accidental-shell", /argv/);
});

test("records cannot overwrite existing runs or hide under source snapshots", async (t) => {
  const { runDir, sourceRoot, manifest } = await fixture(t);
  await assert.rejects(initializeRun(runDir, manifest), /EEXIST/);
  await assert.rejects(initializeRun(path.join(sourceRoot, "run"), manifest), /outside/);
  assert.equal((await readRun(runDir)).manifest.runId, "test");
});

test("source symlinks fail closed and directory snapshots notice new files", async (t) => {
  const { runDir, sourceRoot, manifest, root } = await fixture(t);
  manifest.checks[0].sourcePaths = ["."];
  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest));
  await runCheck(runDir, "test");
  await writeFile(path.join(sourceRoot, "new.txt"), "new");
  assert.equal((await evaluateRun(runDir)).checks[0].status, "stale");
  await symlink(root, path.join(sourceRoot, "escape"));
  await assert.rejects(runCheck(runDir, "test"), /symlink/);
});

test("event records validate identity and reject arbitrary verification receipts", async (t) => {
  const { runDir } = await fixture(t);
  await appendEvent(runDir, { id: "one", type: "unit_ready", unitId: "impl" });
  await assert.rejects(appendEvent(runDir, { id: "one", type: "run_finished" }), /Duplicate/);
  await assert.rejects(appendEvent(runDir, { type: "unit_started", unitId: "unknown" }), /known unitId/);
  await assert.rejects(appendEvent(runDir, { type: "check_recorded", receipt: { status: "passed" } }), /Unsupported/);
  await appendEvent(runDir, { type: "token_usage", actor: { threadId: "main", kind: "main" }, usage: { totalTokens: null }, source: "Supported API returned no usage" });
  assert.equal((await readRun(runDir)).events.length, 2);
});
