import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MODEL_ROLE_SPECS, resolveModelPolicy, resolveRoleRegistry } from "../skills/setup-pstack/scripts/manage-agents.mjs";

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

test("unobservable model inventory inherits and labels the requested pair unverified", () => {
  const result = resolveModelPolicy({
    requested: { model: "gpt-future", reasoning_effort: "high" },
    observableModels: null,
  });
  assert.deepEqual(result, {
    status: "unverified-inheritance",
    requested: { model: "gpt-future", reasoning_effort: "high" },
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
  const pair = { model: "gpt-5.6-sol", reasoning_effort: "high" };
  const roleProfile = Object.fromEntries(
    MODEL_ROLE_SPECS.map((spec) => [spec.name, spec.kind === "panel" ? [pair, "inherit-parent"] : pair]),
  );
  const result = resolveRoleRegistry({
    roleProfile,
    observableModels: [{ slug: "gpt-5.6-sol", reasoning_efforts: ["high"] }],
  });

  assert.deepEqual(Object.keys(result.roles), MODEL_ROLE_SPECS.map((spec) => spec.name));
  for (const spec of MODEL_ROLE_SPECS) {
    assert.equal(result.roles[spec.name].length, spec.kind === "panel" ? 2 : 1);
    assert.deepEqual(result.roles[spec.name][0], pair);
  }
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
