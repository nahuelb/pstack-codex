import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MODEL_ROLE_SPECS,
  resolveModelPolicy,
  resolveRoleRegistry,
  resolveRuntimeRole,
} from "../skills/setup-pstack/scripts/manage-agents.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedRoles = [
  "feature, refactoring",
  "bug-fix",
  "perf-issue",
  "hillclimb",
  "judgment and prose",
  "hardest tasks",
  "how explorer",
  "how explainer",
  "how critics",
  "why investigators",
  "why synthesizer",
  "reflect tooling",
  "reflect judgment, divergent, synthesizer",
  "arena runners",
  "arena cross-judge pool",
  "swarm workers",
  "architect runners",
  "interrogate reviewers",
];

test("unobservable model inventory preserves the requested spawn configuration and inherits", () => {
  const requested = { model: "gpt-5.6-luna", reasoning_effort: "max", service_tier: "priority" };
  const result = resolveModelPolicy({
    requested,
    observableModels: null,
  });
  assert.deepEqual(result, {
    status: "unverified-inheritance",
    requested,
    resolved: null,
    toml: {},
  });
});

test("observable model inventory validates the exact model and reasoning pair", () => {
  const observableModels = [
    { slug: "gpt-5.6-sol", reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  ];
  assert.deepEqual(
    resolveModelPolicy({ requested: { model: "gpt-5.6-sol", reasoning_effort: "high" }, observableModels }),
    {
      status: "verified-explicit",
      requested: { model: "gpt-5.6-sol", reasoning_effort: "high" },
      resolved: { model: "gpt-5.6-sol", reasoning_effort: "high" },
      toml: { model: "gpt-5.6-sol", model_reasoning_effort: "high" },
    },
  );
  assert.throws(
    () => resolveModelPolicy({ requested: { model: "gpt-5.6-sol", reasoning_effort: "impossible" }, observableModels }),
    /does not support reasoning effort/,
  );
  assert.throws(
    () => resolveModelPolicy({ requested: { model: "missing", reasoning_effort: "high" }, observableModels }),
    /is not in the observable model list/,
  );
});

test("observable model inventory validates and preserves a requested service tier", () => {
  const requested = { model: "gpt-5.6-luna", reasoning_effort: "max", service_tier: "priority" };
  const observableModels = [
    { slug: "gpt-5.6-luna", reasoning_efforts: ["max"], service_tiers: ["priority"] },
  ];
  assert.deepEqual(resolveModelPolicy({ requested, observableModels, serviceTierOverrideSupported: true }), {
    status: "verified-explicit",
    requested,
    resolved: requested,
    toml: { model: "gpt-5.6-luna", model_reasoning_effort: "max", service_tier: "priority" },
  });
  assert.throws(
    () => resolveModelPolicy({
      requested,
      observableModels: [{ ...observableModels[0], service_tiers: [] }],
      serviceTierOverrideSupported: true,
    }),
    /does not support service tier "priority"/,
  );
});

test("a fast request inherits when the per-agent tier override is absent or unverified", () => {
  const requested = { model: "gpt-5.6-luna", reasoning_effort: "max", service_tier: "priority" };
  const observableModels = [
    { slug: "gpt-5.6-luna", reasoning_efforts: ["max"], service_tiers: ["priority"] },
  ];
  assert.equal(
    resolveModelPolicy({ requested, observableModels }).unverified_reason,
    "service-tier-override-unverified",
  );
  assert.equal(
    resolveModelPolicy({ requested, observableModels, serviceTierOverrideSupported: false }).unverified_reason,
    "service-tier-override-unavailable",
  );
});

test("no requested pair inherits without pretending runtime resolution is observable", () => {
  assert.deepEqual(resolveModelPolicy({ requested: null, observableModels: [] }), {
    status: "inherited",
    requested: null,
    resolved: null,
    toml: {},
  });
});

test("role configuration preserves every upstream role and panel cardinality", () => {
  assert.deepEqual(MODEL_ROLE_SPECS.map((spec) => spec.name), expectedRoles);
  const standard = { model: "gpt-5.6-sol", reasoning_effort: "high" };
  const fast = { model: "gpt-5.6-luna", reasoning_effort: "max", service_tier: "priority" };
  const roleProfile = Object.fromEntries(
    MODEL_ROLE_SPECS.map((spec) => [spec.name, spec.kind === "panel" ? [standard, fast] : standard]),
  );
  const result = resolveRoleRegistry({
    roleProfile,
    serviceTierOverrideSupported: true,
    observableModels: [
      { slug: "gpt-5.6-sol", reasoning_efforts: ["high"] },
      { slug: "gpt-5.6-luna", reasoning_efforts: ["max"], service_tiers: ["priority"] },
    ],
  });

  assert.deepEqual(Object.keys(result.roles), MODEL_ROLE_SPECS.map((spec) => spec.name));
  for (const spec of MODEL_ROLE_SPECS) {
    assert.equal(result.roles[spec.name].length, spec.kind === "panel" ? 2 : 1);
    assert.deepEqual(result.roles[spec.name][0], standard);
    if (spec.kind === "panel") assert.deepEqual(result.roles[spec.name][1], fast);
  }
});

test("an unobservable fast role inherits while its policy retains the requested configuration", () => {
  const requested = { model: "gpt-5.6-luna", reasoning_effort: "max", service_tier: "priority" };
  const result = resolveRoleRegistry({ roleProfile: { "bug-fix": requested } });
  assert.deepEqual(result.roles["bug-fix"], [{ inherit_parent: true }]);
  assert.deepEqual(result.policies["bug-fix"][0].requested, requested);
});

test("role configuration rejects unknown roles and invalid single-role fanout", () => {
  assert.throws(() => resolveRoleRegistry({ roleProfile: { unknown: "inherit-parent" } }), /unknown pstack model role/);
  assert.throws(
    () => resolveRoleRegistry({ roleProfile: { "bug-fix": ["inherit-parent", "inherit-parent"] } }),
    /accepts exactly one lane/,
  );
  assert.throws(
    () => resolveRoleRegistry({ roleProfile: { "bug-fix": { inherit_parent: true, model: "unexpected" } } }),
    /must include both model and reasoning_effort/,
  );
  assert.throws(
    () => resolveRoleRegistry({
      roleProfile: { "bug-fix": { model: "gpt-5.6-luna", reasoning_effort: "max", fast: true } },
      observableModels: [{ slug: "gpt-5.6-luna", reasoning_efforts: ["max"] }],
    }),
    /may contain only model, reasoning_effort, and service_tier/,
  );
});

test("an overridden role can return to its owning Markdown skill default", () => {
  const result = resolveRoleRegistry({
    roleProfile: {
      "bug-fix": "skill-default",
      "how critics": ["default", { use_skill_default: true }],
    },
  });
  assert.deepEqual(result.roles["bug-fix"], [{ use_skill_default: true }]);
  assert.deepEqual(result.roles["how critics"], [{ use_skill_default: true }, { use_skill_default: true }]);
  assert.equal(result.policies["bug-fix"][0].status, "skill-default");
});

test("omitted roles use their owning Markdown skill defaults", () => {
  const result = resolveRoleRegistry();
  for (const spec of MODEL_ROLE_SPECS) {
    const expectedLaneCount = spec.kind === "panel" ? 4 : 1;
    assert.equal(result.roles[spec.name].length, expectedLaneCount);
    assert.equal(result.policies[spec.name].length, expectedLaneCount);
    assert.ok(result.roles[spec.name].every((lane) => lane.use_skill_default === true));
    assert.ok(result.policies[spec.name].every((policy) => policy.status === "skill-default"));
  }
});

async function writeRegistry(rootDirectory, roles) {
  const directory = path.join(rootDirectory, ".codex");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "pstack-models.json"),
    `${JSON.stringify({ schema_version: 1, owner: "pstack-for-codex/setup-pstack", roles }, null, 2)}\n`,
  );
}

