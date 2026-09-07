import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function gradeParallelism(cases, answers) {
  const failures = [];
  if (!Array.isArray(cases) || cases.length === 0) return { passed: false, failures: ["cases must not be empty"] };
  if (!Array.isArray(answers)) return { passed: false, failures: ["answers must be an array"] };
  const seen = new Set();
  for (const answer of answers) {
    const scenario = cases.find((entry) => entry.id === answer?.id);
    if (!scenario || seen.has(answer.id)) {
      failures.push(`unknown or duplicate case: ${answer?.id}`);
      continue;
    }
    seen.add(answer.id);
    for (const [key, expected] of Object.entries(scenario.expected)) {
      const actual = answer[key];
      const matches = Array.isArray(expected)
        ? Array.isArray(actual) && actual.every((value) => typeof value === "string")
          && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
        : actual === expected;
      if (!matches) failures.push(`${answer.id}: ${key}`);
    }
  }
  for (const scenario of cases) {
    if (!seen.has(scenario.id)) failures.push(`missing case: ${scenario.id}`);
  }
  return { passed: failures.length === 0, cases: cases.length, failures };
}

async function main(answerPath) {
  if (!answerPath) throw new Error("usage: node scripts/grade-parallelism-eval.mjs <answers.json|--inputs>");
  const fixtures = JSON.parse(await readFile(new URL("../evals/cases/codex-parallelism.json", import.meta.url), "utf8"));
  if (answerPath === "--inputs") {
    process.stdout.write(`${JSON.stringify(fixtures.cases.map(({ id, scenario }) => ({ id, scenario })), null, 2)}\n`);
    return;
  }
  const result = gradeParallelism(fixtures.cases, JSON.parse(await readFile(answerPath, "utf8")));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
