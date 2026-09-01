import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CLEANUP_CONCURRENCY,
  DEFAULT_TTL_MS,
  STATE_SCHEMA,
  classifyPrompt,
  collectExpired,
  extractUserRequest,
  handleHook,
  projectFingerprint,
  readActiveState,
  removeStateAndReceipt,
  statePaths,
} from "../hooks/scripts/poteto-mode-state.mjs";
import { handleSubagentHook } from "../hooks/scripts/poteto-subagent-context.mjs";
import { hookStatus } from "../scripts/poteto-hook-status.mjs";
import { auditStatus } from "../skills/show-me-your-work/scripts/audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(root, "tests/fixtures/hooks");
const stateModuleUrl = pathToFileURL(path.join(root, "hooks/scripts/poteto-mode-state.mjs")).href;

function runActivationProcess(input, pluginData, now) {
  const source = `
    import { handleHook } from ${JSON.stringify(stateModuleUrl)};
    await handleHook(${JSON.stringify(input)}, { pluginData: ${JSON.stringify(pluginData)}, now: ${now} });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`activation exited ${code}: ${stderr}`)));
  });
}

function runCollectorProcess(pluginData, now, ttlMs) {
  const source = `
    import { collectExpired } from ${JSON.stringify(stateModuleUrl)};
    await collectExpired(${JSON.stringify(pluginData)}, ${now}, ${ttlMs});
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`collector exited ${code}: ${stderr}`)));
  });
}

async function fixture(t) {
  const pluginData = await fs.mkdtemp(path.join(os.tmpdir(), "pstack-poteto-hooks-"));
  t.after(() => fs.rm(pluginData, { recursive: true, force: true }));
  const load = async (name) => JSON.parse(await fs.readFile(path.join(fixtureRoot, name), "utf8"));
  return { pluginData, load };
}

test("hook manifest uses current Codex events and audits every subagent", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "hooks/hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.hooks).sort(), ["SessionEnd", "SessionStart", "SubagentStart", "SubagentStop", "UserPromptSubmit"]);
  assert.equal(manifest.hooks.SessionStart[0].matcher, "resume|compact");
  assert.equal("matcher" in manifest.hooks.SubagentStart[0], false);
  assert.equal("matcher" in manifest.hooks.SubagentStop[0], false);
  assert.match(manifest.hooks.UserPromptSubmit[0].hooks[0].command, /\$PLUGIN_ROOT/);
  assert.equal("matcher" in manifest.hooks.UserPromptSubmit[0], false);
});

test("only a leading explicit invocation activates and the disable phrase is exact", () => {
  const codexMention = "[$pstack-for-codex:poteto-mode](/Users/nahue/.codex/plugins/cache/pstack-for-codex-local/pstack-for-codex/0.2.0+codex.test/skills/poteto-mode/SKILL.md)";
  const referencedChats = '\n## Referenced chats with Codex:\nThese are live references to Codex tasks, not task contents.\n[{"hostId":"local","threadId":"thr_x"}]\n## My request:\n';
  assert.equal(classifyPrompt("$poteto-mode build it"), "activate");
  assert.equal(classifyPrompt("  $poteto-mode\ncontinue"), "activate");
  assert.equal(classifyPrompt(`${codexMention} build it`), "activate");
  assert.equal(classifyPrompt(`  ${codexMention}\ncontinue`), "activate");
  assert.equal(classifyPrompt(`/goal ${codexMention} continue`), "activate");
  assert.equal(classifyPrompt("/goal $poteto-mode continue"), "activate");
  assert.equal(classifyPrompt(`${referencedChats}${codexMention} continue`), "activate");
  assert.equal(classifyPrompt(`${referencedChats}/goal ${codexMention} continue`), "activate");
  assert.equal(classifyPrompt("disable $poteto-mode"), "disable");
  assert.equal(classifyPrompt("Disable $poteto-mode."), "disable");
  assert.equal(classifyPrompt("/goal disable $poteto-mode"), "disable");
  assert.equal(classifyPrompt("disable $poteto-mode now"), "inactive");
  assert.equal(classifyPrompt("please disable $poteto-mode"), "inactive");
  assert.equal(classifyPrompt("I mentioned $poteto-mode casually"), "inactive");
  assert.equal(classifyPrompt("`$poteto-mode` is the invocation"), "inactive");
  assert.equal(classifyPrompt(`before ${codexMention}`), "inactive");
  assert.equal(classifyPrompt("/Users/nahue/tool $poteto-mode"), "inactive");
  assert.equal(classifyPrompt("intro\n## My request:\n$poteto-mode evil"), "inactive");
  assert.equal(classifyPrompt("[$pstack-for-codex:why](/skills/why/SKILL.md) explain it"), "inactive");
  assert.equal(classifyPrompt("poteto mode please"), "inactive");
});

