#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROLE_SPECS = [
  {
    name: "pstack-poteto-agent",
    template: "templates/codex-agents/pstack-poteto-agent.toml",
    prompt: "skills/poteto-mode/references/poteto-agent-prompt.md",
    capability: {
      sandbox: "inherited-unverified-at-setup",
      writable_scope: "active-request-only",
      connectors: "inherited-main-agent-authority",
      skills: ["principle-*"],
      fallback: "generic-agent-with-portable-prompt-or-sequential-main-agent",
    },
  },
  {
    name: "pstack-comment-sicko",
    template: "templates/codex-agents/pstack-comment-sicko.toml",
    prompt: "skills/no-comments/references/comment-sicko-prompt.md",
    capability: {
      sandbox: "requested-read-only-unverified-until-runtime",
      writable_scope: "none",
      connectors: "prohibited-fail-closed-if-not-constrained",
      skills: ["how", "why"],
      fallback: "constrained-generic-agent-or-skip",
    },
  },
];

const MULTI_MODEL_DEFAULTS = [
  { model: "anthropic/claude-fable-5-1", reasoning_effort: "xhigh" },
  { model: "gpt-5.6-sol", reasoning_effort: "xhigh" },
  { model: "xai/grok-4.6", reasoning_effort: "xhigh" },
  { model: "anthropic/claude-opus-5", reasoning_effort: "xhigh" },
];

export const MODEL_ROLE_SPECS = [
  { name: "feature, refactoring", kind: "single", defaults: [{ model: "xai/grok-4.6", reasoning_effort: "xhigh" }] },
  { name: "bug-fix", kind: "single", defaults: [{ model: "gpt-5.6-sol", reasoning_effort: "xhigh" }] },
  { name: "perf-issue", kind: "single", defaults: [{ model: "gpt-5.6-sol", reasoning_effort: "xhigh" }] },
  { name: "hillclimb", kind: "single", defaults: [{ model: "gpt-5.6-sol", reasoning_effort: "xhigh" }] },
  { name: "judgment and prose", kind: "single", defaults: [{ model: "anthropic/claude-fable-5-1", reasoning_effort: "xhigh" }] },
  { name: "hardest tasks", kind: "single", defaults: [{ model: "anthropic/claude-fable-5-1", reasoning_effort: "xhigh" }] },
  { name: "how explorer", kind: "single", defaults: [{ model: "xai/grok-4.6", reasoning_effort: "xhigh" }] },
  { name: "how explainer", kind: "single", defaults: [{ model: "anthropic/claude-fable-5-1", reasoning_effort: "xhigh" }] },
  { name: "how critics", kind: "panel", defaults: MULTI_MODEL_DEFAULTS },
  { name: "why investigators", kind: "single", defaults: [{ model: "xai/grok-4.6", reasoning_effort: "xhigh" }] },
  { name: "why synthesizer", kind: "single", defaults: [{ model: "anthropic/claude-fable-5-1", reasoning_effort: "xhigh" }] },
  { name: "reflect tooling", kind: "single", defaults: [{ model: "gpt-5.6-sol", reasoning_effort: "xhigh" }] },
  { name: "reflect judgment, divergent, synthesizer", kind: "single", defaults: [{ model: "anthropic/claude-fable-5-1", reasoning_effort: "xhigh" }] },
  { name: "arena runners", kind: "panel", defaults: MULTI_MODEL_DEFAULTS },
  { name: "arena cross-judge pool", kind: "panel", defaults: MULTI_MODEL_DEFAULTS },
  { name: "swarm workers", kind: "single", defaults: [{ model: "xai/grok-4.6", reasoning_effort: "xhigh" }] },
  { name: "architect runners", kind: "panel", defaults: MULTI_MODEL_DEFAULTS },
  { name: "interrogate reviewers", kind: "panel", defaults: MULTI_MODEL_DEFAULTS },
];

