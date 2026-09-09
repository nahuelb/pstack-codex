import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

async function updateCheck(fixture, change) {
  const { manifest } = await readRun(fixture.runDir);
  change(manifest.checks[0], manifest);
  await writeFile(path.join(fixture.runDir, "manifest.json"), JSON.stringify(manifest));
}

test("exit zero without the declared barrier fails, including out-of-order observations", async (t) => {
  const f = await fixture(t, [process.execPath, "-e", "console.log('finished')"]);
  assert.equal((await runCheck(f.runDir, "test")).status, "passed");
  await updateCheck(f, (check) => { check.proof = { inputPaths: ["source.txt"], milestones: ["barrier reached", "finished"] }; });
  assert.equal((await evaluateRun(f.runDir)).checks[0].status, "stale");
  assert.equal((await runCheck(f.runDir, "test")).status, "failed");
  await updateCheck(f, (check) => { check.command = [process.execPath, "-e", "console.log('finished\\nbarrier reached')"]; });
  assert.equal((await runCheck(f.runDir, "test")).status, "failed");
  await updateCheck(f, (check) => { check.command = [process.execPath, "-e", "console.log('barrier reached\\nfinished')"]; });
  assert.equal((await runCheck(f.runDir, "test")).status, "passed");
  assert.equal((await evaluateRun(f.runDir)).acceptanceComplete, true);
  const artifact = path.join(f.root, "old.log");
  await writeFile(artifact, "barrier reached\nfinished\n");
  await assert.rejects(attachProof(f.runDir, "test", { artifact, verdict: "passed", summary: "Old run" }), /requires command/);
});

test("explicit ignored harness bytes reconstruct the source hash and invalidate on modification", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.sourceRoot, "node_modules"));
  const harness = path.join(f.sourceRoot, "node_modules", "proof.cjs");
  await writeFile(harness, "console.log('observed')");
  await updateCheck(f, (check) => { check.sourcePaths = ["."]; check.command = [process.execPath, "node_modules/proof.cjs"]; });
  await runCheck(f.runDir, "test");
  await writeFile(harness, "console.log('changed')");
  assert.equal((await evaluateRun(f.runDir)).acceptanceComplete, true);
  await updateCheck(f, (check) => { check.proof = { inputPaths: ["node_modules/proof.cjs"], milestones: ["changed"] }; });
  const receipt = await runCheck(f.runDir, "test");
  const snapshot = JSON.parse(await readFile(receipt.snapshot, "utf8"));
  const input = snapshot.inputs.find((entry) => entry.path === "node_modules/proof.cjs");
  assert.equal(Buffer.from(input.base64, "base64").toString(), "console.log('changed')");
  const { createHash } = await import("node:crypto");
  const canonical = JSON.stringify(snapshot.inputs, (_, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  assert.equal(createHash("sha256").update(canonical).digest("hex"), receipt.sourceHash);
  await writeFile(harness, "console.log('unrelated replacement')");
  assert.equal((await evaluateRun(f.runDir)).checks[0].status, "stale");
});

