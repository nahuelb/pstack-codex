# Codex custom agents and model registry

Codex custom agents are standalone TOML files in project `.codex/agents/` or user `~/.codex/agents/`. The TOML `name` field, not the filename, owns identity. Skill `agents/openai.yaml` files provide UI and invocation metadata only.

Pstack stores workflow model routing in project `.codex/pstack-models.json` or user `~/.codex/pstack-models.json`. The project file wins when both exist. This registry is the Codex equivalent of the upstream generated model rule.

## Persona custom agents

| Role | Writable scope | Sandbox policy | Connector posture | Skill posture | Model policy | Fallback |
| --- | --- | --- | --- | --- | --- | --- |
| `pstack-poteto-agent` | Inherits the active user request; setup does not grant writes | Inherits the live runtime so setup cannot broaden authority | Inherits, but use remains limited to the active user request | Performs the portable prompt directly; may use relevant leaf principles | Inherit by default; install an explicit configuration only after an observable model list validates every value | Follow `subagent-lifecycle`; use the main agent sequentially when subagents are unavailable |
| `pstack-comment-sicko` | None | Explicit `read-only` default; live restrictions may narrow it further | Prohibited by prompt; setup does not claim it can prove connector isolation | May use `how` and `why` for read-only investigation | Inherit by default; install an explicit configuration only after validation | Follow `subagent-lifecycle`; otherwise skip and report the missing isolation |

Custom-agent defaults never prove the served model, effort, effective sandbox, connector set, or skill availability. A setup receipt describes written configuration only. Runtime receipts must come from an observable Codex surface.

## Workflow role matrix

| Registry role | Shape | PStack default |
| --- | --- | --- |
| `feature, refactoring` | single | `xai/grok-4.6`, `xhigh` |
| `bug-fix` | single | `anthropic/claude-fable-5-1`, `high` |
| `perf-issue` | single | `anthropic/claude-fable-5-1`, `high` |
| `hillclimb` | single | `anthropic/claude-fable-5-1`, `high` |
| `judgment and prose` | single | `anthropic/claude-fable-5-1`, `high` |
| `hardest tasks` | single | `anthropic/claude-fable-5-1`, `high` |
| `how explorer` | single | `xai/grok-4.6`, `xhigh` |
| `how explainer` | single | `anthropic/claude-fable-5-1`, `high` |
| `how critics` | panel | Fable `high`, Astra `high`, Grok `xhigh`, Opus `xhigh` |
| `why investigators` | single | `xai/grok-4.6`, `xhigh` |
| `why synthesizer` | single | `anthropic/claude-fable-5-1`, `high` |
| `reflect tooling` | single | `gpt-6-astra`, `high` |
| `reflect judgment, divergent, synthesizer` | single | `anthropic/claude-fable-5-1`, `high` |
| `arena runners` | panel | Fable `high`, Astra `high`, Grok `xhigh`, Opus `xhigh` |
| `arena cross-judge pool` | panel | Fable `high`, Astra `high`, Grok `xhigh`, Opus `xhigh` |
| `swarm workers` | single | `xai/grok-4.6`, `xhigh` |
| `architect runners` | panel | Fable `high`, Astra `high`, Grok `xhigh`, Opus `xhigh` |
| `interrogate reviewers` | panel | Fable `high`, Astra `high`, Grok `xhigh`, Opus `xhigh` |

The Astra and Fable fallbacks use `high` reasoning. Every other bundled fallback caps reasoning at `xhigh`.

Every registry value is an array. A single role has exactly one lane. A panel has one or more lanes, and its array length sets fanout. A lane is `{"model":"...","reasoning_effort":"..."}`, `{"model":"...","reasoning_effort":"...","service_tier":"..."}`, `{"inherit_parent":true}`, or `{"use_skill_default":true}`. The executable role registry owns fallback configurations. Owning Markdown skills mirror them for workflow readers.

A standard lane omits `service_tier`. A fast lane requests the `priority` service tier:

```json
[
  {"model":"gpt-5.6-luna","reasoning_effort":"max"},
  {"model":"gpt-5.6-luna","reasoning_effort":"max","service_tier":"priority"}
]
```

## Runtime resolution

Before a pstack dispatch selects a model, reasoning effort, or service tier, choose its exact registry role. Generic and `default` agent types do not bypass this rule. A dispatch that omits all overrides may inherit the main agent without a role.

Run `scripts/manage-agents.mjs resolve-role --role <exact-role> --project-root <task-cwd> --user-home <home>`, relative to this skill. The helper finds the nearest project registry without crossing a Git boundary. It reads that registry before the user registry and returns raw and resolved lanes.

1. Select only from `resolvedLanes`. A lane's `model`, `reasoning_effort`, and optional `service_tier` are one indivisible spawn configuration.
2. For an explicit or resolved skill-default lane, pass every present value only when the spawn surface advertises the exact configuration. Standard lanes omit `service_tier`. Otherwise inherit all values and report the unavailable configuration.
3. For an inherited lane, omit all spawn overrides.
4. Spawn one agent per panel lane unless the owning workflow selects one lane from a pool.
5. Preserve duplicate lanes because each entry counts toward fanout.
6. A present but invalid higher-precedence registry stops the affected dispatch. Do not fall through to another registry or bundled defaults.
7. Record the exact role, registry source or unavailable status, selected lane, and requested spawn configuration in the runtime receipt.

The resolver and receipt make policy cheap to follow and easy to audit. They cannot make violations impossible because the spawn tool has no structured pstack role field.

The registry proves only that setup validated the requested spawn configuration against the model list and override surface visible at that time. It does not prove which model or tier served a later agent.

## Model resolution

- No requested configuration: omit `model`, `model_reasoning_effort`, and `service_tier`.
- Requested configuration plus an observable model list: require an exact model and effort match. If `service_tier` is present, require it in the model's advertised `service_tiers` set and require the matching live spawn override capability.
- Requested configuration without an observable model list: record `unverified-inheritance`, omit the TOML fields, and show the complete request only as unverified intent.
- Missing entitlement or an unsupported value: stop without changing custom agents. Do not silently select a substitute.

Panel workflows must report reduced diversity when inheritance or repeated configurations collapse distinct lanes onto the same observable model. They must not invent a served-model receipt.

## Ownership receipt

Setup records scope, relative path, SHA-256, template source, requested model policy, role policies, and configuration status. Upgrade and uninstall may replace or remove a file only while its current hash matches the receipt. A mismatch requires human review and leaves the file and receipt intact.

An update preserves existing validated lanes when no replacement is requested. A partial role file changes only the named roles. Omitted roles retain their current mapping, or use their Markdown skill defaults on a fresh install. Use `skill-default` to return an overridden lane to its owning Markdown default.