test("extractUserRequest strips only the app preamble and one slash command", () => {
  const referencedChats = '\n## Referenced chats with Codex:\nlive references\n[{}]\n## My request:\n';
  assert.equal(extractUserRequest(`${referencedChats}/goal $poteto-mode go`), "$poteto-mode go");
  assert.equal(extractUserRequest("/goal /plan $poteto-mode go"), "/plan $poteto-mode go");
  assert.equal(extractUserRequest("plain request"), "plain request");
  assert.equal(extractUserRequest(undefined), "");
});

test("Codex Poteto skill mentions persist session state and a receipt", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  activation.prompt = "[$pstack-for-codex:poteto-mode](/Users/nahue/.codex/plugins/cache/pstack-for-codex-local/pstack-for-codex/0.2.0+codex.test/skills/poteto-mode/SKILL.md) build it";

  const receipt = await handleHook(activation, { pluginData, now: 1_000 });

  assert.match(receipt.hookSpecificOutput.additionalContext, /sticky receipt/);
  const state = await readActiveState({
    pluginData,
    sessionId: activation.session_id,
    cwd: activation.cwd,
    now: 2_000,
  });
  assert.equal(state.active, true);
  assert.match(receipt.hookSpecificOutput.additionalContext, new RegExp(state.audit.runId));
  assert.deepEqual(await auditStatus(state.audit.runDirectory), {
    run_id: state.audit.runId,
    parent_task_id: activation.session_id,
    privacy: "private",
    ledger: path.join(state.audit.runDirectory, "decisions.tsv"),
    trace: path.join(state.audit.runDirectory, "events.tsv"),
    decisions: 0,
    events: 1,
  });
});

test("activation is session isolated and later turns survive resume and compaction", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  const receipt = await handleHook(activation, { pluginData, now: 1_000 });
  assert.match(receipt.hookSpecificOutput.additionalContext, /sticky receipt/);

  const later = await handleHook(await load("later-turn.json"), { pluginData, now: 2_000 });
  assert.match(later.hookSpecificOutput.additionalContext, /active for this session/);
  const concurrent = await handleHook({ ...activation, session_id: "thr_other", prompt: "continue" }, { pluginData, now: 2_000 });
  assert.equal(concurrent, null);

  const compactContinuation = await handleHook({
    ...activation,
    hook_event_name: "SessionStart",
    source: "compact",
  }, { pluginData, now: 3_000 });
  assert.match(compactContinuation.hookSpecificOutput.additionalContext, /active for this resumed or compacted session/);
  assert.equal((compactContinuation.hookSpecificOutput.additionalContext.match(/Poteto Mode/g) ?? []).length, 1);

  const resumed = await handleHook({
    ...activation,
    hook_event_name: "SessionStart",
    source: "resume",
  }, { pluginData, now: 4_000 });
  assert.match(resumed.hookSpecificOutput.additionalContext, /active for this resumed/);
});