test("runtime role resolution preserves the nearest configured spawn configuration", async (t) => {
  const temporary = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "pstack-runtime-role-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  const nested = path.join(projectRoot, "packages/app/src");
  const userHome = path.join(temporary, "user");
  const defaults = resolveRoleRegistry().roles;
  await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await fs.mkdir(nested, { recursive: true });
  await writeRegistry(userHome, { ...defaults, "arena cross-judge pool": [{ model: "anthropic/claude-opus-5", reasoning_effort: "xhigh" }] });
  const fast = { model: "gpt-5.6-luna", reasoning_effort: "max", service_tier: "priority" };
  await writeRegistry(projectRoot, { ...defaults, "arena cross-judge pool": [fast] });

  const result = await resolveRuntimeRole({ roleName: "arena cross-judge pool", projectRoot: nested, userHome });

  assert.equal(result.registryPath, path.join(projectRoot, ".codex/pstack-models.json"));
  assert.deepEqual(result.resolvedLanes, [fast]);
});

test("runtime role resolution finds ancestor registries without Git and falls back to user scope", async (t) => {
  const temporary = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "pstack-runtime-role-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  const nested = path.join(projectRoot, "packages/app/src");
  const userHome = path.join(temporary, "user");
  const roles = resolveRoleRegistry().roles;
  roles["arena cross-judge pool"] = [{ model: "anthropic/claude-opus-5", reasoning_effort: "high" }];
  await fs.mkdir(nested, { recursive: true });
  await writeRegistry(projectRoot, roles);
  assert.equal((await resolveRuntimeRole({ roleName: "arena cross-judge pool", projectRoot: nested, userHome })).registryPath, path.join(projectRoot, ".codex/pstack-models.json"));

  await fs.rm(path.join(projectRoot, ".codex/pstack-models.json"));
  await writeRegistry(userHome, roles);
  assert.equal((await resolveRuntimeRole({ roleName: "arena cross-judge pool", projectRoot: nested, userHome })).registryPath, path.join(userHome, ".codex/pstack-models.json"));
});

