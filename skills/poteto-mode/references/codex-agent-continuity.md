# Agent configuration continuity

Apply this check before assigning new work to an existing agent thread. Resolve the required role configuration through the model registry as usual. Keep model choices there.

If an agent is still working, collect its result before replacing its assignment or configuration. Continue an open agent through supported steering when its original requested configuration still meets the next assignment and observable settings do not conflict. A new assignment or role may need different settings even when its source context is useful.

For a closed agent, start a fresh subagent with the complete required configuration and a concise handoff containing the accepted result, source revision, evidence and remaining work. Reopening a closed agent with an ID-only tool does not establish configuration preservation. Matching metadata before the next turn is insufficient. Do not send product work through that uncertain path or silently accept another model.

This conservative path addresses an observed runtime boundary, not a new model policy. In a controlled probe, open continuation retained the requested configuration; the first turn after close/reopen changed the exported model metadata. Served identity was unavailable. Re-evaluate the closed-agent path only when a supported mechanism establishes the configuration used for the next turn.

`scripts/lib/agent-continuity.mjs` exports `planContinuation({closed, inFlight, requested, required, observed})` for callers that already automate dispatch. Configuration objects use optional `model`, `reasoning_effort` and `service_tier` strings. It returns `wait`, `steer` or `spawn` and preserves omitted settings as inheritance. It does not start agents, authenticate metadata, grant authority or prove served identity. Ordinary dispatch follows the same rule directly without another ledger or tool call.

The main agent must check that fresh startup can honor the returned configuration through supported arguments, configuration or verified inheritance. If no path preserves a required setting, report that capability as blocked. Keep requested settings, observed metadata and served identity separate. See the [official subagent guide](https://learn.chatgpt.com/docs/agent-configuration/subagents?surface=app) for configuration mechanisms.
