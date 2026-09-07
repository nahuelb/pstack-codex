import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gradeParallelism } from "../scripts/grade-parallelism-eval.mjs";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const fixtures = JSON.parse(await read("evals/cases/codex-parallelism.json"));

test("the shared Codex adapter loads the local parallelism policy", async () => {
  const adapterPath = "skills/poteto-mode/references/codex-agent-runtime.md";
  const adapter = await read(adapterPath);
  const link = adapter.match(/\[Codex parallel execution\]\(([^)]+)\)/);
  assert.ok(link);
  const target = new URL(link[1], new URL(adapterPath, root));
  assert.equal(target.href, new URL(fixtures.policy, root).href);
  assert.match(await readFile(target, "utf8"), /^# Codex parallel execution/m);
  const upstream = JSON.parse(await read("upstream.lock.json"));
  assert.equal(upstream.files.some((entry) => [adapterPath, fixtures.policy].includes(entry.path)), false);
  assert.ok((await read("UPSTREAM.md")).includes(fixtures.policy));
});

test("the behavioral grader accepts complete results regardless of dispatch order", () => {
  const answers = fixtures.cases.map(({ id, expected }) => ({ id, ...structuredClone(expected) }));
  answers[0].dispatch.reverse();
  assert.equal(gradeParallelism(fixtures.cases, answers).passed, true);
});

test("the grader rejects unsafe scheduling, stale proof, and premature completion", () => {
  for (const scenario of fixtures.cases) {
    const answers = fixtures.cases.map(({ id, expected }) => ({ id, ...structuredClone(expected) }));
    const answer = answers.find((entry) => entry.id === scenario.id);
    if (answer.blocked.length) answer.dispatch.push(answer.blocked.shift());
    else if (answer.close.length) answer.close = ["Core"];
    else if (scenario.id === "delegation-forbidden") answer.dispatch = ["UI"];
    else if (scenario.id === "no-nested-spawn") answer.coordinator = "subagent";
    else answer.canFinish = !answer.canFinish;
    assert.equal(gradeParallelism(fixtures.cases, answers).passed, false, scenario.id);
  }
});

test("the grader rejects missing, duplicate, unknown, and malformed answers", () => {
  const answers = fixtures.cases.map(({ id, expected }) => ({ id, ...structuredClone(expected) }));
  for (const invalid of [null, [], answers.slice(1), [...answers, answers[0]], [...answers, { id: "unknown" }]]) {
    assert.equal(gradeParallelism(fixtures.cases, invalid).passed, false);
  }
  answers[0].dispatch = "Provider";
  assert.equal(gradeParallelism(fixtures.cases, answers).passed, false);
  assert.equal(gradeParallelism([], []).passed, false);
});

test("stale proof must be invalidated even when dispatch and completion decisions are correct", () => {
  const answers = fixtures.cases.map(({ id, expected }) => ({ id, ...structuredClone(expected) }));
  answers.find((entry) => entry.id === "stale-integration-proof").invalidate = [];
  assert.deepEqual(gradeParallelism(fixtures.cases, answers).failures, ["stale-integration-proof: invalidate"]);
});