test("runtime role resolution expands defaults and fails closed on invalid project configuration", async (t) => {
  const temporary = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "pstack-runtime-role-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  const userHome = path.join(temporary, "user");
  const unavailable = await resolveRuntimeRole({ roleName: "arena cross-judge pool", projectRoot, userHome });
  assert.equal(unavailable.status, "registry-unavailable");
  assert.deepEqual(unavailable.resolvedLanes, MODEL_ROLE_SPECS.find((spec) => spec.name === "arena cross-judge pool").defaults);

  await writeRegistry(userHome, resolveRoleRegistry().roles);
  await fs.mkdir(path.join(projectRoot, ".codex"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".codex/pstack-models.json"), "{}\n");
  await assert.rejects(resolveRuntimeRole({ roleName: "arena cross-judge pool", projectRoot, userHome }), /invalid pstack model registry/);
});

test("runtime contracts require role resolution and state its enforcement limit", async () => {
  const [profile, runtime, arena, trail] = await Promise.all([
    fs.readFile(path.join(root, "skills/setup-pstack/references/model-profile.md"), "utf8"),
    fs.readFile(path.join(root, "skills/poteto-mode/references/codex-agent-runtime.md"), "utf8"),
    fs.readFile(path.join(root, "skills/arena/SKILL.md"), "utf8"),
    fs.readFile(path.join(root, "skills/show-me-your-work/SKILL.md"), "utf8"),
  ]);
  assert.match(profile, /Select only from `resolvedLanes`/);
  assert.match(profile, /cannot make violations impossible/);
  assert.match(runtime, /Generic and `default` agents still use the role resolver/);
  assert.match(runtime, /`service_tier` when present together/);
  assert.match(arena, /Choose one exact resolved lane/);
  assert.match(trail, /resolve `arena cross-judge pool`/);
});

test("owning Markdown skills retain the original PStack default model choices", async () => {
  const expectations = [
    ["skills/poteto-mode/SKILL.md", /xai\/grok-4\.6` at `xhigh`.*gpt-5\.6-sol` at `max`.*anthropic\/claude-fable-5` at `max`/s],
    ["skills/how/SKILL.md", /how explorer.*xai\/grok-4\.6.*xhigh.*how explainer.*anthropic\/claude-fable-5.*max.*how critics.*anthropic\/claude-opus-5.*xhigh/s],
    ["skills/why/SKILL.md", /why investigators.*xai\/grok-4\.6.*xhigh.*why synthesizer.*anthropic\/claude-fable-5.*max/s],
    ["skills/reflect/SKILL.md", /reflect tooling.*gpt-5\.6-sol.*max.*reflect judgment, divergent, synthesizer.*anthropic\/claude-fable-5.*max/s],
    ["skills/arena/SKILL.md", /arena runners.*anthropic\/claude-fable-5.*gpt-5\.6-sol.*xai\/grok-4\.6.*anthropic\/claude-opus-5/s],
    ["skills/swarm/SKILL.md", /swarm workers.*xai\/grok-4\.6.*xhigh/s],
    ["skills/architect/SKILL.md", /architect runners.*anthropic\/claude-fable-5.*gpt-5\.6-sol.*xai\/grok-4\.6.*anthropic\/claude-opus-5/s],
    ["skills/interrogate/SKILL.md", /interrogate reviewers.*anthropic\/claude-fable-5.*gpt-5\.6-sol.*xai\/grok-4\.6.*anthropic\/claude-opus-5/s],
  ];
  for (const [relativePath, pattern] of expectations) {
    assert.match(await fs.readFile(path.join(root, relativePath), "utf8"), pattern, relativePath);
  }
});