test("concurrent activation writes remain atomic and task-local", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  const inputs = Array.from({ length: 30 }, (_, index) => ({
    ...activation,
    session_id: `thr_concurrent_${index % 3}`,
    turn_id: `turn_${index}`,
  }));
  await Promise.all(inputs.map((input, index) => handleHook(input, { pluginData, now: 10_000 + index })));
  for (let index = 0; index < 3; index += 1) {
    const targets = statePaths(pluginData, `thr_concurrent_${index}`);
    const state = JSON.parse(await fs.readFile(targets.state, "utf8"));
    assert.equal(state.schema, STATE_SCHEMA);
    assert.equal(state.active, true);
  }
  const files = await fs.readdir(path.join(pluginData, "poteto-mode/sessions"));
  assert.equal(files.some((name) => name.endsWith(".tmp")), false);
  assert.equal((await fs.readdir(path.join(pluginData, "poteto-mode/audits"))).length, 3);
});

test("concurrent processes replace one dead lock without creating duplicate audit runs", async (t) => {
  const { pluginData, load } = await fixture(t);
  const template = await load("activate.json");
  const dead = spawnSync(process.execPath, ["--eval", ""]);
  for (let index = 0; index < 100; index += 1) {
    const activation = { ...template, session_id: `thr_process_${index}` };
    const targets = statePaths(pluginData, activation.session_id);
    await fs.mkdir(path.dirname(targets.state), { recursive: true });
    const lockOwner = index % 5 === 0
      ? `${process.pid}:wrong-start:stale`
      : index % 4 === 0 ? "" : index % 4 === 1 ? "malformed" : `${dead.pid}:stale`;
    await fs.writeFile(`${targets.state}.lock`, `${lockOwner}\n`);
    if (index % 3 === 0) {
      const claimOwner = index % 2 === 0 ? "" : `${dead.pid}:abandoned`;
      await fs.writeFile(`${targets.state}.lock.takeover`, `${claimOwner}\n`);
    }
    await Promise.all([
      runActivationProcess(activation, pluginData, 10_000 + index),
      runActivationProcess(activation, pluginData, 20_000 + index),
    ]);
    await assert.rejects(fs.stat(`${targets.state}.lock`), { code: "ENOENT" });
    await assert.rejects(fs.stat(`${targets.state}.lock.takeover`), { code: "ENOENT" });
  }
  assert.equal((await fs.readdir(path.join(pluginData, "poteto-mode/audits"))).length, 100);
  assert.equal((await fs.readdir(path.join(pluginData, "poteto-mode/sessions"))).some((name) => name.endsWith(".tmp")), false);
});

test("a live lock with unknown start identity is never reclaimed", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  const targets = statePaths(pluginData, activation.session_id);
  await fs.mkdir(path.dirname(targets.state), { recursive: true });
  await fs.writeFile(`${targets.state}.lock`, `${process.pid}:unknown:held\n`);
  await assert.rejects(handleHook(activation, { pluginData, now: 1_000 }), /timed out acquiring/);
  assert.equal((await fs.readFile(`${targets.state}.lock`, "utf8")).trim(), `${process.pid}:unknown:held`);
});

test("stale cleanup cannot delete freshly activated state", async (t) => {
  const { pluginData, load } = await fixture(t);
  const template = await load("activate.json");
  for (let index = 0; index < 30; index += 1) {
    const activation = { ...template, session_id: `thr_cleanup_race_${index}` };
    const targets = statePaths(pluginData, activation.session_id);
    await fs.mkdir(path.dirname(targets.state), { recursive: true });
    await fs.mkdir(path.dirname(targets.receipt), { recursive: true });
    await fs.writeFile(targets.state, `${JSON.stringify({ schema: STATE_SCHEMA, active: true, updatedAt: new Date(0).toISOString(), projectFingerprint: projectFingerprint(activation.cwd), audit: { runId: "old", runDirectory: "/old" } })}\n`);
    await fs.writeFile(targets.receipt, `${JSON.stringify({ schema: STATE_SCHEMA, lastHookAt: new Date(0).toISOString() })}\n`);
    await Promise.all([
      runCollectorProcess(pluginData, 100_000 + index, 1),
      runActivationProcess(activation, pluginData, 200_000 + index),
    ]);
    assert.equal((await readActiveState({ pluginData, sessionId: activation.session_id, cwd: activation.cwd, now: 200_001 + index }))?.active, true);
  }
  assert.equal((await fs.readdir(path.join(pluginData, "poteto-mode/audits"))).length, 30);
});