const RECEIPT_OWNER = "pstack-for-codex/setup-pstack";
const REGISTRY_FILENAME = "pstack-models.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function layer(scope, projectRoot, userHome) {
  if (scope === "project") {
    return {
      root: projectRoot,
      agentsDir: path.join(projectRoot, ".codex/agents"),
      receipt: path.join(projectRoot, ".codex/pstack-for-codex-agent-receipt.json"),
      registry: path.join(projectRoot, `.codex/${REGISTRY_FILENAME}`),
      relative: (file) => path.relative(projectRoot, file),
    };
  }
  if (scope === "user") {
    const codexRoot = path.join(userHome, ".codex");
    return {
      root: codexRoot,
      agentsDir: path.join(codexRoot, "agents"),
      receipt: path.join(codexRoot, "pstack-for-codex-agent-receipt.json"),
      registry: path.join(codexRoot, REGISTRY_FILENAME),
      relative: (file) => path.relative(codexRoot, file),
    };
  }
  throw new Error(`unsupported scope "${scope}"; expected project or user`);
}

async function listToml(directory, scope) {
  let filenames;
  try {
    filenames = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const filename of filenames.sort()) {
    if (!filename.endsWith(".toml")) continue;
    const file = path.join(directory, filename);
    const content = await fs.readFile(file, "utf8");
    const match = content.match(/^\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/m);
    if (!match) continue;
    records.push({ name: match[1] === undefined ? match[2] : JSON.parse(`"${match[1]}"`), file, scope });
  }
  return records;
}

export async function scanAgentNames({ projectRoot = process.cwd(), userHome = os.homedir() } = {}) {
  const records = [
    ...(await listToml(path.join(projectRoot, ".codex/agents"), "project")),
    ...(await listToml(path.join(userHome, ".codex/agents"), "user")),
  ];
  const byName = new Map();
  for (const record of records) {
    const matches = byName.get(record.name) ?? [];
    matches.push(record);
    byName.set(record.name, matches);
  }
  return {
    records,
    duplicates: [...byName.entries()]
      .filter(([, matches]) => matches.length > 1)
      .map(([name, matches]) => ({ name, files: matches.map((record) => record.file) })),
  };
}

export function resolveModelPolicy({
  requested = null,
  observableModels = null,
  serviceTierOverrideSupported = null,
} = {}) {
  if (!requested) return { status: "inherited", requested: null, resolved: null, toml: {} };
  if (!requested.model || !requested.reasoning_effort) {
    throw new Error("a model request must include both model and reasoning_effort");
  }
  if (!Object.keys(requested).every((key) => key === "model" || key === "reasoning_effort" || key === "service_tier")) {
    throw new Error("a model request may contain only model, reasoning_effort, and service_tier");
  }
  if (
    requested.service_tier !== undefined &&
    (typeof requested.service_tier !== "string" || requested.service_tier.length === 0)
  ) {
    throw new Error("service_tier must be a non-empty string when requested");
  }
  if (observableModels === null) {
    return { status: "unverified-inheritance", requested, resolved: null, toml: {} };
  }
  const model = observableModels.find((candidate) => candidate.slug === requested.model);
  if (!model) throw new Error(`model "${requested.model}" is not in the observable model list`);
  const efforts = model.reasoning_efforts ?? [];
  if (!efforts.includes(requested.reasoning_effort)) {
    throw new Error(`model "${requested.model}" does not support reasoning effort "${requested.reasoning_effort}"`);
  }
  const serviceTiers = model.service_tiers ?? [];
  if (requested.service_tier !== undefined && !serviceTiers.includes(requested.service_tier)) {
    throw new Error(`model "${requested.model}" does not support service tier "${requested.service_tier}"`);
  }
  if (requested.service_tier !== undefined && serviceTierOverrideSupported !== true) {
    return {
      status: "unverified-inheritance",
      requested,
      resolved: null,
      toml: {},
      unverified_reason:
        serviceTierOverrideSupported === false
          ? "service-tier-override-unavailable"
          : "service-tier-override-unverified",
    };
  }
  const toml = { model: requested.model, model_reasoning_effort: requested.reasoning_effort };
  if (requested.service_tier !== undefined) toml.service_tier = requested.service_tier;
  return {
    status: "verified-explicit",
    requested,
    resolved: { ...requested },
    toml,
  };
}

