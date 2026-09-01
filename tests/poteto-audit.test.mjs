import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DECISION_HEADER,
  EVENT_HEADER,
  appendDecision,
  appendEvent,
  auditStatus,
  createAuditRun,
} from "../skills/show-me-your-work/scripts/audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const pluginData = await fs.mkdtemp(path.join(os.tmpdir(), "pstack-audit-"));
  t.after(() => fs.rm(pluginData, { recursive: true, force: true }));
  return pluginData;
}

test("private audit runs link one canonical ledger and execution trace", async (t) => {
  const pluginData = await fixture(t);
  const run = await createAuditRun({
    pluginData,
    parentTaskId: "task-1",
    projectFingerprint: "project-1",
    runId: "run-1",
    now: 1_000,
  });
  await appendDecision(run.run_directory, {
    phase: "build",
    decision: "kept the current scope",
    why: "the gate passed",
    evidence: "commit abc123",
    result: "next gate open",
    ref: "task task-1, turn turn-2",
  }, 2_000);
  await appendEvent(run.run_directory, {
    actorId: "agent-1",
    parentActorId: "main:task-1",
    event: "verification",
    detail: "unit tests completed",
    evidence: "receipt tests/unit.txt",
    state: "passed",
    ref: "task task-1, turn turn-2",
  }, 3_000);

  assert.deepEqual(await auditStatus(run.run_directory), {
    run_id: "run-1",
    parent_task_id: "task-1",
    privacy: "private",
    ledger: path.join(run.run_directory, "decisions.tsv"),
    trace: path.join(run.run_directory, "events.tsv"),
    decisions: 1,
    events: 1,
  });
  assert.match(await fs.readFile(path.join(run.run_directory, "decisions.tsv"), "utf8"), new RegExp(`^${DECISION_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
  assert.match(await fs.readFile(path.join(run.run_directory, "events.tsv"), "utf8"), new RegExp(`^${EVENT_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
  assert.equal((await fs.stat(run.run_directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(run.run_directory, "run.json"))).mode & 0o777, 0o600);
});

test("audit rows reject unknown lifecycle events and secret-shaped references", async (t) => {
  const pluginData = await fixture(t);
  const run = await createAuditRun({
    pluginData,
    parentTaskId: "task-1",
    projectFingerprint: "project-1",
    runId: "run-2",
  });
  await assert.rejects(appendEvent(run.run_directory, {
    actorId: "agent-1",
    parentActorId: "main:task-1",
    event: "command",
    detail: "ran a routine command",
    evidence: "none",
    state: "done",
    ref: "task task-1",
  }), /event must be one of/);
  await assert.rejects(appendDecision(run.run_directory, {
    phase: "release",
    decision: "stored evidence",
    why: "needed proof",
    evidence: "token=do-not-store-this",
    result: "blocked",
    ref: "task task-1",
  }), /without secrets/);
  assert.equal((await auditStatus(run.run_directory)).decisions, 0);
  await assert.rejects(createAuditRun({
    pluginData,
    parentTaskId: "task-1",
    projectFingerprint: "project-1",
    runId: "../escape",
  }), /without traversal/);
});

test("audit appends fail closed when a canonical file is missing or malformed", async (t) => {
  const pluginData = await fixture(t);
  const missing = await createAuditRun({
    pluginData,
    parentTaskId: "task-1",
    projectFingerprint: "project-1",
    runId: "run-missing",
  });
  const eventPath = path.join(missing.run_directory, "events.tsv");
  await fs.rm(eventPath);
  await assert.rejects(appendEvent(missing.run_directory, {
    actorId: "agent-1",
    parentActorId: "main:task-1",
    event: "state",
    detail: "should not append",
    evidence: "none",
    state: "active",
    ref: "task task-1",
  }), /ENOENT/);
  await assert.rejects(fs.stat(eventPath), { code: "ENOENT" });

  const malformed = await createAuditRun({
    pluginData,
    parentTaskId: "task-1",
    projectFingerprint: "project-1",
    runId: "run-malformed",
  });
  const decisionPath = path.join(malformed.run_directory, "decisions.tsv");
  await fs.writeFile(decisionPath, "wrong\theader\n", { mode: 0o600 });
  await assert.rejects(appendDecision(malformed.run_directory, {
    phase: "build",
    decision: "should not append",
    why: "header is malformed",
    evidence: "none",
    result: "blocked",
    ref: "task task-1",
  }), /header does not match/);
  assert.equal(await fs.readFile(decisionPath, "utf8"), "wrong\theader\n");

  const partial = await createAuditRun({
    pluginData,
    parentTaskId: "task-1",
    projectFingerprint: "project-1",
    runId: "run-partial",
  });
  const partialEventPath = path.join(partial.run_directory, "events.tsv");
  await fs.appendFile(partialEventPath, "partial");
  await assert.rejects(appendEvent(partial.run_directory, {
    actorId: "agent-1",
    parentActorId: "unknown",
    event: "state",
    detail: "should not join the partial row",
    evidence: "none",
    state: "active",
    ref: "task task-1",
  }), /tail is incomplete/);
  await assert.rejects(auditStatus(partial.run_directory), /invalid row framing/);

  const blank = await createAuditRun({
    pluginData,
    parentTaskId: "task-1",
    projectFingerprint: "project-1",
    runId: "run-blank",
  });
  const blankEventPath = path.join(blank.run_directory, "events.tsv");
  await fs.appendFile(blankEventPath, "\n");
  await assert.rejects(appendEvent(blank.run_directory, {
    actorId: "agent-1",
    parentActorId: "unknown",
    event: "state",
    detail: "should not follow a blank row",
    evidence: "none",
    state: "active",
    ref: "task task-1",
  }), /blank row/);
  await assert.rejects(auditStatus(blank.run_directory), /invalid row framing/);
});

test("Poteto instructions route every actor and derived artifact to one private audit run", async () => {
  const [poteto, audit, runtime, orchestrate] = await Promise.all([
    fs.readFile(path.join(root, "skills/poteto-mode/SKILL.md"), "utf8"),
    fs.readFile(path.join(root, "skills/show-me-your-work/SKILL.md"), "utf8"),
    fs.readFile(path.join(root, "skills/poteto-mode/references/codex-agent-runtime.md"), "utf8"),
    fs.readFile(path.join(root, "skills/poteto-mode/playbooks/orchestrate.md"), "utf8"),
  ]);
  assert.match(poteto, /Every Poteto run uses the private audit run/);
  assert.match(poteto, /Every brief carries the private audit run ID/);
  assert.match(audit, /before a new phase, after a commit, after a subagent result, after a failed gate, and before an irreversible action/);
  assert.match(audit, /Do not record chain-of-thought/);
  assert.match(audit, /Public repository cleanup must leave the private run intact/);
  assert.match(runtime, /required report, and the active private audit receipt/);
  assert.match(orchestrate, /contains no independent decisions/);
  assert.doesNotMatch(orchestrate, /`decisions\.tsv` is the trail/);
});
