import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(root, "skills");

const FORBIDDEN_RUNTIME_PATTERNS = [
  [/\.cursor(?:\/|\b)/i, "Cursor filesystem path"],
  [/\bCursor(?:'s)?\b/i, "Cursor host claim"],
  [/\bagent-transcripts\b/i, "private transcript store"],
  [/\bTask\s+(?:tool|call|subagent)/i, "Cursor Task recipe"],
  [/`Task`|\bsubagent_type\b|\bcloud_base_branch\b|`environment:\s*"(?:cloud|local)"`|`readonly`:\s*(?:true|false)/i, "non-Codex agent schema"],
  [/\bAskQuestion\b/i, "Cursor question tool"],
  [/\brun_in_background\b/i, "Cursor background flag"],
  [/\bcloud[- ]agent\b/i, "Cursor cloud-agent recipe"],
  [/(?:terminal\s+)?\/loop\b|cloud-sleeper|monitored-shell[^\n]*sleep/i, "unsupported loop mechanic"],
  [/supported Codex task history\/?|supported task history\//i, "invented task-history path"],
  [/\bcreate-skill\b|`mcps\/`/i, "non-Codex skill or connector discovery"],
  [/\b(?:claude-fable-5-thinking-max|grok-4\.6-fast-xhigh|claude-opus-5-thinking-xhigh|gpt-5\.6-sol-max)\b/i, "combined model slug"],
];

// These are external GitHub review identities accepted as untrusted input, not
// host-runtime dependencies. Keep the list narrow and explicit.
const LEGACY_REVIEW_AUTHOR_ALLOWLIST = new Map([
  ["poteto-mode/references/bugbot-triage.md", [/\bBugbot\b/g]],
  ["poteto-mode/playbooks/babysit.md", [/\bBugbot\b/g, /\bbugbot\b/g]],
  ["poteto-mode/playbooks/autopilot-full.md", [/\bBugbot\b/g]],
  ["poteto-mode/playbooks/autopilot-stack.md", [/\bBugbot\b/g]],
  ["poteto-mode/playbooks/multi-phase-plan.md", [/\bBugbot\b/g]],
]);

async function markdownFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".md") ? [absolute] : [];
  }));
  return nested.flat();
}

test("all skill runtime instructions use the central Codex contract", async () => {
  const files = await markdownFiles(skillsRoot);
  const failures = [];

  for (const file of files) {
    const relative = path.relative(skillsRoot, file);
    let content = await fs.readFile(file, "utf8");
    for (const allowed of LEGACY_REVIEW_AUTHOR_ALLOWLIST.get(relative) ?? []) {
      content = content.replace(allowed, "LEGACY_REVIEW_AUTHOR");
    }
    for (const [pattern, label] of FORBIDDEN_RUNTIME_PATTERNS) {
      if (pattern.test(content)) failures.push(`${relative}: ${label}`);
    }
  }

  assert.deepEqual(failures, []);
});

test("representative behavior fixtures declare authority, fallback, and proof", async () => {
  const fixtureRoot = path.join(root, "tests", "skill-behavior");
  const fixtures = (await fs.readdir(fixtureRoot)).filter((name) => name.endsWith(".yaml"));
  assert.deepEqual(fixtures.sort(), [
    "capability-fallbacks.yaml",
    "lifecycle-authority.yaml",
    "orchestration.yaml",
    "recall.yaml",
  ]);

  for (const fixture of fixtures) {
    const content = await fs.readFile(path.join(fixtureRoot, fixture), "utf8");
    assert.match(content, /authority:/);
    assert.match(content, /expected:/);
    assert.match(content, /proof:/);
  }
});

test("all playbooks and orchestrated skills cite the runtime contract", async () => {
  const playbookRoot = path.join(skillsRoot, "poteto-mode", "playbooks");
  for (const file of await markdownFiles(playbookRoot)) {
    assert.match(await fs.readFile(file, "utf8"), /codex-agent-runtime\.md/, path.relative(root, file));
  }

  const orchestrated = [
    "architect", "arena", "automate-me", "blast-radius", "create-verification-skill",
    "figure-it-out", "how", "interrogate", "maintain-verification-skill", "no-comments",
    "recall", "reflect", "show-me-your-work", "swarm", "why",
  ];
  for (const name of orchestrated) {
    const file = path.join(skillsRoot, name, "SKILL.md");
    assert.match(await fs.readFile(file, "utf8"), /codex-agent-runtime\.md/, name);
  }
});

test("model-role guidance passes the complete spawn configuration", async () => {
  const files = [
    "skills/setup-pstack/references/model-profile.md",
    "skills/poteto-mode/SKILL.md",
    "skills/poteto-mode/references/codex-agent-runtime.md",
  ];
  for (const relativePath of files) {
    const content = await fs.readFile(path.join(root, relativePath), "utf8");
    assert.match(content, /model.*reasoning_effort.*service_tier/is, relativePath);
    assert.match(content, /standard (?:lane|lanes|mode).*omit(?:s)? `service_tier`/i, relativePath);
  }
});

test("internal review delegation cannot create a separate task", async () => {
  const runtime = await fs.readFile(
    path.join(skillsRoot, "poteto-mode", "references", "codex-agent-runtime.md"),
    "utf8",
  );
  const noComments = await fs.readFile(path.join(skillsRoot, "no-comments", "SKILL.md"), "utf8");

  assert.match(runtime, /Call `spawn_agent` for both custom agents and built-in agents/);
  assert.match(runtime, /Never use `create_thread` or another separate-task API for a subagent/);
  assert.match(runtime, /Custom agent names are never workflow role inputs/);
  assert.match(noComments, /`agent_type: "pstack-comment-sicko"`/);
  assert.match(noComments, /`agent_type: "default"`/);
  assert.match(noComments, /Call `wait_agent` because step 2 requires the report/);
  assert.match(noComments, /If `spawn_agent` is unavailable, report the review capability as blocked/);
});

test("subagent results use fifteen-minute waits and monitored completion callbacks", async () => {
  const runtime = await fs.readFile(
    path.join(skillsRoot, "poteto-mode", "references", "codex-agent-runtime.md"),
    "utf8",
  );

  assert.match(runtime, /call `wait_agent` once on all active subagents with a 15-minute timeout/);
  assert.match(runtime, /never a subagent deadline/);
  assert.match(runtime, /Continue until all requested results are available, then consolidate them in the main thread/);
  assert.match(runtime, /Never stop an active subagent, close its agent thread, or replace it because one or more waits timed out/);
  assert.match(runtime, /one-line pstack completion callback to the main thread/);
  assert.match(runtime, /schedule one follow-up turn in the main thread for 15 minutes after spawning the subagent/);
  assert.match(runtime, /callbacks have not arrived/);
  assert.match(runtime, /call `wait_agent` on the active subagents for 15 minutes at the next drain point instead/);
  assert.match(runtime, /After verifying a final result, close the completed agent thread/);
});
