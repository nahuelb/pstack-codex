#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendEvent, createAuditRun, projectFingerprint as auditProjectFingerprint } from "../../skills/show-me-your-work/scripts/audit.mjs";

export const STATE_SCHEMA = 2;
export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DISABLE_PHRASE = "disable $poteto-mode";
export const CLEANUP_CONCURRENCY = 16;

const LITERAL_ACTIVATION = /^\s*\$poteto-mode(?=\s|$)/u;
const CODEX_MENTION_ACTIVATION = /^\s*\[\$pstack-for-codex:poteto-mode\]\([^()\s]+\/skills\/poteto-mode\/SKILL\.md\)(?=\s|$)/u;
const DISABLE = /^\s*disable \$poteto-mode[.!]?\s*$/iu;
const REFERENCED_CHATS_PREAMBLE = /^\s*## Referenced chats with Codex:\r?\n[\s\S]*?\r?\n## My request:[ \t]*\r?\n/u;
const LEADING_SLASH_COMMAND = /^\s*\/[a-z][\w-]*\s+/iu;
const MAX_SESSION_ID_LENGTH = 512;
const AUDIT_SCRIPT = fileURLToPath(new URL("../../skills/show-me-your-work/scripts/audit.mjs", import.meta.url));

export function hashValue(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sessionKey(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) {
    return null;
  }
  return hashValue(sessionId);
}

export function projectFingerprint(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4096 || cwd.includes("\0")) return null;
  return auditProjectFingerprint(cwd);
}

export function extractUserRequest(prompt) {
  if (typeof prompt !== "string") return "";
  let request = prompt;
  const preamble = request.match(REFERENCED_CHATS_PREAMBLE);
  if (preamble) request = request.slice(preamble[0].length);
  const slashCommand = request.match(LEADING_SLASH_COMMAND);
  if (slashCommand) request = request.slice(slashCommand[0].length);
  return request;
}

export function classifyPrompt(prompt) {
  if (typeof prompt !== "string") return "inactive";
  const request = extractUserRequest(prompt);
  if (DISABLE.test(request)) return "disable";
  if (LITERAL_ACTIVATION.test(request) || CODEX_MENTION_ACTIVATION.test(request)) return "activate";
  return "inactive";
}

export function statePaths(pluginData, sessionId) {
  const key = sessionKey(sessionId);
  if (!key || typeof pluginData !== "string" || pluginData.length === 0) return null;
  const root = path.join(pluginData, "poteto-mode");
  return {
    root,
    state: path.join(root, "sessions", `${key}.json`),
    receipt: path.join(root, "receipts", `${key}.json`),
  };
}

async function atomicWrite(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, target);
}

async function writeStateAndReceipt(targets, state, receipt) {
  await Promise.all([
    atomicWrite(targets.state, state),
    atomicWrite(targets.receipt, receipt),
  ]);
}