test("explicit opt-out removes this session and its delegate context", async (t) => {
  const { pluginData, load } = await fixture(t);
  await handleHook(await load("activate.json"), { pluginData, now: 1_000 });
  const state = await readActiveState({
    pluginData,
    sessionId: "thr_fixture_active",
    cwd: "/workspace/project-a",
    now: 1_500,
  });
  await handleHook(await load("disable.json"), { pluginData, now: 2_000 });
  assert.equal(await handleHook(await load("later-turn.json"), { pluginData, now: 3_000 }), null);
  assert.equal(await handleSubagentHook(await load("poteto-subagent.json"), {
    pluginData,
    pluginRoot: root,
    now: 3_000,
  }), null);
  assert.equal((await auditStatus(state.audit.runDirectory)).events, 2);
});

test("explicit opt-out revokes sticky state before a damaged audit can fail", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  const now = Date.now();
  await handleHook(activation, { pluginData, now });
  const state = await readActiveState({ pluginData, sessionId: activation.session_id, cwd: activation.cwd, now: now + 1 });
  await fs.rm(path.join(state.audit.runDirectory, "run.json"));
  await assert.rejects(handleHook(await load("disable.json"), { pluginData, now: now + 2 }), /ENOENT/);
  assert.equal(await readActiveState({ pluginData, sessionId: activation.session_id, cwd: activation.cwd, now: now + 3 }), null);
  await assert.rejects(fs.stat(statePaths(pluginData, activation.session_id).receipt), { code: "ENOENT" });
});

test("explicit opt-out cannot be resurrected by a concurrent active turn", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activationTemplate = await load("activate.json");
  const laterTemplate = await load("later-turn.json");
  const disableTemplate = await load("disable.json");
  for (let index = 0; index < 30; index += 1) {
    const sessionId = `thr_disable_race_${index}`;
    const activation = { ...activationTemplate, session_id: sessionId };
    await runActivationProcess(activation, pluginData, 10_000 + index);
    await Promise.all([
      runActivationProcess({ ...laterTemplate, session_id: sessionId }, pluginData, 20_000 + index),
      runActivationProcess({ ...disableTemplate, session_id: sessionId }, pluginData, 20_001 + index),
    ]);
    assert.equal(await readActiveState({ pluginData, sessionId, cwd: activation.cwd, now: 30_000 + index }), null);
  }
});

test("opt-out removes authority state before its ancillary receipt and propagates failure", async () => {
  const removed = [];
  const failure = Object.assign(new Error("receipt unavailable"), { code: "EIO" });
  await assert.rejects(
    removeStateAndReceipt({ state: "authority.json", receipt: "receipt.json" }, async (target) => {
      removed.push(target);
      if (target === "receipt.json") throw failure;
    }),
    failure,
  );
  assert.deepEqual(removed, ["authority.json", "receipt.json"]);
});