function inheritedLane(lane) {
  return (
    lane === null ||
    lane === undefined ||
    lane === "inherit-parent" ||
    lane === "auto" ||
    (lane && typeof lane === "object" && lane.inherit_parent === true && Object.keys(lane).length === 1)
  );
}

function skillDefaultLane(lane) {
  return (
    lane === "skill-default" ||
    lane === "default" ||
    (lane && typeof lane === "object" && lane.use_skill_default === true && Object.keys(lane).length === 1)
  );
}

function requestedLanes(spec, roleProfile) {
  const requested = roleProfile?.[spec.name];
  if (requested === undefined || requested === null) return [null];
  const lanes = Array.isArray(requested) ? requested : [requested];
  if (!lanes.length) throw new Error(`model role "${spec.name}" must contain at least one lane`);
  if (spec.kind === "single" && lanes.length !== 1) {
    throw new Error(`model role "${spec.name}" accepts exactly one lane`);
  }
  return lanes;
}

export function resolveRoleRegistry({
  roleProfile = {},
  existingRoles = {},
  existingPolicies = {},
  observableModels = null,
  serviceTierOverrideSupported = null,
} = {}) {
  const allowed = new Set(MODEL_ROLE_SPECS.map((spec) => spec.name));
  for (const roleName of Object.keys(roleProfile ?? {})) {
    if (!allowed.has(roleName)) throw new Error(`unknown pstack model role "${roleName}"`);
  }

  const roles = {};
  const policies = {};
  for (const spec of MODEL_ROLE_SPECS) {
    if (!Object.hasOwn(roleProfile, spec.name) && Object.hasOwn(existingRoles, spec.name)) {
      if (observableModels !== null) {
        const preservedPolicies = existingRoles[spec.name].map((lane) => {
          if (lane.use_skill_default === true) {
            return { status: "skill-default", requested: null, resolved: null, toml: {} };
          }
          return resolveModelPolicy({
            requested: lane.inherit_parent === true ? null : lane,
            observableModels,
            serviceTierOverrideSupported,
          });
        });
        roles[spec.name] = preservedPolicies.map((policy) =>
          policy.status === "verified-explicit"
            ? { ...policy.resolved }
            : policy.status === "skill-default"
              ? { use_skill_default: true }
              : { inherit_parent: true },
        );
        policies[spec.name] = preservedPolicies;
        continue;
      }
      const existingLanes = structuredClone(existingRoles[spec.name]);
      const existingRolePolicies = structuredClone(existingPolicies[spec.name] ?? []);
      roles[spec.name] = existingLanes.map((lane) =>
        serviceTierOverrideSupported === false && lane.service_tier !== undefined
          ? { inherit_parent: true }
          : lane,
      );
      policies[spec.name] = existingLanes.map((lane, index) =>
        serviceTierOverrideSupported === false && lane.service_tier !== undefined
          ? {
              status: "unverified-inheritance",
              requested: lane,
              resolved: null,
              toml: {},
              unverified_reason: "service-tier-override-unavailable",
            }
          : existingRolePolicies[index],
      );
      continue;
    }
    if (!Object.hasOwn(roleProfile, spec.name)) {
      const laneCount = spec.kind === "panel" ? 4 : 1;
      roles[spec.name] = Array.from({ length: laneCount }, () => ({ use_skill_default: true }));
      policies[spec.name] = Array.from({ length: laneCount }, () => ({
        status: "skill-default",
        requested: null,
        resolved: null,
        toml: {},
      }));
      continue;
    }
    const rolePolicies = requestedLanes(spec, roleProfile).map((lane, index) => {
      if (!skillDefaultLane(lane)) {
        return resolveModelPolicy({
          requested: inheritedLane(lane) ? null : lane,
          observableModels,
          serviceTierOverrideSupported,
        });
      }
      if (!spec.defaults[index]) throw new Error(`pstack model role "${spec.name}" has no bundled default for lane ${index + 1}`);
      return { status: "skill-default", requested: null, resolved: null, toml: {} };
    });
    policies[spec.name] = rolePolicies;
    roles[spec.name] = rolePolicies.map((policy) =>
      policy.status === "verified-explicit"
        ? { ...policy.resolved }
        : policy.status === "skill-default"
          ? { use_skill_default: true }
          : { inherit_parent: true },
    );
  }
  return { roles, policies };
}