async function readLock(target) {
  try {
    return (await fs.readFile(target, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function processStartIdentity(pid) {
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return started ? hashValue(started).slice(0, 16) : null;
  } catch {
    return null;
  }
}

function processLockToken() {
  return `${process.pid}:${processStartIdentity(process.pid) ?? "unknown"}:${randomUUID()}`;
}

function lockHolderIsReclaimable(holder) {
  const parts = holder?.split(":") ?? [];
  const rawPid = parts[0] ?? "";
  const pid = Number.parseInt(rawPid, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== rawPid) return true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code === "ESRCH";
  }
  if (parts.length < 3) return false;
  if (parts[1] === "unknown") return false;
  const currentStart = processStartIdentity(pid);
  return currentStart !== null && parts[1] !== currentStart;
}

async function publishLock(target, token) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${token}\n`, { flag: "wx", mode: 0o600 });
    await fs.link(temporary, target);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function withSessionLock(targets, operation) {
  await fs.mkdir(path.dirname(targets.state), { recursive: true, mode: 0o700 });
  const lock = `${targets.state}.lock`;
  const takeover = `${lock}.takeover`;
  const token = processLockToken();
  const restoreClaim = async (quarantine) => {
    try {
      await fs.link(quarantine, takeover);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await fs.unlink(quarantine);
  };
  const removeStaleClaim = async (observed) => {
    const quarantine = `${takeover}.stale-${process.pid}-${randomUUID()}`;
    try {
      await fs.rename(takeover, quarantine);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    const moved = await readLock(quarantine);
    if (moved !== observed) {
      await restoreClaim(quarantine);
      return false;
    }
    await fs.unlink(quarantine);
    return true;
  };
  const clearAbandonedClaim = async () => {
    while (true) {
      const holder = await readLock(takeover);
      if (holder === null) return true;
      if (!lockHolderIsReclaimable(holder)) return false;
      if (await removeStaleClaim(holder)) continue;
    }
  };
  const createClaim = async () => {
    const claim = processLockToken();
    if (!await clearAbandonedClaim()) return null;
    return await publishLock(takeover, claim) ? claim : null;
  };
  const release = async (target, owner) => {
    if (await readLock(target) === owner) await fs.unlink(target);
  };
  const create = async (duringTakeover = false) => {
    if (!duringTakeover && !await clearAbandonedClaim()) return false;
    if (!await publishLock(lock, token)) return false;
    if (!duringTakeover) {
      for (let attempt = 0; attempt < 100 && await readLock(takeover) !== null; attempt += 1) {
        await clearAbandonedClaim();
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    return true;
  };
  const takeOver = async (observed) => {
    const claim = await createClaim();
    if (claim === null) return false;
    try {
      if (await readLock(lock) !== observed || !lockHolderIsReclaimable(observed)) return false;
      if (await readLock(takeover) !== claim) return false;
      await fs.unlink(lock);
      return create(true);
    } finally {
      await release(takeover, claim);
    }
  };
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    acquired = await create();
    if (acquired) break;
    const holder = await readLock(lock);
    if (holder !== null && lockHolderIsReclaimable(holder)) {
      acquired = await takeOver(holder);
      if (acquired) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!acquired) throw new Error("timed out acquiring Poteto session state lock");
  try {
    return await operation();
  } finally {
    await release(lock, token);
  }
}

async function removeFile(target, fileSystem = fs) {
  await fileSystem.rm(target, { force: true });
}

async function readJsonSnapshot(target, fileSystem = fs) {
  let source;
  try {
    source = await fileSystem.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return { source, value: JSON.parse(source) };
  } catch {
    return { source, value: null };
  }
}

async function removeSnapshot(target, observed, fileSystem = fs) {
  if (typeof fileSystem.rename !== "function" || typeof fileSystem.link !== "function" || typeof fileSystem.unlink !== "function") {
    await removeFile(target, fileSystem);
    return;
  }
  const quarantine = `${target}.${process.pid}.${randomUUID()}.stale`;
  try {
    await fileSystem.rename(target, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const moved = await fileSystem.readFile(quarantine, "utf8");
  if (moved !== observed) {
    try {
      await fileSystem.link(quarantine, target);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  await fileSystem.unlink(quarantine);
}

async function runBounded(items, concurrency, operation) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(items.length, Math.max(1, concurrency)) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await operation(item);
      }
    },
  );
  await Promise.all(workers);
}

export async function collectExpired(
  pluginData,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  options = {},
) {
  if (typeof pluginData !== "string" || pluginData.length === 0) return;
  const fileSystem = options.fileSystem ?? fs;
  const concurrency = options.concurrency ?? CLEANUP_CONCURRENCY;
  const root = path.join(pluginData, "poteto-mode");
  for (const directory of [path.join(root, "sessions"), path.join(root, "receipts")]) {
    let entries;
    try {
      entries = await fileSystem.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const candidates = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    await runBounded(candidates, concurrency, async (entry) => {
      const target = path.join(directory, entry.name);
      const snapshot = await readJsonSnapshot(target, fileSystem);
      if (snapshot === null) return;
      const value = snapshot.value;
      const timestamp = Date.parse(value?.updatedAt ?? value?.lastHookAt ?? "");
      if (value?.schema !== STATE_SCHEMA || !Number.isFinite(timestamp) || now - timestamp > ttlMs) {
        await removeSnapshot(target, snapshot.source, fileSystem);
      }
    });
  }
}

export async function removeStateAndReceipt(targets, remove = removeFile) {
  await remove(targets.state);
  await remove(targets.receipt);
}

export async function readActiveSessionState({ pluginData, sessionId, now = Date.now(), ttlMs = DEFAULT_TTL_MS }) {
  const targets = statePaths(pluginData, sessionId);
  if (!targets) return null;
  const state = (await readJsonSnapshot(targets.state))?.value;
  const updated = Date.parse(state?.updatedAt ?? "");
  if (
    state?.schema !== STATE_SCHEMA ||
    state?.active !== true ||
    typeof state?.audit?.runId !== "string" ||
    typeof state?.audit?.runDirectory !== "string" ||
    typeof state?.projectFingerprint !== "string" ||
    !Number.isFinite(updated) ||
    now - updated > ttlMs
  ) {
    return null;
  }
  return state;
}

export async function readActiveState({ pluginData, sessionId, cwd, now = Date.now(), ttlMs = DEFAULT_TTL_MS }) {
  const fingerprint = projectFingerprint(cwd);
  if (!fingerprint) return null;
  const state = await readActiveSessionState({ pluginData, sessionId, now, ttlMs });
  return state?.projectFingerprint === fingerprint ? state : null;
}

function stateValue(fingerprint, now, createdAt, audit) {
  const timestamp = new Date(now).toISOString();
  return {
    schema: STATE_SCHEMA,
    active: true,
    createdAt: createdAt ?? timestamp,
    updatedAt: timestamp,
    projectFingerprint: fingerprint,
    audit,
  };
}

function receiptValue(fingerprint, event, now) {
  return {
    schema: STATE_SCHEMA,
    event,
    lastHookAt: new Date(now).toISOString(),
    projectFingerprint: fingerprint,
  };
}

function mainActor(sessionId) {
  return `main:${sessionId}`;
}

function taskReference(input) {
  const task = requiredIdentity(input?.session_id, "unknown-task");
  const turn = requiredIdentity(input?.turn_id, "unknown-turn");
  return `task ${task}, turn ${turn}`;
}

function requiredIdentity(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function auditContext(state, input) {
  const { runId, runDirectory } = state.audit;
  return `Private audit run ${runId} belongs to parent task ${input.session_id}. The canonical ledger is ${path.join(runDirectory, "decisions.tsv")}; the linked execution trace is ${path.join(runDirectory, "events.tsv")}. Keep both private. Apply show-me-your-work freshness at meaningful boundaries. Use node ${AUDIT_SCRIPT} for decision, event, and status writes. Never record prompts, reasoning, secrets, or unrelated commands.`;
}

async function recordEvent(state, input, event, detail, eventState, evidence = "none", now = Date.now()) {
  await appendEvent(state.audit.runDirectory, {
    actorId: mainActor(input.session_id),
    parentActorId: "none",
    event,
    detail,
    evidence,
    state: eventState,
    ref: taskReference(input),
  }, now);
}

export async function handleHook(input, options = {}) {
  const pluginData = options.pluginData ?? process.env.PLUGIN_DATA;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const targets = statePaths(pluginData, input?.session_id);
  const fingerprint = projectFingerprint(input?.cwd);
  if (!targets || !fingerprint) return null;

  const event = input?.hook_event_name;
  if (event === "SessionEnd") {
    await collectExpired(pluginData, now, ttlMs);
    await withSessionLock(targets, async () => {
      const current = await readActiveState({ pluginData, sessionId: input.session_id, cwd: input.cwd, now, ttlMs });
      if (!current) return;
      await recordEvent(current, input, "session-end", "session ended; run remains resumable", "resumable", "none", now);
      await writeStateAndReceipt(targets, stateValue(fingerprint, now, current.createdAt, current.audit), receiptValue(fingerprint, event, now));
    });
    return null;
  }
  if (event === "SessionStart") {
    if (!["resume", "compact"].includes(input?.source)) return null;
    const current = await withSessionLock(targets, async () => {
      const active = await readActiveState({ pluginData, sessionId: input.session_id, cwd: input.cwd, now, ttlMs });
      if (!active) return null;
      await recordEvent(active, input, "state", `session ${input.source}`, "active", "none", now);
      await writeStateAndReceipt(targets, stateValue(fingerprint, now, active.createdAt, active.audit), receiptValue(fingerprint, event, now));
      return active;
    });
    if (!current) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `Poteto Mode remains active for this resumed or compacted session. Apply the $poteto-mode skill. Do not infer authority beyond the user request. ${auditContext(current, input)}`,
      },
    };
  }
  if (event !== "UserPromptSubmit") return null;

  const action = classifyPrompt(input.prompt);
  if (action === "disable") {
    await withSessionLock(targets, async () => {
      const current = await readActiveState({ pluginData, sessionId: input.session_id, cwd: input.cwd, now, ttlMs });
      await removeStateAndReceipt(targets);
      if (current) await recordEvent(current, input, "terminal", "Poteto Mode disabled", "disabled", "none", now);
    });
    return null;
  }
  if (action === "activate") {
    await collectExpired(pluginData, now, ttlMs);
    const state = await withSessionLock(targets, async () => {
      const current = await readActiveState({ pluginData, sessionId: input.session_id, cwd: input.cwd, now, ttlMs });
      if (current) {
        await recordEvent(current, input, "turn-start", "Poteto activation turn received", "active", "none", now);
        await writeStateAndReceipt(
          targets,
          stateValue(fingerprint, now, current.createdAt, current.audit),
          receiptValue(fingerprint, event, now),
        );
        return current;
      }
      const created = await createAuditRun({
        pluginData,
        parentTaskId: input.session_id,
        projectFingerprint: fingerprint,
        now,
      });
      const audit = { runId: created.run_id, runDirectory: created.run_directory };
      const next = stateValue(fingerprint, now, undefined, audit);
      await recordEvent(next, input, "run-start", "Poteto Mode activated", "active", "none", now);
      await writeStateAndReceipt(targets, next, receiptValue(fingerprint, event, now));
      return next;
    });
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `Poteto sticky receipt: trusted session hook persisted this mode. The skill supplies the activation-turn behavior. ${auditContext(state, input)}`,
      },
    };
  }

  const observed = await readActiveState({ pluginData, sessionId: input.session_id, cwd: input.cwd, now, ttlMs });
  if (!observed) return null;
  const current = await withSessionLock(targets, async () => {
    const active = await readActiveState({ pluginData, sessionId: input.session_id, cwd: input.cwd, now, ttlMs });
    if (!active) return null;
    await recordEvent(active, input, "turn-start", "Poteto turn received", "active", "none", now);
    await writeStateAndReceipt(targets, stateValue(fingerprint, now, active.createdAt, active.audit), receiptValue(fingerprint, event, now));
    return active;
  });
  if (!current) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `Poteto Mode is active for this session. Apply the $poteto-mode skill for this turn. Do not infer authority beyond the user request. ${auditContext(current, input)}`,
    },
  };
}

export async function readHookInput(stream = process.stdin) {
  let source = "";
  for await (const chunk of stream) source += chunk;
  if (!source.trim()) return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

async function main() {
  const input = await readHookInput();
  if (!input) return;
  const output = await handleHook(input);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`Poteto state hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