test("all subagents receive the audit run while only the exact Poteto delegate receives its persona", async (t) => {
  const { pluginData, load } = await fixture(t);
  await handleHook(await load("activate.json"), { pluginData, now: 1_000 });
  const generic = await handleSubagentHook(await load("generic-subagent.json"), { pluginData, pluginRoot: root, now: 2_000 });
  assert.match(generic.hookSpecificOutput.additionalContext, /Private audit run/);
  assert.doesNotMatch(generic.hookSpecificOutput.additionalContext, /Poteto agent prompt/);
  const poteto = await handleSubagentHook(await load("poteto-subagent.json"), { pluginData, pluginRoot: root, now: 2_000 });
  assert.match(poteto.hookSpecificOutput.additionalContext, /Poteto agent prompt/);
  assert.match(poteto.hookSpecificOutput.additionalContext, /Do not infer write/);
  assert.match(poteto.hookSpecificOutput.additionalContext, /stop hook records a stop observation/);
  const state = await readActiveState({ pluginData, sessionId: "thr_fixture_active", cwd: "/workspace/project-a", now: 3_000 });
  assert.equal((await auditStatus(state.audit.runDirectory)).events, 3);
  assert.deepEqual(await handleSubagentHook(await load("poteto-subagent-stop.json"), {
    pluginData,
    pluginRoot: root,
    now: 4_000,
  }), {});
  assert.equal((await auditStatus(state.audit.runDirectory)).events, 4);
  const events = await fs.readFile(path.join(state.audit.runDirectory, "events.tsv"), "utf8");
  assert.match(events, /\tstate\tobserved pstack-poteto-agent subagent stop hook\tnone\tstop-observed\t/);
  assert.doesNotMatch(events, /\tterminal\tobserved pstack-poteto-agent subagent stop hook\t/);
});

test("subagents in another worktree adopt the parent session audit run", async (t) => {
  const { pluginData, load } = await fixture(t);
  const repo = path.join(pluginData, "repo");
  const worktree = path.join(pluginData, "worktree");
  await fs.mkdir(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "--initial-branch=main");
  git("config", "user.name", "Pstack Test");
  git("config", "user.email", "pstack@example.invalid");
  await fs.writeFile(path.join(repo, "tracked.txt"), "baseline\n");
  git("add", "tracked.txt");
  git("commit", "-m", "baseline");
  git("worktree", "add", "-b", "agent-work", worktree);
  const activation = { ...await load("activate.json"), cwd: repo };
  await handleHook(activation, { pluginData, now: 1_000 });
  const input = { ...await load("poteto-subagent.json"), cwd: worktree };
  const output = await handleSubagentHook(input, { pluginData, pluginRoot: root, now: 2_000 });
  assert.match(output.hookSpecificOutput.additionalContext, /Private audit run/);
  const state = await readActiveState({ pluginData, sessionId: input.session_id, cwd: repo, now: 3_000 });
  assert.equal((await auditStatus(state.audit.runDirectory)).events, 2);
});

test("subagent stops stay bound to the audit run captured at start", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  await handleHook(activation, { pluginData, now: 1_000 });
  const firstState = await readActiveState({ pluginData, sessionId: activation.session_id, cwd: activation.cwd, now: 2_000 });
  await handleSubagentHook(await load("poteto-subagent.json"), { pluginData, pluginRoot: root, now: 3_000 });

  const replacement = { ...activation, cwd: "/workspace/project-b" };
  await handleHook(replacement, { pluginData, now: 4_000 });
  const secondState = await readActiveState({ pluginData, sessionId: replacement.session_id, cwd: replacement.cwd, now: 5_000 });
  assert.notEqual(firstState.audit.runId, secondState.audit.runId);
  assert.equal(await handleSubagentHook({ ...await load("generic-subagent.json"), cwd: activation.cwd }, {
    pluginData,
    pluginRoot: root,
    now: 6_000,
  }), null);
  await handleSubagentHook(await load("poteto-subagent-stop.json"), { pluginData, pluginRoot: root, now: 7_000 });
  assert.equal((await auditStatus(firstState.audit.runDirectory)).events, 3);
  assert.equal((await auditStatus(secondState.audit.runDirectory)).events, 1);
  const events = await fs.readFile(path.join(firstState.audit.runDirectory, "events.tsv"), "utf8");
  assert.match(events, /\tagent_1\tunknown\t/);
});

