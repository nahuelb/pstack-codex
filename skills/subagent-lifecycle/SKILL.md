---
name: subagent-lifecycle
description: Use before spawning or managing subagents. Start exact custom agents, apply portable fallbacks, collect required results, and close completed agent threads.
---

# Subagent lifecycle

Delegation must already be authorized.

## Start custom agents

When a workflow names a custom agent, start that exact `agent_type` with a bounded task brief. The brief supplies scope, evidence, ownership, and the required report. Do not tell the subagent to invoke the skill or persona that owns the custom agent.

If the custom agent is unavailable, start a `default` agent with the complete portable persona prompt followed by the same task brief. The default agent performs the persona directly. It must not invoke the owning orchestration skill or start another copy of itself.

Use these portable prompts:

- `pstack-poteto-agent`: `../poteto-mode/references/poteto-agent-prompt.md`
- `pstack-comment-sicko`: `../no-comments/references/comment-sicko-prompt.md`

If the prompt cannot be resolved, or the fallback cannot preserve required isolation or independence, report the subagent as blocked.

## Collect results

`spawn_agent` starts the subagent but does not wait for it to finish. The main agent can keep working. Before the next dependent step or final response, collect every required result with `wait_agent`.

Every `wait_agent` call must use `timeout_ms: 900000` and include all required Active subagents. Process every final result returned. If required subagents remain Active, continue independent work or wait again.

A timeout means only that no result arrived during that call. Do not infer that a subagent is stalled because of a timeout. Never stop, close, replace, or narrow an Active subagent because a wait timed out.

Stop an Active subagent only when the user asks, it leaves scope, it makes unsafe or conflicting changes, it reaches a declared deadline, or continued work would exceed current authority. Elapsed time and missing output are not stop reasons.

After an interruption, inspect partial files and reconcile retained state before retrying. Retry at most once with a brief that accounts for that state. A second interruption returns a labeled partial result or visible blocker.

Verify each result before using it. Close completed agent threads when the tool supports closing.