function validateRoleRegistry(registry) {
  if (!registry || registry.schema_version !== 1 || registry.owner !== RECEIPT_OWNER) {
    throw new Error("pstack model registry has an unknown owner or schema; review it before continuing");
  }
  if (!registry.roles || typeof registry.roles !== "object" || Array.isArray(registry.roles)) {
    throw new Error("pstack model registry roles must be an object");
  }
  const expected = new Set(MODEL_ROLE_SPECS.map((spec) => spec.name));
  const actual = new Set(Object.keys(registry.roles));
  const missing = [...expected].filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expected.has(name));
  if (missing.length || extra.length) {
    throw new Error(`pstack model registry role mismatch; missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}`);
  }
  for (const spec of MODEL_ROLE_SPECS) {
    const lanes = registry.roles[spec.name];
    if (!Array.isArray(lanes) || !lanes.length || (spec.kind === "single" && lanes.length !== 1)) {
      throw new Error(`pstack model registry has invalid lane count for "${spec.name}"`);
    }
    for (const [index, lane] of lanes.entries()) {
      const inherited = lane && lane.inherit_parent === true && Object.keys(lane).length === 1;
      const skillDefault = lane && lane.use_skill_default === true && Object.keys(lane).length === 1;
      const explicit =
        lane &&
        typeof lane.model === "string" &&
        lane.model.length > 0 &&
        typeof lane.reasoning_effort === "string" &&
        lane.reasoning_effort.length > 0 &&
        (lane.service_tier === undefined ||
          (typeof lane.service_tier === "string" && lane.service_tier.length > 0)) &&
        Object.keys(lane).every((key) => key === "model" || key === "reasoning_effort" || key === "service_tier");
      if (!inherited && !skillDefault && !explicit) {
        throw new Error(`pstack model registry has an invalid lane for "${spec.name}"`);
      }
      if (skillDefault && !spec.defaults[index]) {
        throw new Error(`pstack model role "${spec.name}" has no bundled default for lane ${index + 1}`);
      }
    }
  }
  return registry;
}