test("snapshot tampering and legacy receipts fail closed", async (t) => {
  const f = await fixture(t);
  const receipt = await runCheck(f.runDir, "test");
  await writeFile(receipt.snapshot, "{}");
  assert.equal((await evaluateRun(f.runDir)).checks[0].status, "stale");
  await runCheck(f.runDir, "test");
  const { events } = await readRun(f.runDir);
  delete events.at(-1).receipt.schemaVersion;
  await writeFile(path.join(f.runDir, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  assert.equal((await evaluateRun(f.runDir)).acceptanceComplete, false);
});

test("captured artifact is independent of the mutable original", async (t) => {
  const f = await fixture(t);
  const artifact = path.join(f.root, "review.txt");
  await writeFile(artifact, "reviewed bytes");
  const receipt = await attachProof(f.runDir, "test", { artifact, verdict: "passed", summary: "Reviewed" });
  await writeFile(artifact, "mutated payload");
  assert.equal(await readFile(receipt.artifact, "utf8"), "reviewed bytes");
  assert.equal((await evaluateRun(f.runDir)).checks[0].status, "stale");
  await writeFile(receipt.artifact, "tampered capture");
  assert.equal((await evaluateRun(f.runDir)).checks[0].status, "stale");
});

test("unrelated manifest status and criteria preserve evidence; relevant decisions invalidate it", async (t) => {
  const f = await fixture(t);
  await runCheck(f.runDir, "test");
  await updateCheck(f, (check, manifest) => {
    manifest.units[0].status = "done";
    manifest.objective = "Updated progress wording";
    check.status = "reported";
    manifest.checks.push({ id: "other", description: "Other check", sourcePaths: ["source.txt"], command: [process.execPath, "-e", "process.exit(0)"] });
    manifest.criteria.push({ id: "other", description: "Other criterion", decisionIds: [], checkIds: ["other"] });
  });
  assert.equal((await evaluateRun(f.runDir)).checks[0].status, "passed");
  await updateCheck(f, (_, manifest) => { manifest.decisions[0].text = "Changed relevant decision"; });
  assert.equal((await evaluateRun(f.runDir)).checks[0].status, "stale");
});

test("canonical cwd rejects another checkout and runs within the declared root", async (t) => {
  const f = await fixture(t, [process.execPath, "-e", "console.log(process.cwd())"]);
  const { realpath } = await import("node:fs/promises");
  await updateCheck(f, (check) => { check.cwd = f.root; });
  await assert.rejects(runCheck(f.runDir, "test"), /exact sourceRoot/);
  await updateCheck(f, (check) => { check.cwd = f.sourceRoot; });
  const receipt = await runCheck(f.runDir, "test");
  assert.equal((await readFile(receipt.artifact, "utf8")).trim(), await realpath(f.sourceRoot));
  assert.equal(receipt.cwd, await realpath(f.sourceRoot));
});

test("preflight mismatch blocks execution and cannot supply milestone output", async (t) => {
  const f = await fixture(t, [process.execPath, "-e", "require('fs').writeFileSync('ran','yes')"]);
  await updateCheck(f, (check) => { check.preflight = [{ command: [process.execPath, "-e", "console.log('wrong installed version')"], expectedStdout: "expected version\n" }]; });
  const receipt = await runCheck(f.runDir, "test");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.executed, false);
  await assert.rejects(readFile(path.join(f.sourceRoot, "ran")), /ENOENT/);
  await updateCheck(f, (check) => {
    check.preflight = [{ command: [process.execPath, "-e", "console.log('barrier')"], expectedStdout: "barrier\n" }];
    check.proof = { inputPaths: ["source.txt"], milestones: ["barrier"] };
  });
  assert.equal((await runCheck(f.runDir, "test")).status, "failed");
});

test("preflight source mutation blocks the command and environment expectations fail early", async (t) => {
  const f = await fixture(t);
  await updateCheck(f, (check) => { check.preflight = [{ command: [process.execPath, "-e", "require('fs').writeFileSync('source.txt','changed')"], expectedStdout: "" }]; });
  const receipt = await runCheck(f.runDir, "test");
  assert.equal(receipt.executed, false);
  assert.equal(receipt.status, "stale");
  await updateCheck(f, (check) => { delete check.preflight; check.environment = { PSTACK_PROOF_TEST_UNSET: "required" }; });
  await assert.rejects(runCheck(f.runDir, "test"), /environment/);
  await updateCheck(f, (check) => { check.environment = { PSTACK_PROOF_TEST_UNSET: null }; });
  assert.equal((await runCheck(f.runDir, "test")).status, "passed");
});

test("signal termination retains failure despite complete milestone output", async (t) => {
  const f = await fixture(t, [process.execPath, "-e", "console.log('done');process.kill(process.pid,'SIGTERM')"]);
  await updateCheck(f, (check) => { check.proof = { inputPaths: ["source.txt"], milestones: ["done"] }; });
  const receipt = await runCheck(f.runDir, "test");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.signal, "SIGTERM");
  assert.equal((await evaluateRun(f.runDir)).acceptanceComplete, false);
});

