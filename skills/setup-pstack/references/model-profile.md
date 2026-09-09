# Codex custom agents and model registry

Codex custom agents are standalone TOML files in project `.codex/agents/` or user `~/.codex/agents/`. The TOML `name` field, not the filename, owns identity. Skill `agents/openai.yaml` files provide UI and invocation metadata only.

Pstack stores workflow model routing in project `.codex/pstack-models.json` or user `~/.codex/pstack-models.json`. The project file wins when both exist. This registry is the Codex equivalent of the upstream generated model rule.

## Persona custom agents

| Role | Writable scope | Sandbox policy | Connector posture | Skill posture | Model policy | Fallback |
| --- | --- | --- | --- | --- | --- | --- |
| `pstack-poteto-agent` | Inherits the active user request; setup does not grant writes | Inherits the live runtime so setup cannot broaden authority | Inherits, but use remains limited to the active user request | Performs the portable prompt directly; may use relevant leaf principles | Inherit by default; install an explicit configuration only after an observable model list validates every value | Follow `subagent-lifecycle`; use the main agent sequentially when subagents are unavailable |
| `pstack-comment-sicko` | None; returns findings for the main agent to save | Requests `read-only`; live runtime overrides may replace this default, but do not authorize writes | Prohibited by review scope; tool availability does not grant authority | Performs its complete portable procedure directly; no orchestration skill dependency | Inherit by default; install an explicit configuration only after validation | Follow `subagent-lifecycle`; preserve explicit isolation requirements when the task has them |

Custom-agent defaults never prove the served model, effort, effective sandbox, connector set, or skill availability. A setup receipt describes written configuration only. Runtime receipts must come from an observable Codex surface.

When existing agents need newer portable instructions while retaining local model choices, use the reviewed [prompt-only refresh](agent-prompt-refresh.md). It preserves the registry and does not turn divergent model records into validated policy.

## Workflow role matrix

| Registry role | Shape |
| --- | --- |
| `feature, refactoring` | single |
| `bug-fix` | single |
| `perf-issue` | single |
| `hillclimb` | single |
| `judgment and prose` | single |
| `hardest tasks` | single |
| `how explorer` | single |
| `how explainer` | single |
| `how critics` | panel |
| `why investigators` | single |
| `why synthesizer` | single |
| `reflect tooling` | single |
| `reflect judgment, divergent, synthesizer` | single |
| `arena runners` | panel |
| `arena cross-judge pool` | panel |
| `swarm workers` | single |
| `architect runners` | panel |
| `interrogate reviewers` | panel |

Bundled fallback lanes live only in `model-defaults.json`. Workflow Markdown names roles but never mirrors their model values.

Every registry value is an array. A single role has exactly one lane. A panel has one or more lanes, and its array length sets fanout. Panel entries are participants, not an implicit fallback ranking. Pool selection and fallback order follow the owning workflow or explicit user direction. A user-specified preference order does not authorize launching every fallback for diversity. A lane is `{"model":"...","reasoning_effort":"..."}`, `{"model":"...","reasoning_effort":"...","service_tier":"..."}`, `{"inherit_parent":true}`, or `{"use_skill_default":true}`. The active registry overrides the bundled JSON defaults.

A lane without `service_tier` leaves the runtime's inherited tier unconstrained. A fast lane requests the `priority` service tier:

```json
[
  {"model":"gpt-5.6-luna","reasoning_effort":"max"},
  {"model":"gpt-5.6-luna","reasoning_effort":"max","service_tier":"priority"}
]
```

## Runtime resolution

Before a pstack dispatch selects a model, reasoning effort, or service tier, choose its exact registry role. Generic and `default` agent types do not bypass this rule. A dispatch that omits all overrides may inherit the main agent without a role.

Run `scripts/manage-agents.mjs resolve-role --role <exact-role> --project-root <task-cwd> --user-home <home>`, relative to this skill. The helper finds the nearest project registry without crossing a Git boundary. It reads that registry before the user registry and returns raw and resolved lanes.

1. Select only from `resolvedLanes`, then apply explicit user overrides. Treat the model, reasoning effort, and optional tier as one requested configuration.
2. Follow `subagent-lifecycle` to establish a supported configuration path. Pass supported arguments explicitly. A missing per-spawn tier argument does not require dropping the requested model and effort; check live inheritance or supported configuration for the tier. Do not infer unsupported models from an abbreviated advertised list.
3. For an inherited lane, omit spawn overrides and inspect the live settings when the task constrains them. Missing evidence remains unverified; it does not authorize weaker settings.
4. Spawn one agent per panel lane unless the owning workflow selects from a pool or the user directs a preference or fallback order.
5. Preserve duplicate lanes because each entry counts toward fanout.
6. A present but invalid higher-precedence registry stops the affected dispatch. Do not fall through to another registry or bundled defaults.
7. Preserve the role-resolution result and explicit overrides in the existing dispatch evidence. Add only missing configuration-path facts or conflicts; do not copy observable settings into another ledger. Keep unobserved backend model and tier claims unverified.

The resolver and receipt make policy cheap to follow and easy to audit. They cannot make violations impossible because the spawn tool has no structured pstack role field.

The registry proves only that setup validated the requested spawn configuration against the model list and override surface visible at that time. It does not prove which model or tier served a later agent.

## Setup evidence and runtime capability

- Validate model and effort against supported live discovery. A tier capability describes the model; the running Codex version determines how configuration supplies it.
- The setup helper's `spawn_service_tier_override` and `profile_service_tier_override` flags attest those specific override mechanisms. Do not set them to true as a substitute for inheritance evidence.
- When setup cannot validate its supported mechanism, it records `unverified-inheritance` and preserves the complete request in its receipt. This is a limit of setup evidence, not proof that runtime inheritance cannot meet the request. Runtime dispatch still follows the checks above.
- An observed entitlement denial or unsupported configuration blocks that path. Check compatible paths before declaring the model unavailable. Never silently select a substitute or downgrade an explicit requirement.

Current Codex documents session settings and custom-agent precedence in the [subagent guide](https://learn.chatgpt.com/docs/agent-configuration/subagents). The [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) defines `service_tier`; inspect the running version before relying on a particular override or inheritance mechanism.

Panel workflows must report reduced coverage when the user selects fewer participants, and reduced diversity when inheritance or repeated configurations use the same model. They must not invent a served-model receipt.

## Ownership receipt

Setup records scope, relative path, SHA-256, template source, requested model policy, role policies, and configuration status. Upgrade and uninstall may replace or remove a file only while its current hash matches the receipt. A mismatch requires human review and leaves the file and receipt intact.

An update preserves existing validated lanes when no replacement is requested. A partial role file changes only the named roles. Omitted roles retain their current mapping, or use `model-defaults.json` on a fresh install. Use `skill-default` to return an overridden lane to its bundled JSON default.