test("subagent audit write failures exit visibly instead of being swallowed", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  const now = Date.now();
  await handleHook(activation, { pluginData, now });
  const state = await readActiveState({ pluginData, sessionId: activation.session_id, cwd: activation.cwd, now: now + 1 });
  await fs.rm(path.join(state.audit.runDirectory, "run.json"));
  const script = path.join(root, "hooks/scripts/poteto-subagent-context.mjs");
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(await load("poteto-subagent.json")),
    env: { ...process.env, PLUGIN_DATA: pluginData, PLUGIN_ROOT: root },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Poteto audit hook failed/);
});

test("main audit write failures exit with a useful error", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  const now = Date.now();
  await handleHook(activation, { pluginData, now });
  const state = await readActiveState({ pluginData, sessionId: activation.session_id, cwd: activation.cwd, now: now + 1 });
  await fs.rm(path.join(state.audit.runDirectory, "run.json"));
  const script = path.join(root, "hooks/scripts/poteto-mode-state.mjs");
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(await load("later-turn.json")),
    env: { ...process.env, PLUGIN_DATA: pluginData },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Poteto state hook failed/);
});

test("session end is advisory and keeps resumable state", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  await handleHook(activation, { pluginData, now: 1_000 });
  await handleHook({ ...activation, hook_event_name: "SessionEnd", reason: "other" }, { pluginData, now: 2_000 });
  const resumed = await handleHook({ ...activation, prompt: "continue after resume" }, { pluginData, now: 3_000 });
  assert.match(resumed.hookSpecificOutput.additionalContext, /active for this session/);
  const state = await readActiveState({ pluginData, sessionId: activation.session_id, cwd: activation.cwd, now: 4_000 });
  assert.equal((await auditStatus(state.audit.runDirectory)).events, 3);
});

test("malformed identifiers fail closed while unusual safe identities are hashed", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  assert.equal(await handleHook({ ...activation, session_id: "" }, { pluginData }), null);
  assert.equal(await handleHook({ ...activation, session_id: "x".repeat(513) }, { pluginData }), null);
  assert.equal(await handleHook({ ...activation, cwd: "bad\0cwd" }, { pluginData }), null);
  await handleHook({ ...activation, session_id: "../../unexpected/new:id" }, { pluginData, now: 1_000 });
  const targets = statePaths(pluginData, "../../unexpected/new:id");
  assert.match(targets.state, /[a-f0-9]{64}\.json$/);
  assert.equal(path.dirname(targets.state), path.join(pluginData, "poteto-mode/sessions"));
  assert.equal((await readActiveState({ pluginData, sessionId: "../../unexpected/new:id", cwd: activation.cwd, now: 2_000 }))?.active, true);
});

test("stale schema and TTL state are collected without global fallback", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  const targets = statePaths(pluginData, activation.session_id);
  await fs.mkdir(path.dirname(targets.state), { recursive: true });
  await fs.writeFile(targets.state, JSON.stringify({ schema: 0, active: true, updatedAt: new Date(1_000).toISOString() }));
  assert.equal(await handleHook({ ...activation, prompt: "continue" }, { pluginData, now: 2_000 }), null);
  assert.equal((await fs.stat(targets.state)).isFile(), true);
  await collectExpired(pluginData, 2_000, DEFAULT_TTL_MS);
  await assert.rejects(fs.stat(targets.state), { code: "ENOENT" });

  await handleHook(activation, { pluginData, now: 10_000 });
  assert.equal(await handleHook({ ...activation, prompt: "continue" }, {
    pluginData,
    now: 10_000 + DEFAULT_TTL_MS + 1,
  }), null);
});

test("definitively malformed state cleanup is collector-owned", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  const targets = statePaths(pluginData, activation.session_id);
  await fs.mkdir(path.dirname(targets.state), { recursive: true });
  await fs.writeFile(targets.state, "{not-json\n");

  assert.equal(await readActiveState({
    pluginData,
    sessionId: activation.session_id,
    cwd: activation.cwd,
    now: 2_000,
  }), null);
  assert.equal((await fs.stat(targets.state)).isFile(), true);
  await collectExpired(pluginData, 2_000, DEFAULT_TTL_MS);
  await assert.rejects(fs.stat(targets.state), { code: "ENOENT" });
});