test("constructor and init CLI default only omitted timestamps", async (t) => {
  const f = await fixture(t);
  const { createManifest } = await import("../scripts/lib/run-record.mjs");
  const { main } = await import("../scripts/run-record.mjs");
  const { createdAt, ...input } = f.manifest;
  assert.ok(createManifest(input).createdAt);
  assert.equal(Object.hasOwn(input, "createdAt"), false);
  for (const value of [null, "", "not-a-date", "2026-02-30T00:00:00.000Z", 0]) {
    assert.throws(() => createManifest({ ...input, createdAt: value }), /timestamp/);
  }
  const file = path.join(f.root, "input.json");
  await writeFile(file, JSON.stringify(input));
  const output = path.join(f.root, "cli-run");
  await main(["init", output, file]);
  assert.ok((await readRun(output)).manifest.createdAt);
  await writeFile(file, JSON.stringify({ ...input, createdAt: "bad" }));
  await assert.rejects(main(["init", path.join(f.root, "bad-run"), file]), /timestamp/);
});

test("snapshot replacement during execution cannot return a passing receipt", async (t) => {
  const f = await fixture(t);
  await updateCheck(f, (check) => {
    check.command = [process.execPath, "-e", "const fs=require('fs');const p=process.argv[1];for(const file of fs.readdirSync(p))if(file.endsWith('.inputs.json'))fs.writeFileSync(require('path').join(p,file),'{}')", path.join(f.runDir, "proof")];
  });
  assert.equal((await runCheck(f.runDir, "test")).status, "stale");
});

test("preflight deletion records stale proof and does not launch the main command", async (t) => {
  const f = await fixture(t);
  await updateCheck(f, (check) => { check.preflight = [{ command: [process.execPath, "-e", "require('fs').unlinkSync('source.txt')"], expectedStdout: "" }]; });
  const receipt = await runCheck(f.runDir, "test");
  assert.equal(receipt.status, "stale");
  assert.equal(receipt.executed, false);
});

test("progress updates during a command preserve the relevant receipt", async (t) => {
  const f = await fixture(t);
  await updateCheck(f, (check) => {
    check.command = [process.execPath, "-e", "const fs=require('fs');const p=process.argv[1];const m=JSON.parse(fs.readFileSync(p));m.units[0].status='done';fs.writeFileSync(p,JSON.stringify(m))", path.join(f.runDir, "manifest.json")];
  });
  assert.equal((await runCheck(f.runDir, "test")).status, "passed");
  assert.equal((await evaluateRun(f.runDir)).acceptanceComplete, true);
});


test("validation and execution use one captured environment", async (t) => {
  const f = await fixture(t, [process.execPath, "-e", "console.log(process.env.PSTACK_PROOF_ENV_PROBE)"]);
  f.manifest.checks[0].environment = { PSTACK_PROOF_ENV_PROBE: "expected" };
  await writeFile(path.join(f.runDir, "manifest.json"), JSON.stringify(f.manifest));
  const original = process.env;
  let reads = 0;
  process.env = { ...original };
  Object.defineProperty(process.env, "PSTACK_PROOF_ENV_PROBE", { enumerable: true, get: () => ++reads === 1 ? "expected" : "wrong" });
  let receipt;
  try { receipt = await runCheck(f.runDir, "test"); } finally { process.env = original; }
  assert.equal(receipt.status, "passed");
  assert.equal(await readFile(receipt.artifact, "utf8"), "expected\n");
});

test("a running check retains diagnostic output before it finishes", async (t) => {
  const f = await fixture(t);
  const release = path.join(f.root, "release");
  f.manifest.checks[0].command = [process.execPath, "-e", "console.log('live diagnostic'); const fs=require('fs'); const timer=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(timer)},10); setTimeout(()=>process.exit(2),4000).unref()", release];
  await writeFile(path.join(f.runDir, "manifest.json"), JSON.stringify(f.manifest));
  let finished = false;
  const running = runCheck(f.runDir, "test").then((receipt) => { finished = true; return receipt; });
  let captured = "";
  try {
    const until = Date.now() + 2500;
    while (Date.now() < until && !captured) {
      for (const name of await readdir(path.join(f.runDir, "proof"))) {
        if (name.endsWith(".log")) captured += await readFile(path.join(f.runDir, "proof", name), "utf8");
      }
      if (!captured) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(captured, /live diagnostic/);
    assert.equal(finished, false);
  } finally { await writeFile(release, "release"); await running; }
});
