import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRecord, transition, validateRecord, assignmentStatus, assignmentBrief } from "../scripts/lib/assignment-record.mjs";

const spec = (id, overrides = {}) => ({
  id, owner: `${id}-agent`, goal: `Implement ${id}`, verification: `Run ${id} behavioral checks`,
  stopCondition: "Return result and evidence after focused checks",
  sourcePaths: [`/work/${id}/src`], buildPaths: [`/build/${id}`], provides: [], requires: [], ...overrides,
});
const producer = () => spec("api", { provides: [{ name: "response-v1", description: "GET /items returns {items: [{id: string}]}" }] });
const consumer = () => spec("ui", { requires: [{ assignmentId: "api", revision: 1, contract: "response-v1" }] });
const initial = () => createRecord({ maxActive: 2, assignments: [producer(), consumer()] });
const send = (record, assignmentId, type, fields = {}) => transition(record, {
  type, assignmentId, revision: record.assignments.find((entry) => entry.id === assignmentId).revision, ...fields,
});
const ready = () => send(send(initial(), "api", "start"), "api", "ready", { contract: "response-v1", evidence: "schema.json at tree abc; fixture passes" });
const report = (record, id) => send(record, id, "result", { summary: "Implementation and focused checks complete", evidence: "check output at tree abc" });
const accept = (record, id) => send(record, id, "accept", { actor: "main", evidence: "Main agent inspected implementation and check output" });

function completed() {
  let record = ready();
  record = send(record, "ui", "start");
  record = accept(report(record, "ui"), "ui");
  return accept(report(record, "api"), "api");
}

test("specific ready contract starts isolated consumer before producer behavior proof", () => {
  assert.equal(assignmentStatus(initial(), "ui").canStart, false);
  assert.throws(() => send(initial(), "ui", "start"), /contracts are not ready/);
  const record = ready();
  assert.equal(record.assignments[0].result, null);
  assert.equal(assignmentStatus(record, "ui").canStart, true);
  assert.equal(send(record, "ui", "start").assignments[1].state, "working");
  assert.equal(record.assignments[1].state, "queued", "transition does not mutate its input");
});

test("consumer acceptance does not bypass producer integration gate", () => {
  const record = accept(report(send(ready(), "ui", "start"), "ui"), "ui");
  assert.equal(assignmentStatus(record, "ui").canIntegrate, false);
  assert.deepEqual(assignmentStatus(record, "ui").integrationBlockers, ["Acceptance required: api@1"]);
  assert.equal(assignmentStatus(accept(report(record, "api"), "api"), "ui").canIntegrate, true);
});

test("unrelated contract readiness cannot satisfy a required contract", () => {
  const api = producer();
  api.provides.push({ name: "errors-v1", description: "Error response format" });
  let record = createRecord({ maxActive: 2, assignments: [api, consumer()] });
  record = send(send(record, "api", "start"), "api", "ready", { contract: "errors-v1", evidence: "error schema" });
  assert.equal(assignmentStatus(record, "ui").canStart, false);
  assert.throws(() => report(record, "api"), /all provided contracts/);
});

test("bounds concurrent work and releases capacity on report", () => {
  let record = createRecord({ maxActive: 1, assignments: [spec("a"), spec("b")] });
  record = send(record, "a", "start");
  assert.equal(assignmentStatus(record, "b").canStart, false);
  assert.throws(() => send(record, "b", "start"), /limit reached/);
  record = report(record, "a");
  assert.equal(assignmentStatus(record, "b").canStart, true);
});

test("rejects overlapping source, build, and cross-category ownership", () => {
  for (const override of [
    { sourcePaths: ["/work/a/src/nested"] }, { buildPaths: ["/build/a"] },
    { buildPaths: ["/work/a/src/generated"] }, { sourcePaths: ["/"] },
  ]) assert.throws(() => createRecord({ maxActive: 2, assignments: [spec("a"), spec("b", override)] }), /Ownership conflict/);
  assert.doesNotThrow(() => createRecord({ maxActive: 2, assignments: [spec("a"), spec("b", { sourcePaths: ["/work/a/src-other"] })] }));
});

