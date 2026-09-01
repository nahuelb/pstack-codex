#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AUDIT_SCHEMA = 1;
export const DECISION_HEADER = "ts\trun_id\tphase\tdecision\twhy\tevidence\tresult\tref";
export const EVENT_HEADER = "ts\trun_id\tactor_id\tparent_actor_id\tevent\tdetail\tevidence\tstate\tref";
export const EVENT_KINDS = new Set([
  "run-start",
  "turn-start",
  "phase",
  "delegate",
  "agent-start",
  "state",
  "wait",
  "timeout",
  "checkpoint",
  "handoff",
  "commit",
  "verification",
  "blocker",
  "review",
  "terminal",
  "session-end",
]);

const SENSITIVE_REFERENCE = /(?:-----BEGIN [^-]*PRIVATE KEY-----|\b(?:authorization|password|secret|token)\s*[:=]\s*\S+|https?:\/\/[^/\s:@]+:[^@\s]+@)/iu;

function requiredValue(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function cleanCell(value, label) {
  const clean = requiredValue(value, label).replace(/[\t\n\r]/gu, " ");
  return /^[=+@-]/u.test(clean) ? `'${clean}` : clean;
}

function safeReference(value, label) {
  const clean = cleanCell(value, label);
  if (SENSITIVE_REFERENCE.test(clean)) {
    throw new Error(`${label} must be a safe path, digest, receipt, or task reference without secrets`);
  }
  return clean;
}

async function writeNew(target, contents) {
  await fs.writeFile(target, contents, { flag: "wx", mode: 0o600 });
}

async function readMetadata(runDirectory) {
  const source = await fs.readFile(path.join(runDirectory, "run.json"), "utf8");
  const metadata = JSON.parse(source);
  if (
    metadata?.schema !== AUDIT_SCHEMA ||
    metadata?.privacy !== "private" ||
    typeof metadata?.run_id !== "string" ||
    metadata.run_id.length === 0 ||
    metadata?.canonical_ledger !== "decisions.tsv" ||
    metadata?.execution_trace !== "events.tsv"
  ) {
    throw new Error(`invalid private audit run at ${runDirectory}`);
  }
  return metadata;
}

async function appendRow(target, header, cells) {
  const handle = await fs.open(target, constants.O_RDWR | constants.O_APPEND);
  try {
    const expected = `${header}\n`;
    const buffer = Buffer.alloc(Buffer.byteLength(expected));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length || buffer.toString("utf8") !== expected) {
      throw new Error(`audit header does not match schema ${AUDIT_SCHEMA}: ${target}`);
    }
    const { size } = await handle.stat();
    const ending = Buffer.alloc(Math.min(2, size));
    await handle.read(ending, 0, ending.length, size - ending.length);
    if (ending.at(-1) !== 0x0a) throw new Error(`audit tail is incomplete: ${target}`);
    if (ending.length === 2 && ending[0] === 0x0a) throw new Error(`audit tail contains a blank row: ${target}`);
    if (size > buffer.length) {
      const tailSize = Math.min(size, 65_536);
      const tail = Buffer.alloc(tailSize);
      await handle.read(tail, 0, tailSize, size - tailSize);
      const rows = tail.toString("utf8").slice(0, -1).split("\n");
      const lastRow = rows.at(-1) ?? "";
      if (lastRow.split("\t").length !== cells.length) {
        throw new Error(`audit tail has an invalid column count: ${target}`);
      }
    }
    const row = Buffer.from(`${cells.join("\t")}\n`);
    let offset = 0;
    while (offset < row.length) {
      const { bytesWritten } = await handle.write(row, offset, row.length - offset);
      if (bytesWritten === 0) throw new Error(`audit write made no progress: ${target}`);
      offset += bytesWritten;
    }
  } finally {
    await handle.close();
  }
}

