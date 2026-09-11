import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, lstat, mkdir, readFile, opendir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const timestamp = () => new Date().toISOString();
const within = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hashObject = (value) => digest(canonical(value));
const validTimestamp = (value) => nonempty(value) && Number.isFinite(Date.parse(value))
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && new Date(`${value.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) === value.slice(0, 10);
export const createManifest = (input) => validateManifest({ schemaVersion: 1, ...structuredClone(input), ...(Object.hasOwn(input, "createdAt") ? {} : { createdAt: timestamp() }) });
const types = new Set(["run_started", "run_finished", "unit_ready", "unit_started", "unit_finished", "external_wait_started", "external_wait_finished", "integration_finished", "release_finished", "token_usage"]);

export function validateManifest(manifest) {
  requireValue(manifest?.schemaVersion === 1, "Unsupported run schema");
  requireValue(nonempty(manifest.runId) && nonempty(manifest.objective), "Run ID and objective are required");
  requireValue(nonempty(manifest.sourceRoot) && path.isAbsolute(manifest.sourceRoot), "sourceRoot must be absolute");
  requireValue(validTimestamp(manifest.createdAt), "createdAt must be a timestamp");
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
    if (check.proof !== undefined) {
      requireValue(check.proof && Array.isArray(check.proof.inputPaths) && check.proof.inputPaths.length > 0, "Proof inputPaths must declare the harness and inputs");
      requireValue(Array.isArray(check.proof.milestones) && check.proof.milestones.length > 0 && check.proof.milestones.every(nonempty) && new Set(check.proof.milestones).size === check.proof.milestones.length, "Proof milestones must be unique nonempty output lines");
      requireValue(check.proof.milestones.every((line) => !/[\r\n]/.test(line)), "Milestones must be single lines");
    }
    if (check.cwd !== undefined) requireValue(nonempty(check.cwd) && path.isAbsolute(check.cwd), "Check cwd must be absolute");
    if (check.environment !== undefined) requireValue(check.environment && typeof check.environment === "object" && !Array.isArray(check.environment) && Object.values(check.environment).every((value) => typeof value === "string" || value === null), "Environment expectations must be strings or null");
    if (check.preflight !== undefined) requireValue(Array.isArray(check.preflight) && check.preflight.every((hook) => hook && Array.isArray(hook.command) && hook.command.length > 0 && hook.command.every(nonempty) && typeof hook.expectedStdout === "string"), "Preflight needs command argv and exact expectedStdout");
    for (const source of [...check.sourcePaths, ...(check.proof?.inputPaths ?? [])]) {
      requireValue(nonempty(source) && !path.isAbsolute(source) && within(path.resolve(manifest.sourceRoot), path.resolve(manifest.sourceRoot, source)), "Check source paths must stay inside sourceRoot");
    }
    for (const field of ["maxInputBytes", "maxInputFiles", "maxInputEntries"]) if (check[field] !== undefined) requireValue(Number.isSafeInteger(check[field]) && check[field] > 0, `${field} must be a positive safe integer`);
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
  manifest = createManifest(manifest);
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

async function sourceSnapshot(manifest, check) {
  const root = await realpath(manifest.sourceRoot);
  const entries = new Map();
  let inputBytes = 0;
  let inputFiles = 0;
  async function walk(target) {
    const relative = path.relative(root, target) || ".";
    if (entries.has(relative)) return;
    requireValue(entries.size < (check.maxInputEntries ?? 20000), "Input snapshot exceeds maxInputEntries; narrow declared inputs or set an explicit budget");
    const info = await lstat(target);
    requireValue(!info.isSymbolicLink(), `Source proof does not follow symlinks: ${relative}`);
    requireValue(within(root, await realpath(target)), `Source path escapes checkout: ${relative}`);
    if (info.isDirectory()) {
      entries.set(relative, { path: relative, type: "directory" });
      for await (const { name } of await opendir(target)) {
        if (name !== ".git" && name !== "node_modules") await walk(path.join(target, name));
      }
    } else {
      requireValue(info.isFile(), `Source path is not a regular file: ${relative}`);
      inputFiles += 1;
      requireValue(inputFiles <= (check.maxInputFiles ?? 10000), "Input snapshot exceeds maxInputFiles; narrow declared inputs or set an explicit budget");
      requireValue(inputBytes + info.size <= (check.maxInputBytes ?? 16 * 1024 * 1024), "Input snapshot exceeds maxInputBytes; narrow declared inputs or set an explicit budget");
      const bytes = await readFile(target);
      inputBytes += bytes.length;
      requireValue(inputBytes <= (check.maxInputBytes ?? 16 * 1024 * 1024), "Input snapshot grew beyond maxInputBytes");
      entries.set(relative, { path: relative, type: "file", executable: info.mode & 0o111, sha256: digest(bytes), base64: bytes.toString("base64") });
    }
  }
  for (const source of [...check.sourcePaths, ...(check.proof?.inputPaths ?? [])]) await walk(path.resolve(root, source));
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function contract(manifest, check) {
  const criteria = manifest.criteria.filter((entry) => entry.checkIds.includes(check.id)).map(({ status, metadata, checkIds, ...criterion }) => criterion);
  const decisions = manifest.decisions.filter((entry) => criteria.some((criterion) => criterion.decisionIds.includes(entry.id))).map(({ status, metadata, ...decision }) => decision);
  const { status, metadata, ...definition } = check;
  return { runId: manifest.runId, sourceRoot: manifest.sourceRoot, check: definition, criteria, decisions };
}

async function executionCwd(manifest, check) {
  const root = await realpath(manifest.sourceRoot);
  const cwd = await realpath(check.cwd ?? manifest.sourceRoot);
  requireValue(cwd === root, "Check cwd must resolve to the exact sourceRoot checkout");
  return cwd;
}

function environmentMatches(check, environment = process.env) {
  return Object.entries(check.environment ?? {}).every(([key, expected]) => (environment[key] ?? null) === expected);
}

async function prepareCheck(runDir, checkId) {
  const { manifest } = await readRun(runDir);
  const check = manifest.checks.find((entry) => entry.id === checkId);
  requireValue(check, `Unknown check: ${checkId}`);
  const cwd = await executionCwd(manifest, check);
  const environment = { ...process.env };
  requireValue(environmentMatches(check, environment), "Execution environment does not match declared expectations");
  const inputs = await sourceSnapshot(manifest, check);
  const binding = contract(manifest, check);
  const id = randomUUID();
  const snapshot = path.resolve(runDir, "proof", `${id}.inputs.json.gz`);
  const payload = gzipSync(canonical({ schemaVersion: 2, id, cwd, contract: binding, inputs }));
  await writeFile(snapshot, payload, { flag: "wx", mode: 0o600 });
  return { manifest, check, cwd, id, snapshot, snapshotHash: digest(payload), before: hashObject(inputs), contractHash: hashObject(binding), environment };
}

function observedMilestones(check, output) {
  const lines = output.split(/\r?\n/);
  let cursor = 0;
  const observed = [];
  for (const milestone of check.proof?.milestones ?? []) {
    const index = lines.indexOf(milestone, cursor);
    if (index === -1) break;
    observed.push(milestone);
    cursor = index + 1;
  }
  return observed;
}

async function finishCheck(runDir, prepared, receipt) {
  const { manifest, check, before } = prepared;
  const current = await readRun(runDir);
  const currentCheck = current.manifest.checks.find((entry) => entry.id === check.id);
  const after = await sourceSnapshot(manifest, check).then(hashObject).catch(() => null);
  const output = await readFile(receipt.artifact);
  const observed = observedMilestones(check, output.toString("utf8"));
  const complete = observed.length === (check.proof?.milestones.length ?? 0);
  const snapshotHash = await readFile(prepared.snapshot).then(digest).catch(() => null);
  const originalHash = receipt.originalArtifact ? await readFile(receipt.originalArtifact).then(digest).catch(() => null) : digest(output);
  const result = {
    ...receipt, schemaVersion: 2, checkId: check.id, finishedAt: timestamp(),
    contractHash: prepared.contractHash, snapshot: prepared.snapshot, snapshotHash: prepared.snapshotHash,
    cwd: prepared.cwd, observedMilestones: observed,
    sourceHash: before, sourceHashAfter: after, artifactHash: digest(output),
    status: snapshotHash === prepared.snapshotHash && originalHash === digest(output) && before === after && currentCheck && hashObject(contract(current.manifest, currentCheck)) === prepared.contractHash
      ? (complete ? receipt.status : "failed") : "stale",
  };
  await record(runDir, { type: "check_recorded", at: result.finishedAt, receipt: result }, true);
  return result;
}

async function execute(command, cwd, env, artifact, expectedStdout) {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(artifact, { flags: "wx", mode: 0o600 });
    let stdout = "";
    let stdoutLength = 0;
    const limit = expectedStdout === undefined ? 0 : expectedStdout.length + 1;
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
    stream.once("error", (error) => { child.kill(); reject(error); });
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (limit) {
        const text = chunk.toString("utf8");
        stdoutLength += text.length;
        if (stdout.length < limit) stdout += text.slice(0, limit - stdout.length);
      }
    });
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.once("error", (error) => { stream.write(`${error.message}\n`); });
    child.once("close", (exitCode, signal) => stream.end(() => resolve({ exitCode, signal, stdout,
      stdoutMatches: expectedStdout === undefined || (stdoutLength === expectedStdout.length && stdout === expectedStdout), artifact })));
  });
}

export async function runCheck(runDir, checkId, actor) {
  actor = structuredClone(actor);
  const prepared = await prepareCheck(runDir, checkId);
  requireValue(prepared.check.command, "This check requires an attached reviewed artifact");
  const artifact = path.resolve(runDir, "proof", `${prepared.id}.log`);
  const startedAt = timestamp();
  const preflight = [];
  let result;
  for (const [index, hook] of (prepared.check.preflight ?? []).entries()) {
    const observation = await execute(hook.command, prepared.cwd, prepared.environment, path.resolve(runDir, "proof", `${prepared.id}.preflight-${index}.log`), hook.expectedStdout);
    preflight.push({ ...observation, command: hook.command });
    if (observation.exitCode !== 0 || !observation.stdoutMatches) {
      result = { exitCode: observation.exitCode, signal: observation.signal, output: "Preflight failed; check was not executed\n" };
      break;
    }
  }
  if (!result && (await sourceSnapshot(prepared.manifest, prepared.check).then(hashObject).catch(() => null)) !== prepared.before) {
    result = { exitCode: null, signal: null, output: "Source changed during preflight; check was not executed\n" };
  }
  const executed = !result;
  if (result) await writeFile(artifact, result.output, { flag: "wx", mode: 0o600 });
  else result = await execute(prepared.check.command, prepared.cwd, prepared.environment, artifact);
  return finishCheck(runDir, prepared, { id: prepared.id, startedAt, status: executed && result.exitCode === 0 ? "passed" : "failed", origin: "command", exitCode: result.exitCode, signal: result.signal, executed, preflight, artifact, summary: prepared.check.description, ...(actor ? { actor } : {}) });
}

export async function attachProof(runDir, checkId, { artifact, verdict, summary, actor }) {
  actor = structuredClone(actor);
  requireValue(["passed", "failed"].includes(verdict) && nonempty(summary), "Reviewed proof needs a verdict and summary");
  const prepared = await prepareCheck(runDir, checkId);
  requireValue(!prepared.check.proof && !prepared.check.preflight?.length, "Declared proof or preflight requires command execution; attachment cannot establish it");
  requireValue(path.isAbsolute(artifact) && (await lstat(artifact)).isFile(), "Proof artifact must be an absolute regular file");
  const captured = path.resolve(runDir, "proof", `${prepared.id}.artifact`);
  await writeFile(captured, await readFile(artifact), { flag: "wx", mode: 0o600 });
  return finishCheck(runDir, prepared, { id: prepared.id, startedAt: timestamp(), status: verdict, origin: "reviewed-artifact", exitCode: null, artifact: captured, originalArtifact: artifact, summary, ...(actor ? { actor } : {}) });
}

async function snapshotValid(receipt, manifest, check) {
  try {
    const bytes = await readFile(receipt.snapshot);
    const snapshot = JSON.parse(receipt.snapshot.endsWith(".gz") ? gunzipSync(bytes) : bytes);
    return digest(bytes) === receipt.snapshotHash && snapshot.schemaVersion === 2 && snapshot.id === receipt.id
      && hashObject(snapshot.inputs) === receipt.sourceHash
      && hashObject(snapshot.contract) === receipt.contractHash
      && receipt.contractHash === hashObject(contract(manifest, check))
      && snapshot.cwd === await executionCwd(manifest, check) && receipt.cwd === snapshot.cwd
      && snapshot.inputs.every((entry) => entry.type === "directory" || digest(Buffer.from(entry.base64, "base64")) === entry.sha256);
  } catch { return false; }
}

export async function evaluateRun(runDir) {
  const { manifest, events } = await readRun(runDir);
  const checks = [];
  for (const check of manifest.checks) {
    const receipt = events.filter((event) => event.type === "check_recorded" && event.receipt?.checkId === check.id).at(-1)?.receipt;
    let status = "missing";
    let reason = "No verification receipt";
    if (receipt) {
      const current = await sourceSnapshot(manifest, check).then(hashObject).catch(() => null);
      const proofHash = await readFile(receipt.artifact).then(digest).catch(() => null);
      const originalHash = receipt.originalArtifact ? await readFile(receipt.originalArtifact).then(digest).catch(() => null) : proofHash;
      const fresh = current !== null && proofHash !== null && receipt.schemaVersion === 2 && await snapshotValid(receipt, manifest, check) && environmentMatches(check)
        && receipt.sourceHash === current && receipt.sourceHashAfter === current && receipt.artifactHash === proofHash && originalHash === proofHash;
      const output = await readFile(receipt.artifact, "utf8").catch(() => "");
      const milestones = observedMilestones(check, output);
      const evidence = milestones.length === (check.proof?.milestones.length ?? 0)
        && canonical(milestones) === canonical(receipt.observedMilestones)
        && (receipt.origin !== "command" || (receipt.executed === true && receipt.exitCode === 0 && receipt.signal === null
          && (check.preflight ?? []).every((hook, index) => receipt.preflight?.[index]?.exitCode === 0 && receipt.preflight[index].stdout === hook.expectedStdout)));
      status = fresh && (receipt.status !== "passed" || evidence) && ["passed", "failed"].includes(receipt.status) ? receipt.status : "stale";
      reason = status === "stale" ? "Check contract, relevant source, environment or proof changed; rerun the check" : receipt.summary;
    }
    checks.push({ ...check, status, reason, ...(receipt ? { receipt } : {}) });
  }
  const criteria = manifest.criteria.map((criterion) => ({ ...criterion, status: criterion.checkIds.every((id) => checks.find((check) => check.id === id).status === "passed") ? "passed" : "blocked" }));
  return { manifest, events, checks, criteria, acceptanceComplete: criteria.every((criterion) => criterion.status === "passed") };
}