test("rejects ambiguous paths, unknown references, duplicate IDs, and cycles", () => {
  for (const value of ["relative", "/a/../b", "/a/", "/a/*", "/a\\b"]) {
    assert.throws(() => createRecord({ maxActive: 1, assignments: [spec("a", { sourcePaths: [value] })] }), /canonical absolute/);
  }
  assert.throws(() => createRecord({ maxActive: 1, assignments: [consumer()] }), /Unknown assignment/);
  assert.throws(() => createRecord({ maxActive: 2, assignments: [producer(), producer()] }), /Duplicate assignment/);
  const api = producer();
  api.requires = [{ assignmentId: "ui", revision: 1, contract: "view" }];
  const ui = consumer();
  ui.provides = [{ name: "view", description: "View contract" }];
  assert.throws(() => createRecord({ maxActive: 2, assignments: [api, ui] }), /cycle/);
  ui.requires[0].contract = "missing";
  assert.throws(() => createRecord({ maxActive: 2, assignments: [producer(), ui] }), /Unknown contract/);
});

test("late acknowledgement preserves authoritative result and acceptance", () => {
  const record = completed();
  const acknowledged = send(record, "api", "acknowledge");
  assert.deepEqual(acknowledged.assignments[0].result, record.assignments[0].result);
  assert.deepEqual(acknowledged.assignments[0].acceptance, record.assignments[0].acceptance);
  assert.equal(acknowledged.assignments[0].state, "accepted");
  assert.throws(() => send(acknowledged, "api", "acknowledge"), /unacknowledged/);
  assert.throws(() => send(initial(), "api", "acknowledge"), /started/);
});

test("revisions invalidate readiness, results, acceptance and transitive consumers", () => {
  let record;
  const downstream = spec("docs", { requires: [{ assignmentId: "ui", revision: 1, contract: "view" }] });
  const ui = consumer();
  ui.provides = [{ name: "view", description: "Rendered view contract" }];
  record = createRecord({ maxActive: 3, assignments: [producer(), ui, downstream] });
  record = send(send(record, "api", "start"), "api", "ready", { contract: "response-v1", evidence: "schema" });
  record = send(send(record, "ui", "start"), "ui", "ready", { contract: "view", evidence: "view fixture" });
  record = accept(report(send(record, "docs", "start"), "docs"), "docs");
  record = accept(report(record, "ui"), "ui");
  record = accept(report(record, "api"), "api");
  const revised = send(record, "api", "revise", { spec: producer() });
  for (const assignment of revised.assignments) {
    assert.equal(assignment.revision, 2);
    assert.equal(assignment.state, "queued");
    assert.equal(assignment.result, null);
    assert.equal(assignment.acceptance, null);
    assert.deepEqual(assignment.ready, []);
  }
  assert.equal(assignmentStatus(revised, "docs").canIntegrate, false);
  assert.match(assignmentStatus(revised, "docs").startBlockers.join(" "), /Stale dependency/);
  assert.throws(() => transition(revised, { type: "result", assignmentId: "docs", revision: 1, summary: "late", evidence: "old" }), /Stale revision/);
});

test("new producer readiness cannot satisfy an old dependency pin", () => {
  let record = send(completed(), "api", "revise", { spec: producer() });
  record = send(send(record, "api", "start"), "api", "ready", { contract: "response-v1", evidence: "schema revision 2" });
  assert.equal(assignmentStatus(record, "ui").canStart, false);
  const required = assignmentBrief(record, "ui").requiredContracts[0];
  assert.equal(required.description, null);
  assert.equal(required.evidence, null);
  assert.throws(() => send(record, "api", "acknowledge", { revision: 1 }), /Stale revision/);
  const ui = consumer();
  ui.requires[0].revision = 2;
  record = send(record, "ui", "revise", { spec: ui });
  assert.equal(record.assignments[1].revision, 3);
  assert.equal(assignmentStatus(record, "ui").canStart, true);
  assert.equal(assignmentStatus(record, "ui").canIntegrate, false);
});

