#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendEvent } from "../../skills/show-me-your-work/scripts/audit.mjs";
import { auditContext, readActiveState, readHookInput } from "./poteto-mode-state.mjs";

function bindingPath(pluginData, agentId) {
  if (typeof pluginData !== "string" || pluginData.length === 0) return null;
  const key = createHash("sha256").update(agentId).digest("hex");
  return path.join(pluginData, "poteto-mode", "agents", `${key}.json`);
}

async function writeBinding(target, binding) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(binding)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readBinding(target) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function handleSubagentHook(input, options = {}) {
  if (!["SubagentStart", "SubagentStop"].includes(input?.hook_event_name)) return null;
  const pluginData = options.pluginData ?? process.env.PLUGIN_DATA;
  const pluginRoot = options.pluginRoot ?? process.env.PLUGIN_ROOT;
  const agentId = typeof input.agent_id === "string" && input.agent_id.length > 0
    ? input.agent_id
    : `unknown:${input.agent_type ?? "agent"}`;
  const target = bindingPath(pluginData, agentId);
  if (target === null) return input.hook_event_name === "SubagentStop" ? {} : null;
  if (input.hook_event_name === "SubagentStop") {
    const binding = await readBinding(target);
    if (binding === null) return {};
    await appendEvent(binding.runDirectory, {
      actorId: agentId,
      parentActorId: binding.parentActorId,
      event: "state",
      detail: `observed ${input.agent_type ?? "unknown"} subagent stop hook`,
      evidence: "none",
      state: "stop-observed",
      ref: `task ${input.session_id}, turn ${input.turn_id ?? "unknown-turn"}`,
    }, options.now);
    return {};
  }
  const state = await readActiveState({
    pluginData,
    sessionId: input.session_id,
    cwd: input.cwd,
    now: options.now,
    ttlMs: options.ttlMs,
  });
  if (!state) return null;
  const parentId = "unknown";
  await writeBinding(target, {
    schema: 1,
    agentId,
    parentActorId: parentId,
    runId: state.audit.runId,
    runDirectory: state.audit.runDirectory,
    sessionId: input.session_id,
  });
  await appendEvent(state.audit.runDirectory, {
    actorId: agentId,
    parentActorId: parentId,
    event: "agent-start",
    detail: `started ${input.agent_type ?? "unknown"} subagent`,
    evidence: "none",
    state: "active",
    ref: `task ${input.session_id}, turn ${input.turn_id ?? "unknown-turn"}`,
  }, options.now);
  const audit = `${auditContext(state, input)} Audit actor ${agentId} has hook parent ${parentId}. Use the brief's declared immediate parent in delegated lifecycle events. Append only this subagent's meaningful lifecycle checkpoints. The stop hook records a stop observation; the main agent records terminal state after receiving the result.`;
  const prompt = input.agent_type === "pstack-poteto-agent" && typeof pluginRoot === "string" && pluginRoot.length > 0
    ? await fs.readFile(path.join(pluginRoot, "skills/poteto-mode/references/poteto-agent-prompt.md"), "utf8")
    : "";
  return {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: `${prompt}${prompt ? "\n\n" : ""}${audit}`,
    },
  };
}

async function main() {
  const output = await handleSubagentHook(await readHookInput());
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`Poteto audit hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