async function findProjectRoot(start) {
  const original = path.resolve(start);
  let current = original;
  while (true) {
    try {
      await fs.lstat(path.join(current, `.codex/${REGISTRY_FILENAME}`));
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await fs.lstat(path.join(current, ".git"));
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return original;
    current = parent;
  }
}

export async function resolveRuntimeRole({ roleName, projectRoot = process.cwd(), userHome = os.homedir() } = {}) {
  const spec = MODEL_ROLE_SPECS.find((candidate) => candidate.name === roleName);
  if (!spec) throw new Error(`unknown pstack model role "${roleName ?? ""}"`);
  const root = await findProjectRoot(projectRoot);
  const candidates = [path.join(root, `.codex/${REGISTRY_FILENAME}`), path.join(userHome, `.codex/${REGISTRY_FILENAME}`)];
  for (const registryPath of candidates) {
    let content;
    try {
      content = await fs.readFile(registryPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    let registry;
    try {
      registry = validateRoleRegistry(JSON.parse(content));
    } catch (error) {
      throw new Error(`invalid pstack model registry at "${registryPath}": ${error.message}`);
    }
    const lanes = structuredClone(registry.roles[roleName]);
    return {
      status: "configured",
      role: roleName,
      kind: spec.kind,
      registryPath,
      lanes,
      resolvedLanes: lanes.map((lane, index) => lane.use_skill_default ? structuredClone(spec.defaults[index]) : lane),
    };
  }
  return {
    status: "registry-unavailable",
    role: roleName,
    kind: spec.kind,
    registryPath: null,
    lanes: null,
    resolvedLanes: structuredClone(spec.defaults),
  };
}

function validateRuntimeCapabilities(runtimeCapabilities) {
  if (!runtimeCapabilities || typeof runtimeCapabilities !== "object" || Array.isArray(runtimeCapabilities)) {
    throw new Error("runtime capabilities must be an object");
  }
  const allowed = new Set(["spawn_service_tier_override", "profile_service_tier_override"]);
  for (const [name, value] of Object.entries(runtimeCapabilities)) {
    if (!allowed.has(name)) throw new Error(`unknown runtime capability "${name}"`);
    if (typeof value !== "boolean") throw new Error(`runtime capability "${name}" must be boolean`);
  }
  return structuredClone(runtimeCapabilities);
}

async function readReceipt(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function expectedPaths(target, schemaVersion) {
  const paths = ROLE_SPECS.map((role) => target.relative(path.join(target.agentsDir, `${role.name}.toml`)));
  if (schemaVersion === 2) paths.push(target.relative(target.registry));
  return paths;
}

function validateReceipt(receipt, scope, target) {
  if (!receipt) return;
  if (![1, 2].includes(receipt.schema_version) || receipt.owner !== RECEIPT_OWNER || receipt.scope !== scope) {
    throw new Error("setup receipt has an unknown owner, schema, or scope; review it before continuing");
  }
  if (!Array.isArray(receipt.files)) throw new Error("setup receipt files must be an array");
  const expected = new Set(expectedPaths(target, receipt.schema_version));
  const seen = new Set();
  for (const record of receipt.files) {
    if (!record || typeof record !== "object" || typeof record.path !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256 ?? "")) {
      throw new Error("setup receipt contains an invalid path or SHA-256");
    }
    if (seen.has(record.path)) throw new Error(`setup receipt contains duplicate path "${record.path}"`);
    if (!expected.has(record.path)) throw new Error(`setup receipt contains unexpected path "${record.path}"`);
    seen.add(record.path);
  }
  const missing = [...expected].filter((expectedPath) => !seen.has(expectedPath));
  if (missing.length) throw new Error(`setup receipt is missing expected path(s): ${missing.join(", ")}`);
}

async function inspectOwnedFiles(receipt, target) {
  if (!receipt) return [];
  const diagnostics = [];
  for (const record of receipt.files) {
    const absolute = path.resolve(target.root, record.path);
    const relativePath = record.path;
    try {
      const content = await fs.readFile(absolute);
      const actual = sha256(content);
      if (actual !== record.sha256) {
        diagnostics.push({ path: relativePath, status: "modified", expected_sha256: record.sha256, actual_sha256: actual });
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        diagnostics.push({ path: relativePath, status: "missing", expected_sha256: record.sha256, actual_sha256: null });
      }
      else throw error;
    }
  }
  return diagnostics;
}

function renderTemplate(template, prompt, modelPolicy) {
  if (prompt.includes('"""')) throw new Error("portable prompt cannot contain a TOML multiline-string terminator");
  const modelLines = Object.entries(modelPolicy.toml)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join("\n");
  return template.replace("{{MODEL_CONFIG}}", modelLines).replace("{{PROMPT}}", prompt.trim());
}

export async function installAgents({
  pluginRoot,
  projectRoot = process.cwd(),
  userHome = os.homedir(),
  scope = "project",
  profile = {},
  roleProfile = null,
  observableModels = null,
  runtimeCapabilities = {},
} = {}) {
  if (!pluginRoot) throw new Error("pluginRoot is required");
  runtimeCapabilities = validateRuntimeCapabilities(runtimeCapabilities);
  const target = layer(scope, projectRoot, userHome);
  const currentReceipt = await readReceipt(target.receipt);
  validateReceipt(currentReceipt, scope, target);
  const divergence = await inspectOwnedFiles(currentReceipt, target);
  if (divergence.length) {
    const summary = divergence.map(({ path: file, status }) => `${file} (${status})`).join(", ");
    throw new Error(
      `review required for divergent pstack-owned files: ${summary}; run uninstall to preserve changed files and archive the receipt`,
    );
  }

  let currentRegistry = null;
  if (currentReceipt?.schema_version === 2) {
    currentRegistry = validateRoleRegistry(JSON.parse(await fs.readFile(target.registry, "utf8")));
  }

  const inventory = await scanAgentNames({ projectRoot, userHome });
  if (inventory.duplicates.length) {
    const duplicate = inventory.duplicates[0];
    throw new Error(`duplicate custom-agent name "${duplicate.name}" across: ${duplicate.files.join(", ")}`);
  }
  const ownedPaths = new Set((currentReceipt?.files ?? []).map((record) => path.resolve(target.root, record.path)));
  for (const role of ROLE_SPECS) {
    const collision = inventory.records.find(
      (record) => record.name === role.name && !ownedPaths.has(path.resolve(record.file)),
    );
    if (collision) throw new Error(`custom-agent name "${role.name}" is already owned by ${collision.file}`);
  }

  const currentPolicies = new Map(
    (currentReceipt?.files ?? [])
      .filter((record) => record.model_policy)
      .map((record) => [path.basename(record.path, ".toml"), record.model_policy.requested]),
  );
  const rendered = [];
  for (const role of ROLE_SPECS) {
    const requested = Object.hasOwn(profile, role.name) ? profile[role.name] : currentPolicies.get(role.name) ?? null;
    const modelPolicy = resolveModelPolicy({
      requested,
      observableModels,
      serviceTierOverrideSupported: runtimeCapabilities.profile_service_tier_override ?? null,
    });
    const [template, prompt] = await Promise.all([
      fs.readFile(path.join(pluginRoot, role.template), "utf8"),
      fs.readFile(path.join(pluginRoot, role.prompt), "utf8"),
    ]);
    const content = `${renderTemplate(template, prompt, modelPolicy).trim()}\n`;
    const file = path.join(target.agentsDir, `${role.name}.toml`);
    rendered.push({ role, modelPolicy, content, file, path: target.relative(file), sha256: sha256(content) });
  }


  const registryResolution = resolveRoleRegistry({
    roleProfile: roleProfile ?? {},
    existingRoles: currentRegistry?.roles ?? {},
    existingPolicies: currentReceipt?.role_policies ?? {},
    observableModels,
    serviceTierOverrideSupported: runtimeCapabilities.spawn_service_tier_override ?? null,
  });
  const registry = {
    schema_version: 1,
    owner: RECEIPT_OWNER,
    roles: registryResolution.roles,
  };
  validateRoleRegistry(registry);
  const registryContent = `${JSON.stringify(registry, null, 2)}\n`;
  rendered.push({
    role: null,
    modelPolicy: null,
    content: registryContent,
    file: target.registry,
    path: target.relative(target.registry),
    sha256: sha256(registryContent),
  });

  await fs.mkdir(target.agentsDir, { recursive: true });
  const reservations = [];
  try {
    for (const record of rendered.filter((candidate) => !ownedPaths.has(path.resolve(candidate.file)))) {
      const handle = await fs.open(record.file, "wx", 0o600);
      reservations.push({ record, handle, stat: await handle.stat() });
    }
    for (const { record, handle } of reservations) await handle.writeFile(record.content);
    for (const { handle } of reservations) await handle.close();
    for (const record of rendered.filter((candidate) => ownedPaths.has(path.resolve(candidate.file)))) {
      await fs.writeFile(record.file, record.content, { mode: 0o600 });
    }
  } catch (error) {
    for (const reservation of reservations) {
      await reservation.handle.close().catch(() => undefined);
      try {
        const current = await fs.lstat(reservation.record.file);
        if (current.dev === reservation.stat.dev && current.ino === reservation.stat.ino) {
          await fs.unlink(reservation.record.file);
        }
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      }
    }
    if (error.code === "EEXIST") {
      throw new Error(`pstack setup path already exists and is not owned by pstack`);
    }
    throw error;
  }
  const receipt = {
    schema_version: 2,
    owner: RECEIPT_OWNER,
    scope,
    created_at: new Date().toISOString(),
    runtime_capabilities: structuredClone(runtimeCapabilities),
    role_policies: registryResolution.policies,
    files: rendered.map(({ role, modelPolicy, path: relativePath, sha256: hash }) =>
      role
        ? {
            path: relativePath,
            sha256: hash,
            template: role.template,
            prompt: role.prompt,
            capability: role.capability,
            model_policy: modelPolicy,
          }
        : { path: relativePath, sha256: hash, kind: "model-role-registry" },
    ),
  };
  await fs.mkdir(path.dirname(target.receipt), { recursive: true });
  await fs.writeFile(target.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return {
    status: "installed",
    scope,
    receiptPath: target.relative(target.receipt),
    registryPath: target.relative(target.registry),
    roles: registry.roles,
    runtimeCapabilities: structuredClone(runtimeCapabilities),
    files: receipt.files,
  };
}

export async function uninstallAgents({ projectRoot = process.cwd(), userHome = os.homedir(), scope = "project" } = {}) {
  const target = layer(scope, projectRoot, userHome);
  const receipt = await readReceipt(target.receipt);
  if (!receipt) return { status: "not-installed", scope, modified: [] };
  validateReceipt(receipt, scope, target);
  const divergence = await inspectOwnedFiles(receipt, target);
  const divergentPaths = new Set(divergence.map((record) => record.path));
  for (const record of receipt.files) {
    const absolute = path.resolve(target.root, record.path);
    if (!divergentPaths.has(record.path)) await fs.rm(absolute);
  }
  if (!divergence.length) {
    await fs.rm(target.receipt);
    return { status: "uninstalled", scope, modified: [] };
  }

  const archive = `${target.receipt}.preserved-${Date.now()}`;
  await fs.rename(target.receipt, archive);
  return {
    status: "uninstalled-with-preserved-files",
    scope,
    modified: divergence.map((record) => record.path),
    diagnostics: divergence,
    archivedReceipt: target.relative(archive),
    recovery: "Changed files were preserved and are no longer managed. Move or remove them before reinstalling, then delete the archived receipt after review.",
  };
}

async function main(argv) {
  const action = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid argument near "${flag ?? ""}"`);
    options[flag.slice(2)] = value;
  }
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const common = {
    pluginRoot,
    scope: options.scope ?? "project",
    projectRoot: path.resolve(options["project-root"] ?? process.cwd()),
    userHome: path.resolve(options["user-home"] ?? os.homedir()),
  };
  if (options.profile) common.profile = JSON.parse(await fs.readFile(options.profile, "utf8"));
  if (options.roles) common.roleProfile = JSON.parse(await fs.readFile(options.roles, "utf8"));
  if (options.models) common.observableModels = JSON.parse(await fs.readFile(options.models, "utf8"));
  if (options.capabilities) common.runtimeCapabilities = JSON.parse(await fs.readFile(options.capabilities, "utf8"));
  let result;
  if (action === "install") result = await installAgents(common);
  else if (action === "uninstall") result = await uninstallAgents(common);
  else if (action === "scan") result = await scanAgentNames(common);
  else if (action === "resolve-role") {
    result = await resolveRuntimeRole({ roleName: options.role, projectRoot: common.projectRoot, userHome: common.userHome });
  }
  else throw new Error("usage: manage-agents.mjs <install|uninstall|scan|resolve-role> [--scope project|user] [--project-root path] [--user-home path] [--role name] [--profile file] [--roles file] [--models file] [--capabilities file]");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