test("stale events and out-of-order transitions fail without changing record", () => {
  const record = ready();
  const before = structuredClone(record);
  for (const type of ["result", "acknowledge", "ready", "accept", "revise", "start"]) {
    assert.throws(() => send(record, "api", type, { revision: 2 }), /Stale revision/);
  }
  assert.throws(() => send(record, "api", "start"), /Only queued/);
  assert.throws(() => send(record, "api", "accept", { actor: "main", evidence: "yes" }), /reported result/);
  assert.throws(() => send(record, "api", "ready", { contract: "response-v1", evidence: "different" }), /already ready/);
  const reported = report(record, "api");
  assert.throws(() => report(reported, "api"), /working state/);
  assert.throws(() => send(reported, "api", "accept", { actor: "api-agent", evidence: "self approval" }), /main agent/);
  assert.deepEqual(record, before);
});

test("rejection invalidates consumers and requires revision before replacement result", () => {
  let record = accept(report(send(ready(), "ui", "start"), "ui"), "ui");
  record = send(report(record, "api"), "api", "reject", { actor: "main", evidence: "Behavior check failed" });
  assert.equal(record.assignments[1].revision, 2);
  assert.equal(record.assignments[1].result, null);
  assert.equal(assignmentStatus(record, "ui").canStart, false);
  assert.throws(() => report(record, "api"), /working state/);
});

test("brief and status share revision and authoritative state without mutable aliases", () => {
  const record = ready();
  const brief = assignmentBrief(record, "ui");
  assert.deepEqual(brief.status, assignmentStatus(record, "ui"));
  assert.equal(brief.requiredContracts[0].evidence, "schema.json at tree abc; fixture passes");
  assert.deepEqual(brief.forbiddenPaths, ["/work/api/src", "/build/api"]);
  brief.sourcePaths.push("/unexpected");
  assert.deepEqual(record.assignments[1].sourcePaths, ["/work/ui/src"]);
});

test("record validation rejects malformed results, capacity and dependency states", () => {
  const record = completed();
  record.assignments[0].result.revision = 0;
  assert.throws(() => validateRecord(record), /Result must match/);
  assert.throws(() => createRecord({ maxActive: 0, assignments: [] }), /positive maxActive/);
  const unavailable = send(ready(), "ui", "start");
  unavailable.assignments[0].ready = [];
  assert.throws(() => validateRecord(unavailable), /unavailable dependencies/);
});

const cli = (command, input, ...args) => spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/assignment-record.mjs", import.meta.url)), command, ...args], { input: JSON.stringify(input), encoding: "utf8" });

test("JSON CLI initializes, transitions and renders the same record", () => {
  const initialized = cli("init", { maxActive: 2, assignments: [producer(), consumer()] });
  assert.equal(initialized.status, 0, initialized.stderr);
  const record = JSON.parse(initialized.stdout);
  const applied = cli("apply", { record, event: { type: "start", assignmentId: "api", revision: 1 } });
  assert.equal(applied.status, 0, applied.stderr);
  const next = JSON.parse(applied.stdout);
  assert.deepEqual(JSON.parse(cli("status", next, "api").stdout), assignmentStatus(next, "api"));
  assert.deepEqual(JSON.parse(cli("brief", next, "api").stdout), assignmentBrief(next, "api"));
  assert.equal(JSON.parse(cli("status", next).stdout).length, 2);
  assert.deepEqual(JSON.parse(cli("validate", next).stdout), next);
});

test("JSON CLI errors emit no replacement record", () => {
  for (const response of [cli("apply", { record: initial(), event: { type: "result", assignmentId: "api", revision: 1 } }), cli("brief", initial()), cli("init", {}, "unexpected"), cli("unknown", {})]) {
    assert.equal(response.status, 1);
    assert.equal(response.stdout, "");
    assert.equal(typeof JSON.parse(response.stderr).error, "string");
  }
});


test("blocked results retain partial evidence without inventing contract readiness", () => {
  let record = send(initial(), "api", "start");
  record = send(record, "api", "result", { outcome: "blocked", summary: "Required runtime unavailable", evidence: "tool capability receipt" });
  assert.equal(assignmentStatus(record, "api").result.outcome, "blocked");
  assert.equal(assignmentStatus(record, "ui").canStart, false);
  assert.throws(() => accept(record, "api"), /Cannot accept blocked/);
  record = send(record, "api", "reject", { actor: "main", evidence: "Missing runtime is confirmed" });
  assert.equal(assignmentStatus(record, "api").canIntegrate, false);
});
