# Codex agent profiles and model registry

Codex custom agents are standalone TOML files in project `.codex/agents/` or user `~/.codex/agents/`. The TOML `name` field, not the filename, owns identity. Skill `agents/openai.yaml` files provide UI and invocation metadata only.

Pstack stores workflow model routing in project `.codex/pstack-models.json` or user `~/.codex/pstack-models.json`. The project file wins when both exist. This registry is the Codex equivalent of the upstream generated model rule.

## Persona profiles

| Role | Writable scope | Sandbox policy | Connector posture | Skill posture | Model policy | Fallback |
| --- | --- | --- | --- | --- | --- | --- |
| `pstack-poteto-agent` | Inherits the live parent request; setup does not grant writes | Inherits the live runtime so setup cannot broaden authority | Inherits, but use remains limited to the parent request | Must read `poteto-mode`; portable prompt is authoritative | Inherit by default; install an explicit pair only after an observable model list validates both values | Include `poteto-agent-prompt.md` in a generic-agent task; use the parent sequentially when agents are unavailable |
| `pstack-comment-sicko` | None | Explicit `read-only` default; live parent restrictions may narrow it further | Prohibited by prompt; setup does not claim it can prove connector isolation | May use `how` and `why` for read-only investigation | Inherit by default; install an explicit pair only after validation | Use the portable prompt in a deliberately constrained generic agent; otherwise skip and report the missing isolation |

Custom-agent defaults never prove the served model, effort, effective sandbox, connector set, or skill availability. A setup receipt describes written configuration only. Runtime receipts must come from an observable Codex surface.

## Workflow role matrix

| Registry role | Shape | Original PStack default |
| --- | --- | --- |
| `feature, refactoring` | single | `xai/grok-4.6`, `xhigh` |
| `bug-fix` | single | `gpt-5.6-sol`, `max` |
| `perf-issue` | single | `gpt-5.6-sol`, `max` |
| `hillclimb` | single | `gpt-5.6-sol`, `max` |
| `judgment and prose` | single | `anthropic/claude-fable-5`, `max` |
| `hardest tasks` | single | `anthropic/claude-fable-5`, `max` |
| `how explorer` | single | `xai/grok-4.6`, `xhigh` |
| `how explainer` | single | `anthropic/claude-fable-5`, `max` |
| `how critics` | panel | Fable `max`, Sol `max`, Grok `xhigh`, Opus `xhigh` |
| `why investigators` | single | `xai/grok-4.6`, `xhigh` |
| `why synthesizer` | single | `anthropic/claude-fable-5`, `max` |
| `reflect tooling` | single | `gpt-5.6-sol`, `max` |
| `reflect judgment, divergent, synthesizer` | single | `anthropic/claude-fable-5`, `max` |
| `arena runners` | panel | Fable `max`, Sol `max`, Grok `xhigh`, Opus `xhigh` |
| `arena cross-judge pool` | panel | Fable `max`, Sol `max`, Grok `xhigh`, Opus `xhigh` |
| `swarm workers` | single | `xai/grok-4.6`, `xhigh` |
| `architect runners` | panel | Fable `max`, Sol `max`, Grok `xhigh`, Opus `xhigh` |
| `interrogate reviewers` | panel | Fable `max`, Sol `max`, Grok `xhigh`, Opus `xhigh` |

The fast Grok role uses the available Codex model `xai/grok-4.6` with separate `xhigh` reasoning. The other defaults preserve the original model family and effort directly.

Every registry value is an array. A single role has exactly one lane. A panel has one or more lanes, and its array length sets fanout. A lane is `{"model":"...","reasoning_effort":"..."}`, `{"inherit_parent":true}`, or `{"use_skill_default":true}`. The executable role registry owns fallback pairs. Owning Markdown skills mirror them for workflow readers.

## Runtime resolution

Before a pstack dispatch selects a model or reasoning effort, choose its exact registry role. Generic and `default` agent types do not bypass this rule. A dispatch that omits both overrides may inherit the parent without a role.

Run `scripts/manage-agents.mjs resolve-role --role <exact-role> --project-root <task-cwd> --user-home <home>`, relative to this skill. The helper finds the nearest project registry without crossing a Git boundary. It reads that registry before the user registry and returns raw and resolved lanes.

1. Select only from `resolvedLanes`. A model and reasoning effort are one indivisible pair.
2. For an explicit or resolved skill-default lane, pass both values only when the spawn surface advertises the exact pair. Otherwise inherit both and report the unavailable pair.
3. For an inherited lane, omit both overrides.
4. Spawn one agent per panel lane unless the owning workflow selects one lane from a pool.
5. Preserve duplicate lanes because each entry counts toward fanout.
6. A present but invalid higher-precedence registry stops the affected dispatch. Do not fall through to another registry or bundled defaults.
7. Record the exact role, registry source or unavailable status, selected lane, and requested pair in the runtime receipt.

The resolver and receipt make policy cheap to follow and easy to audit. They cannot make violations impossible because the spawn tool has no structured pstack role field.

The registry proves only that setup validated the requested pair against the model list visible at that time. It does not prove which model served a later agent.

## Model resolution

- No requested pair: omit `model` and `model_reasoning_effort`; both inherit.
- Requested pair plus an observable model list: require an exact model match and require the effort in that model's advertised effort set before writing both fields.
- Requested pair without an observable model list: record `unverified-inheritance`, omit both TOML fields, and show the requested pair only as unverified intent.
- Missing entitlement or unsupported pair: stop without changing profiles. Do not silently select a substitute.

Panel workflows must report reduced diversity when inheritance or repeated pairs collapse distinct lanes onto the same observable model. They must not invent a served-model receipt.

## Ownership receipt

Setup records scope, relative path, SHA-256, template source, requested model policy, role policies, and configuration status. Upgrade and uninstall may replace or remove a file only while its current hash matches the receipt. A mismatch requires human review and leaves the file and receipt intact.

An update preserves existing validated lanes when no replacement is requested. A partial role file changes only the named roles. Omitted roles retain their current mapping, or use their Markdown skill defaults on a fresh install. Use `skill-default` to return an overridden lane to its owning Markdown default.
