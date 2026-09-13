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
  [/(?:\bGlob\b|\bGrep\b|`Read` tool)/, "Claude file-tool name"],
  [/\bcloud[- ]agent\b/i, "Cursor cloud-agent recipe"],
  [/(?:terminal\s+)?\/loop\b|cloud-sleeper|monitored-shell[^\n]*sleep/i, "unsupported loop mechanic"],
  [/supported Codex task history\/?|supported task history\//i, "invented task-history path"],
  [/\bcreate-skill\b|`mcps\/`/i, "non-Codex skill or connector discovery"],
  [/\b(?:claude-fable-5(?:-1)?-thinking-(?:xhigh|max)|grok-4\.6-fast-xhigh|claude-opus-5-thinking-xhigh|gpt-5\.6-sol-max|gpt-6-astra-high)\b/i, "combined model slug"],
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
    content = content.replaceAll("cursor/grok-4.6", "EXTERNAL_MODEL_ID");
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

test("model-role guidance loads the shared configuration policy", async () => {
  const files = [
    "skills/poteto-mode/SKILL.md",
    "skills/poteto-mode/references/codex-agent-runtime.md",
  ];
  for (const relativePath of files) {
    const content = await fs.readFile(path.join(root, relativePath), "utf8");
    assert.match(content, /setup-pstack\/references\/model-profile\.md/, relativePath);
  }
  const policy = await fs.readFile(path.join(root, "skills/setup-pstack/references/model-profile.md"), "utf8");
  assert.match(policy, /model.*reasoning_effort.*service_tier/is);
  assert.match(policy, /codex-subagent-lifecycle\.md/);
});

test("PR stack workflows use GitHub base branches and regression lanes", async () => {
  const relativePaths = [
    "skills/poteto-mode/playbooks/autopilot-full.md",
    "skills/poteto-mode/playbooks/autopilot-stack.md",
    "skills/poteto-mode/playbooks/babysit.md",
    "skills/poteto-mode/playbooks/multi-phase-plan.md",
    "skills/poteto-mode/playbooks/opening-a-pr.md",
    "skills/poteto-mode/playbooks/shipping.md",
  ];
  const content = await Promise.all(relativePaths.map((relativePath) => fs.readFile(path.join(root, relativePath), "utf8")));
  for (const [index, source] of content.entries()) {
    assert.doesNotMatch(source, /Graphite|\bgt\b|\borigin pr\b/i, relativePaths[index]);
  }
  assert.match(content[1], /base-branch stack/);
  assert.match(content[3], /Regression lane against trunk/);
  assert.match(content[4], /gh pr create --base/);
  assert.match(content[5], /gh pr merge <pr> --squash --auto/);
  assert.match(content[5], /base-to-head.*patch-id|patch-id.*base-to-head/s);
});

test("TypeScript guidance prefers existing runtime schemas over duplicate guards", async () => {
  const [skill, patterns] = await Promise.all([
    fs.readFile(path.join(root, "skills/typescript-best-practices/SKILL.md"), "utf8"),
    fs.readFile(path.join(root, "skills/typescript-best-practices/references/patterns.md"), "utf8"),
  ]);
  assert.match(skill, /Schemas before guards/);
  assert.match(patterns, /z\.infer/);
  assert.match(patterns, /Do not add a new dependency for one guard/);
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
  assert.match(noComments, /Start the `pstack-comment-sicko` custom agent/);
  assert.match(noComments, /Follow `\.\.\/poteto-mode\/references\/codex-subagent-lifecycle\.md`/);
  assert.doesNotMatch(noComments, /`agent_type: "default"`/);
  assert.match(noComments, /If no subagent can run, report the review capability as blocked/);
});

test("Poteto delegates custom-agent fallback to the shared lifecycle", async () => {
  const runtime = await fs.readFile(
    path.join(skillsRoot, "poteto-mode", "references", "codex-agent-runtime.md"),
    "utf8",
  );

  assert.match(runtime, /follow the \[subagent lifecycle\]\(codex-subagent-lifecycle\.md\)/);
  assert.match(runtime, /It owns custom-agent startup and fallback, result delivery, waiting/);
  assert.doesNotMatch(runtime, /start a `default` agent with the complete portable persona prompt/);
  assert.doesNotMatch(runtime, /pstack completion callback/);
  assert.doesNotMatch(runtime, /15-minute timeout/);
});

test("bundled lifecycle owns portable custom-agent fallback", async () => {
  const [lifecycle, runtime, noComments, poteto] = await Promise.all([
    fs.readFile(path.join(skillsRoot, "poteto-mode", "references", "codex-subagent-lifecycle.md"), "utf8"),
    fs.readFile(path.join(skillsRoot, "poteto-mode", "references", "codex-agent-runtime.md"), "utf8"),
    fs.readFile(path.join(skillsRoot, "no-comments", "SKILL.md"), "utf8"),
    fs.readFile(path.join(skillsRoot, "poteto-mode", "SKILL.md"), "utf8"),
  ]);

  assert.match(lifecycle, /`pstack-poteto-agent`: `poteto-agent-prompt\.md`/);
  assert.match(lifecycle, /`pstack-comment-sicko`: `\.\.\/\.\.\/no-comments\/references\/comment-sicko-prompt\.md`/);
  assert.match(lifecycle, /start a `default` agent with the complete portable persona prompt/);
  assert.match(lifecycle, /must not invoke the owning orchestration skill or start another copy of itself/);
  assert.doesNotMatch(runtime, /poteto-agent-prompt\.md|comment-sicko-prompt\.md/);
  assert.doesNotMatch(noComments, /comment-sicko-prompt\.md/);
  assert.doesNotMatch(poteto, /poteto-agent-prompt\.md/);
});

test("runtime loads storage policy before allocation and closeout", async () => {
  const runtime = await fs.readFile(path.join(skillsRoot, "poteto-mode/references/codex-agent-runtime.md"), "utf8");
  assert.match(runtime, /Before creating audit or verification scratch, and at task closeout, read \[Audit storage\]\(codex-audit-storage.md\)/);
  const storage = await fs.readFile(path.join(skillsRoot, "poteto-mode/references/codex-audit-storage.md"), "utf8");
  assert.match(storage, /current task status, process\/open-file checks, and Git inspection/);
  assert.match(storage, /one owned scratch host per concurrent verification lane/);
});
