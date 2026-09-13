# Subagent lifecycle

This Codex-only reference is loaded by `codex-agent-runtime.md` and the workflows that delegate. It is not a skill. Delegation must already be authorized.

## Find the tools

Enumerate the live tool inventory before you report subagents as unavailable. In code mode the tools appear as `multi_agent_v1__spawn_agent`, `multi_agent_v1__wait_agent`, `multi_agent_v1__send_input`, `multi_agent_v1__resume_agent`, and `multi_agent_v1__close_agent`. In direct tool mode they appear as `spawn_agent`, `wait_agent`, `send_input`, `resume_agent`, and `close_agent`. A name lookup that misses one form is not evidence that the surface is missing.

## Start custom agents

When a workflow names a custom agent, start that exact `agent_type` with a bounded task brief. The brief supplies scope, evidence, ownership, and the required report. Do not tell the subagent to invoke the skill or persona that owns the custom agent.

Resolve the requested model, reasoning effort, and service tier before launch. Use supported spawn arguments, configuration, or verified inheritance. Custom-agent settings can override spawn arguments. Preserve explicit user requirements across the complete configuration.

An abbreviated advertised model list or a missing spawn argument does not prove a capability is unavailable. Check supported live discovery and effective configuration, including inheritance and custom-agent overrides. Saved defaults do not establish the active task's settings. When uncertainty remains, use a bounded probe only if it preserves the user's constraints and has no external side effects. Report requested settings, observed settings, and unknowns separately. Successful completion alone does not prove the served model or tier.

If the custom agent is unavailable or has conflicting fixed settings, check whether a `default` fallback preserves the requirements. If it does, start a `default` agent with the complete portable persona prompt and the same task brief. The default agent performs the persona directly. It must not invoke the owning orchestration skill or start another copy of itself. Preserve required settings, scope, isolation, and independence. Do not silently downgrade settings or change shared configuration to force a launch.

Resolve portable prompts from the setup receipt or owning skill. For the bundled personas, use:

- `pstack-poteto-agent`: `poteto-agent-prompt.md`
- `pstack-comment-sicko`: `../../no-comments/references/comment-sicko-prompt.md`

If no supported path preserves the requirements or the prompt cannot be resolved, report the subagent as blocked.

## Collect results

`spawn_agent` starts the subagent but does not wait for it to finish. The main agent can keep working. Before the next dependent step or final response, collect every required result with `wait_agent`.

Every `wait_agent` call must use `timeout_ms: 900000` and include all required Active subagents. Process every final result returned. If required subagents remain Active, continue independent work or wait again.

A timeout means only that no result arrived during that call. Do not infer that a subagent is stalled because of a timeout. Never stop, close, replace, or narrow an Active subagent because a wait timed out.

Stop an Active subagent only when the user asks, it leaves scope, it makes unsafe or conflicting changes, it reaches a declared deadline, or continued work would exceed current authority. Elapsed time and missing output are not stop reasons.

After an interruption, inspect partial files and reconcile retained state before retrying. Retry at most once with a brief that accounts for that state. A second interruption returns a labeled partial result or visible blocker.

Verify each result before using it. Retain an open agent when a known next assignment benefits from its context and uses the same configuration. Otherwise close completed agent threads when the tool supports closing.

Before reusing an agent, apply [configuration continuity](codex-agent-continuity.md). A closed agent's saved metadata does not establish the configuration of its next turn.
