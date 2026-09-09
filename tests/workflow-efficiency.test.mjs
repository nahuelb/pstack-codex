import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gradeWorkflow } from "../scripts/grade-workflow-eval.mjs";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const cases = JSON.parse(await read("evals/cases/workflow-efficiency.json")).cases;

test("runtime and automatic audit paths load the same local evidence policy", async () => {
  for (const file of ["skills/poteto-mode/references/codex-agent-runtime.md", "skills/figure-it-out/SKILL.md", "skills/show-me-your-work/SKILL.md"]) {
    const text = await read(file);
    const link = text.match(/\[Codex run evidence\]\(([^)]+)\)/);
    assert.ok(link, file);
    assert.equal(new URL(link[1], new URL(file, root)).href, new URL("skills/poteto-mode/references/codex-run-evidence.md", root).href);
  }
  const pr = await read("skills/poteto-mode/playbooks/opening-a-pr.md");
  assert.ok(pr.includes("codex-delivery-flow.md"));
  assert.ok(!pr.includes("only when the user asks for one after the whole stack exists"));
});

test("workflow grader rejects each previously observed inefficient or unsafe choice", () => {
  const good = cases.map(({ id, expected }) => ({ id, ...expected }));
  assert.equal(gradeWorkflow(good).passed, true);
  for (const scenario of cases) {
    const answers = structuredClone(good);
    answers.find(({ id }) => id === scenario.id).actions = [];
    assert.equal(gradeWorkflow(answers).passed, false, scenario.id);
  }
  assert.equal(gradeWorkflow([...good, good[0]]).passed, false);
});
