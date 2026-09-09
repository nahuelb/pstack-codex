import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gradeParallelism } from "./grade-parallelism-eval.mjs";

const cases = JSON.parse(await readFile(new URL("../evals/cases/workflow-efficiency.json", import.meta.url), "utf8")).cases;

export const gradeWorkflow = (answers) => gradeParallelism(cases, answers);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = process.argv[2];
    if (!input || process.argv.length !== 3) throw new Error("usage: node scripts/grade-workflow-eval.mjs <answers.json|--inputs>");
    const result = input === "--inputs"
      ? cases.map(({ id, scenario }) => ({ id, scenario }))
      : gradeWorkflow(JSON.parse(await readFile(input, "utf8")));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.passed === false) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