test("transient cleanup read errors retain persisted state and propagate", async () => {
  const removed = [];
  const failure = Object.assign(new Error("temporary read failure"), { code: "EIO" });
  const fileSystem = {
    async readdir(directory) {
      return directory.endsWith("sessions")
        ? [{ name: "state.json", isFile: () => true }]
        : [];
    },
    async readFile() {
      throw failure;
    },
    async rm(target) {
      removed.push(target);
    },
  };

  await assert.rejects(
    collectExpired("/plugin-data", 10_000, DEFAULT_TTL_MS, { fileSystem }),
    failure,
  );
  assert.deepEqual(removed, []);
});

test("expired-state cleanup bounds concurrent filesystem reads", async () => {
  const entryCount = CLEANUP_CONCURRENCY * 3;
  let activeReads = 0;
  let maximumReads = 0;
  const removed = [];
  const fileSystem = {
    async readdir(directory) {
      if (!directory.endsWith("sessions")) return [];
      return Array.from({ length: entryCount }, (_, index) => ({
        name: `${index}.json`,
        isFile: () => true,
      }));
    },
    async readFile() {
      activeReads += 1;
      maximumReads = Math.max(maximumReads, activeReads);
      await new Promise((resolve) => setImmediate(resolve));
      activeReads -= 1;
      return JSON.stringify({ schema: STATE_SCHEMA, updatedAt: new Date(0).toISOString() });
    },
    async rm(target) {
      removed.push(target);
    },
  };

  await collectExpired("/plugin-data", DEFAULT_TTL_MS + 1, DEFAULT_TTL_MS, { fileSystem });
  assert.equal(maximumReads, CLEANUP_CONCURRENCY);
  assert.equal(removed.length, entryCount);
});

test("a project fingerprint mismatch never leaks activation", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  await handleHook(activation, { pluginData, now: 1_000 });
  assert.equal(await handleHook({ ...activation, cwd: "/workspace/project-b", prompt: "continue" }, { pluginData, now: 2_000 }), null);
  const original = await readActiveState({ pluginData, sessionId: activation.session_id, cwd: activation.cwd, now: 2_000 });
  assert.equal(original.active, true);
  assert.notEqual(projectFingerprint(activation.cwd), projectFingerprint("/workspace/project-b"));
});

test("status requires both active state and a current trusted-hook receipt", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  assert.deepEqual(await hookStatus({ pluginData, sessionId: activation.session_id, cwd: activation.cwd, now: 1_000 }), {
    status: "current-turn-only",
    reason: "inactive-or-invalid-state",
  });
  await handleHook(activation, { pluginData, now: 2_000 });
  assert.equal((await hookStatus({ pluginData, sessionId: activation.session_id, cwd: activation.cwd, now: 3_000 })).status, "active");
  await fs.rm(statePaths(pluginData, activation.session_id).receipt);
  assert.deepEqual(await hookStatus({ pluginData, sessionId: activation.session_id, cwd: activation.cwd, now: 3_000 }), {
    status: "current-turn-only",
    reason: "trusted-hook-receipt-missing",
  });
});

test("inactive and malformed hook input produce no output or state", async (t) => {
  const { pluginData, load } = await fixture(t);
  const activation = await load("activate.json");
  const before = process.hrtime.bigint();
  assert.equal(await handleHook({ ...activation, prompt: "we can discuss poteto mode later" }, { pluginData }), null);
  assert.equal(await handleHook(null, { pluginData }), null);
  const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;
  assert.ok(elapsedMs < 100, `inactive path took ${elapsedMs.toFixed(2)}ms`);
  await assert.rejects(fs.stat(path.join(pluginData, "poteto-mode")), { code: "ENOENT" });
});
