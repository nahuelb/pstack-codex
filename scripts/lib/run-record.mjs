import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const timestamp = () => new Date().toISOString();
const within = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const types = new Set(["run_started", "run_finished", "unit_ready", "unit_started", "unit_finished", "external_wait_started", "external_wait_finished", "integration_finished", "release_finished", "token_usage"]);

export function validateManifest(manifest) {
  requireValue(manifest?.schemaVersion === 1, "Unsupported run schema");
  requireValue(nonempty(manifest.runId) && nonempty(manifest.objective), "Run ID and objective are required");
  requireValue(nonempty(manifest.sourceRoot) && path.isAbsolute(manifest.sourceRoot), "sourceRoot must be absolute");
  requireValue(Number.isFinite(Date.parse(manifest.createdAt)), "createdAt must be a timestamp");
  const groups = {};
  for (const group of ["decisions", "units", "criteria", "checks"]) {
    requireValue(Array.isArray(manifest[group]), `${group} must be an array`);
    groups[group] = new Set();
    for (const entry of manifest[group]) {
      requireValue(nonempty(entry?.id) && !groups[group].has(entry.id), `Invalid or duplicate ${group} ID`);
      groups[group].add(entry.id);
    }
  }
  requireValue(manifest.criteria.length > 0, "At least one acceptance criterion is required");
  const linkedDecisions = new Set();
  const linkedChecks = new Set();
  for (const decision of manifest.decisions) requireValue(nonempty(decision.text), "Decision text is required");
  for (const criterion of manifest.criteria) {
    requireValue(nonempty(criterion.description), "Criterion description is required");
    requireValue(Array.isArray(criterion.decisionIds), "Criterion decisionIds are required");
    requireValue(Array.isArray(criterion.checkIds) && criterion.checkIds.length > 0, "Each criterion needs checks");
    for (const id of criterion.decisionIds) {
      requireValue(groups.decisions.has(id), `Unknown decision: ${id}`);
      linkedDecisions.add(id);
    }
    for (const id of criterion.checkIds) {
      requireValue(groups.checks.has(id), `Unknown check: ${id}`);
      linkedChecks.add(id);
    }
  }
  for (const id of groups.decisions) requireValue(linkedDecisions.has(id), `Decision has no acceptance criterion: ${id}`);
  for (const id of groups.checks) requireValue(linkedChecks.has(id), `Check has no acceptance criterion: ${id}`);
  for (const check of manifest.checks) {
    requireValue(nonempty(check.description), "Check description is required");
    requireValue(Array.isArray(check.sourcePaths) && check.sourcePaths.length > 0, "Check sourcePaths are required");
    for (const source of check.sourcePaths) {
      requireValue(nonempty(source) && !path.isAbsolute(source) && within(path.resolve(manifest.sourceRoot), path.resolve(manifest.sourceRoot, source)), "Check source paths must stay inside sourceRoot");
    }
    if (check.command !== undefined) requireValue(Array.isArray(check.command) && check.command.length > 0 && check.command.every(nonempty), "Command must be a nonempty argv array");
  }
  for (const unit of manifest.units) {
    requireValue(nonempty(unit.title) && Array.isArray(unit.dependsOn), "Unit title and dependsOn are required");
    for (const id of unit.dependsOn) requireValue(groups.units.has(id), `Unknown dependency: ${id}`);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    requireValue(!visiting.has(id), `Cyclic unit dependency: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of manifest.units.find((unit) => unit.id === id).dependsOn) visit(next);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of groups.units) visit(id);
  if (manifest.benchmark) requireValue(nonempty(manifest.benchmark.caseId) && nonempty(manifest.benchmark.environment) && Array.isArray(manifest.benchmark.models) && manifest.benchmark.models.length > 0 && manifest.benchmark.models.every(nonempty), "Benchmark needs caseId, environment and models");
  return manifest;
}

export async function readRun(runDir) {
  const manifest = validateManifest(JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")));
  const lines = (await readFile(path.join(runDir, "events.jsonl"), "utf8")).split("\n").filter(Boolean);
  const events = lines.map((line) => JSON.parse(line));
  const ids = new Set();
  for (const event of events) {
    requireValue(nonempty(event.id) && !ids.has(event.id), "Duplicate or missing event ID");
    requireValue(Number.isFinite(Date.parse(event.at)), "Event timestamp is invalid");
    ids.add(event.id);
  }
  return { manifest, events };
}

async function withLock(runDir, work) {
  const lock = path.join(runDir, ".write-lock");
  try { await mkdir(lock); } catch (error) {
    if (error.code === "EEXIST") throw new Error("Run record is being written; retry after the writer finishes");
    throw error;
  }
  try { return await work(); } finally { await rm(lock, { recursive: true }); }
}

export async function initializeRun(runDir, manifest) {
  validateManifest(manifest);
  const sourceRoot = await realpath(manifest.sourceRoot);
  const outputParent = await realpath(path.dirname(path.resolve(runDir)));
  requireValue(!within(sourceRoot, path.join(outputParent, path.basename(runDir))), "Store run records outside the source checkout");
  await mkdir(runDir, { mode: 0o700 });
  try {
    await writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify({ ...manifest, sourceRoot }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(runDir, "events.jsonl"), "", { flag: "wx", mode: 0o600 });
    await mkdir(path.join(runDir, "proof"), { mode: 0o700 });
  } catch (error) { await rm(runDir, { recursive: true }); throw error; }
}

function validateEvent(event, manifest) {
  requireValue(types.has(event.type), `Unsupported event type: ${event.type}`);
  if (event.type.startsWith("unit_")) requireValue(manifest.units.some((unit) => unit.id === event.unitId), "Event needs a known unitId");
  if (event.type.startsWith("external_wait_")) requireValue(nonempty(event.waitId), "External wait needs waitId");
  if (event.actor) requireValue(nonempty(event.actor.threadId) && ["main", "subagent"].includes(event.actor.kind), "Actor needs threadId and main/subagent kind");
  if (event.type === "token_usage") {
    requireValue(event.actor && nonempty(event.source) && event.usage && Object.hasOwn(event.usage, "totalTokens"), "Usage needs an actor, source and cumulative totalTokens (null if unavailable)");
    for (const field of ["totalTokens", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens"]) {
      const value = event.usage[field];
      requireValue(value === undefined || value === null || (Number.isSafeInteger(value) && value >= 0), `Invalid usage: ${field}`);
    }
  }
}

async function record(runDir, input, internal = false) {
  return withLock(runDir, async () => {
    const { manifest, events } = await readRun(runDir);
    if (!internal) validateEvent(input, manifest);
    const event = { ...input, id: input.id ?? randomUUID(), at: input.at ?? timestamp(), recordedAt: timestamp() };
    requireValue(nonempty(event.id) && !events.some((entry) => entry.id === event.id), "Duplicate or invalid event ID");
    requireValue(Number.isFinite(Date.parse(event.at)), "Invalid event timestamp");
    await appendFile(path.join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
    return event;
  });
}

export const appendEvent = (runDir, event) => record(runDir, event);

async function sourceHash(manifest, check) {
  const root = await realpath(manifest.sourceRoot);
  const entries = new Map();
  async function walk(target) {
    const relative = path.relative(root, target) || ".";
    const info = await lstat(target);
    requireValue(!info.isSymbolicLink(), `Source proof does not follow symlinks: ${relative}`);
    requireValue(within(root, await realpath(target)), `Source path escapes checkout: ${relative}`);
    if (info.isDirectory()) {
      entries.set(relative, "directory");
      for (const name of (await readdir(target)).sort()) {
        if (name !== ".git" && name !== "node_modules") await walk(path.join(target, name));
      }
    } else {
      requireValue(info.isFile(), `Source path is not a regular file: ${relative}`);
      entries.set(relative, `${info.mode & 0o111}:${digest(await readFile(target))}`);
    }
  }
  for (const source of check.sourcePaths) await walk(path.resolve(root, source));
  return digest(JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b))));
}

const manifestHash = (manifest) => digest(JSON.stringify(manifest));

async function prepareCheck(runDir, checkId) {
  const { manifest } = await readRun(runDir);
  const check = manifest.checks.find((entry) => entry.id === checkId);
  requireValue(check, `Unknown check: ${checkId}`);
  return { manifest, check, before: await sourceHash(manifest, check) };
}

async function finishCheck(runDir, prepared, receipt) {
  const { manifest, check, before } = prepared;
  const current = await readRun(runDir);
  const after = await sourceHash(manifest, check).catch(() => null);
  const result = {
    ...receipt, checkId: check.id, finishedAt: timestamp(), manifestHash: manifestHash(manifest),
    sourceHash: before, sourceHashAfter: after, artifactHash: digest(await readFile(receipt.artifact)),
    status: before === after && manifestHash(current.manifest) === manifestHash(manifest) ? receipt.status : "stale",
  };
  await record(runDir, { type: "check_recorded", at: result.finishedAt, receipt: result }, true);
  return result;
}

export async function runCheck(runDir, checkId, actor) {
  const prepared = await prepareCheck(runDir, checkId);
  requireValue(prepared.check.command, "This check requires an attached reviewed artifact");
  const id = randomUUID();
  const artifact = path.resolve(runDir, "proof", `${id}.log`);
  const startedAt = timestamp();
  const stream = createWriteStream(artifact, { flags: "wx", mode: 0o600 });
  const exitCode = await new Promise((resolve, reject) => {
    stream.once("error", reject);
    const process = spawn(prepared.check.command[0], prepared.check.command.slice(1), { cwd: prepared.manifest.sourceRoot, stdio: ["ignore", "pipe", "pipe"], shell: false });
    process.stdout.pipe(stream, { end: false });
    process.stderr.pipe(stream, { end: false });
    process.once("error", (error) => { stream.write(`${error.message}\n`); });
    process.once("close", (code) => stream.end(() => resolve(code)));
  });
  return finishCheck(runDir, prepared, { id, startedAt, status: exitCode === 0 ? "passed" : "failed", origin: "command", exitCode, artifact, summary: prepared.check.description, ...(actor ? { actor } : {}) });
}

export async function attachProof(runDir, checkId, { artifact, verdict, summary, actor }) {
  requireValue(["passed", "failed"].includes(verdict) && nonempty(summary), "Reviewed proof needs a verdict and summary");
  const prepared = await prepareCheck(runDir, checkId);
  requireValue(path.isAbsolute(artifact) && (await lstat(artifact)).isFile(), "Proof artifact must be an absolute regular file");
  return finishCheck(runDir, prepared, { id: randomUUID(), startedAt: timestamp(), status: verdict, origin: "reviewed-artifact", exitCode: null, artifact, summary, ...(actor ? { actor } : {}) });
}

export async function evaluateRun(runDir) {
  const { manifest, events } = await readRun(runDir);
  const checks = [];
  for (const check of manifest.checks) {
    const receipt = events.filter((event) => event.type === "check_recorded" && event.receipt?.checkId === check.id).at(-1)?.receipt;
    let status = "missing";
    let reason = "No verification receipt";
    if (receipt) {
      const current = await sourceHash(manifest, check).catch(() => null);
      const proofHash = await readFile(receipt.artifact).then(digest).catch(() => null);
      const fresh = current !== null && proofHash !== null && receipt.manifestHash === manifestHash(manifest)
        && receipt.sourceHash === current && receipt.sourceHashAfter === current && receipt.artifactHash === proofHash;
      status = fresh && ["passed", "failed"].includes(receipt.status) ? receipt.status : "stale";
      reason = status === "stale" ? "Manifest, relevant source or proof changed; rerun the check" : receipt.summary;
    }
    checks.push({ ...check, status, reason, ...(receipt ? { receipt } : {}) });
  }
  const criteria = manifest.criteria.map((criterion) => ({ ...criterion, status: criterion.checkIds.every((id) => checks.find((check) => check.id === id).status === "passed") ? "passed" : "blocked" }));
  return { manifest, events, checks, criteria, acceptanceComplete: criteria.every((criterion) => criterion.status === "passed") };
}
