---
name: setup-pstack
description: "Install, update, remove, or inspect pstack's Codex agent profiles and per-role model registry. Use for setup-pstack or requests to configure pstack agents and models."
---

# Setup pstack for Codex

Install two persona-specific custom agents and a complete per-role model registry without adding them to the plugin manifest. Codex loads project profiles from `.codex/agents/*.toml` and user profiles from `~/.codex/agents/*.toml`. This skill's `agents/openai.yaml` is UI metadata only.

Read `references/model-profile.md` before changing configuration. The portable prompts in the owning skills remain authoritative and work without installed profiles.

## Safety contract

- Require explicit user intent for install, upgrade, or uninstall.
- Ask for `project` or `user` scope when it is not clear. Project scope is the safer default only when the user says to configure the current repository.
- Scan both project and user agent directories before a write. Stop on duplicate TOML `name` fields regardless of filename or layer.
- Never overwrite another owner. Update or remove only files whose current SHA-256 matches this setup's receipt.
- A modified, missing, or relocated receipted file requires review; leave profiles and receipt untouched.
- Configuration is not runtime proof. Never claim the served model, effort, effective permissions, connector set, or skill availability unless a supported live surface reports it.

## Model policy

Ask whether to keep the current mapping or change specific roles. Read the complete role list and runtime resolution rules in `references/model-profile.md`. A single role accepts one lane. A panel role accepts one or more lanes, and its list length controls fanout.

Each lane is `skill-default`, `inherit-parent`, `auto`, or an explicit spawn configuration. An explicit lane contains `model` and `reasoning_effort`. It may contain `service_tier`. Standard mode omits `service_tier`. Fast mode uses `"priority"`. Treat these values as one configuration. `skill-default` returns to the original choice in the owning Markdown skill. The inheritance aliases omit explicit spawn overrides.

If a supported Codex model-list surface is observable, convert it to JSON records shaped like:

```json
[{"slug":"gpt-5.6-luna","reasoning_efforts":["low","medium","high","xhigh","max"],"service_tiers":["priority"]}]
```

Validate the model and effort before writing them. Validate `service_tier` when the lane requests it. A fast workflow lane also requires a live `spawn_agent` schema with a `service_tier` override. A fast custom profile requires the named role description to report its locked service tier. Record these checks in a capabilities JSON file with `spawn_service_tier_override` and `profile_service_tier_override` booleans. If the model list or required override surface is unavailable, omit the TOML fields, write an inherited role lane, and record `unverified-inheritance` with the complete request. Do not accept pasted entitlement claims as proof. A missing model or unsupported value is a hard stop. Let the user choose another configuration or inheritance.

Persona profiles are a JSON object keyed by namespaced agent name:

```json
{
  "pstack-poteto-agent": {"model":"gpt-6-astra","reasoning_effort":"high"},
  "pstack-comment-sicko": {"model":"gpt-5.6-terra","reasoning_effort":"medium"}
}
```

Role choices are a second JSON object keyed by the exact role labels from `references/model-profile.md`. It can contain only the roles being changed. Single roles accept one value. Panel roles accept an array:

```json
{
  "feature, refactoring": {"model":"anthropic/claude-opus-5","reasoning_effort":"high"},
  "how critics": [
    {"model":"anthropic/claude-fable-5-1","reasoning_effort":"high"},
    {"model":"gpt-5.6-luna","reasoning_effort":"max","service_tier":"priority"},
    "inherit-parent"
  ]
}
```

## Execute

The helper is `scripts/manage-agents.mjs` relative to this skill.

```text
node scripts/manage-agents.mjs scan --project-root <repo> --user-home <home>
node scripts/manage-agents.mjs install --scope project --project-root <repo> --user-home <home>
node scripts/manage-agents.mjs install --scope user --project-root <repo> --user-home <home>
node scripts/manage-agents.mjs uninstall --scope project --project-root <repo> --user-home <home>
```

Add `--profile <json-file>` for persona pairs, `--roles <json-file>` for role changes, and `--models <json-file>` only when the list came from an observable supported surface. Add `--capabilities <json-file>` when a fast request is present. Omitted roles keep their current mapping. On a fresh setup, omitted roles use the defaults in their owning Markdown skills. Do not create temporary files containing secrets; these files contain model identifiers only.

Setup writes `.codex/pstack-models.json` at project scope or `~/.codex/pstack-models.json` at user scope. The project registry overrides the user registry. On success, report the scope, profile paths, registry path, receipt path, and each role's setup status. Say that the new mapping applies to newly spawned agents. When a panel inherits or repeats one model, report reduced diversity instead of claiming which model served it.

On `review-required` or any collision, stop. Show the exact paths and do not suggest force deletion.
