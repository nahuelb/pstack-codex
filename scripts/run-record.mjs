import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, attachProof, evaluateRun, initializeRun, runCheck } from "./lib/run-record.mjs";

export async function main(args) {
  const [operation, runDir, input, extra] = args;
  if (!runDir || extra) throw new Error("usage: run-record.mjs init <run-dir> <manifest.json> | event <run-dir> <event.json> | verify <run-dir> <check-id> | attach <run-dir> <proof.json> | status <run-dir>");
  const read = async () => JSON.parse(await readFile(input, "utf8"));
  if (operation === "init") { await initializeRun(runDir, await read()); return { initialized: path.resolve(runDir) }; }
  if (operation === "event") return appendEvent(runDir, await read());
  if (operation === "verify") return runCheck(runDir, input);
  if (operation === "attach") { const { checkId, ...proof } = await read(); return attachProof(runDir, checkId, proof); }
  if (operation === "status" && !input) return evaluateRun(runDir);
  throw new Error("Unknown operation or unexpected arguments");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "failed" || result.status === "stale" || result.acceptanceComplete === false) process.exitCode = 1;
  }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