export async function createAuditRun({
  pluginData,
  parentTaskId,
  projectFingerprint,
  now = Date.now(),
  runId = randomUUID(),
}) {
  requiredValue(pluginData, "plugin data path");
  requiredValue(parentTaskId, "parent task id", 512);
  requiredValue(projectFingerprint, "project fingerprint", 128);
  requiredValue(runId, "run id", 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(runId) || runId.includes("..")) {
    throw new Error("run id must contain only letters, numbers, dots, underscores, and hyphens without traversal");
  }
  const auditsDirectory = path.join(pluginData, "poteto-mode", "audits");
  const runDirectory = path.join(auditsDirectory, runId);
  await fs.mkdir(auditsDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(runDirectory, { mode: 0o700 });
  await fs.chmod(runDirectory, 0o700);
  const metadata = {
    schema: AUDIT_SCHEMA,
    privacy: "private",
    run_id: runId,
    parent_task_id: parentTaskId,
    project_fingerprint: projectFingerprint,
    created_at: new Date(now).toISOString(),
    canonical_ledger: "decisions.tsv",
    execution_trace: "events.tsv",
  };
  await Promise.all([
    writeNew(path.join(runDirectory, "run.json"), `${JSON.stringify(metadata)}\n`),
    writeNew(path.join(runDirectory, "decisions.tsv"), `${DECISION_HEADER}\n`),
    writeNew(path.join(runDirectory, "events.tsv"), `${EVENT_HEADER}\n`),
  ]);
  return { ...metadata, run_directory: runDirectory };
}

export async function appendDecision(runDirectory, row, now = Date.now()) {
  const metadata = await readMetadata(runDirectory);
  await appendRow(path.join(runDirectory, metadata.canonical_ledger), DECISION_HEADER, [
    new Date(now).toISOString(),
    cleanCell(metadata.run_id, "run id"),
    cleanCell(row.phase, "phase"),
    cleanCell(row.decision, "decision"),
    cleanCell(row.why, "why"),
    safeReference(row.evidence, "evidence"),
    cleanCell(row.result, "result"),
    safeReference(row.ref, "reference"),
  ]);
  return metadata;
}

export async function appendEvent(runDirectory, row, now = Date.now()) {
  const metadata = await readMetadata(runDirectory);
  if (!EVENT_KINDS.has(row.event)) {
    throw new Error(`event must be one of: ${[...EVENT_KINDS].join(", ")}`);
  }
  await appendRow(path.join(runDirectory, metadata.execution_trace), EVENT_HEADER, [
    new Date(now).toISOString(),
    cleanCell(metadata.run_id, "run id"),
    cleanCell(row.actorId, "actor id"),
    cleanCell(row.parentActorId, "parent actor id"),
    row.event,
    cleanCell(row.detail, "detail"),
    safeReference(row.evidence, "evidence"),
    cleanCell(row.state, "state"),
    safeReference(row.ref, "reference"),
  ]);
  return metadata;
}

export async function auditStatus(runDirectory) {
  const metadata = await readMetadata(runDirectory);
  const [decisions, events] = await Promise.all([
    fs.readFile(path.join(runDirectory, metadata.canonical_ledger), "utf8"),
    fs.readFile(path.join(runDirectory, metadata.execution_trace), "utf8"),
  ]);
  if (!decisions.startsWith(`${DECISION_HEADER}\n`) || !events.startsWith(`${EVENT_HEADER}\n`)) {
    throw new Error(`audit headers do not match schema ${AUDIT_SCHEMA}`);
  }
  const decisionRows = decisions.trimEnd().split("\n");
  const eventRows = events.trimEnd().split("\n");
  if (!decisions.endsWith("\n") || decisions.endsWith("\n\n") || decisionRows.some((row) => row.split("\t").length !== 8)) {
    throw new Error("decision ledger has invalid row framing");
  }
  if (!events.endsWith("\n") || events.endsWith("\n\n") || eventRows.some((row) => row.split("\t").length !== 9)) {
    throw new Error("execution trace has invalid row framing");
  }
  return {
    run_id: metadata.run_id,
    parent_task_id: metadata.parent_task_id,
    privacy: metadata.privacy,
    ledger: path.join(runDirectory, metadata.canonical_ledger),
    trace: path.join(runDirectory, metadata.execution_trace),
    decisions: Math.max(0, decisionRows.length - 1),
    events: Math.max(0, eventRows.length - 1),
  };
}

export function projectFingerprint(projectDirectory) {
  const directory = requiredValue(projectDirectory, "project directory");
  let identity = path.resolve(directory);
  try {
    const common = execFileSync("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (common) identity = path.resolve(directory, common);
  } catch {}
  return createHash("sha256").update(identity).digest("hex");
}

async function main(argv = process.argv.slice(2)) {
  const [command, runDirectory, ...args] = argv;
  if (command === "init" && (args.length === 2 || args.length === 3)) {
    const created = await createAuditRun({
      pluginData: runDirectory,
      parentTaskId: args[0],
      projectFingerprint: projectFingerprint(args[1]),
      runId: args[2],
    });
    process.stdout.write(`${JSON.stringify(created)}\n`);
    return;
  }
  if (command === "decision" && args.length === 6) {
    await appendDecision(runDirectory, {
      phase: args[0],
      decision: args[1],
      why: args[2],
      evidence: args[3],
      result: args[4],
      ref: args[5],
    });
    return;
  }
  if (command === "event" && args.length === 7) {
    await appendEvent(runDirectory, {
      actorId: args[0],
      parentActorId: args[1],
      event: args[2],
      detail: args[3],
      evidence: args[4],
      state: args[5],
      ref: args[6],
    });
    return;
  }
  if (command === "status" && args.length === 0) {
    process.stdout.write(`${JSON.stringify(await auditStatus(runDirectory))}\n`);
    return;
  }
  throw new Error("usage: audit.mjs init <private-root> <parent-task-id> <project-dir> [run-id] | decision <run-dir> <phase> <decision> <why> <evidence> <result> <ref> | event <run-dir> <actor> <parent> <event> <detail> <evidence> <state> <ref> | status <run-dir>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
