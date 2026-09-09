# OpenCodex requesting-thread integration contract

This is a proposed upstream extension. Installing this pstack change does not install OpenCodex instrumentation or recover missing historical identity.

## Verified current boundary

A read-only check on 2026-09-09 resolved the active executable through `PATH` and its real package path. It reported OpenCodex 2.46.0. Relevant installed source paths, relative to that package:

- `src/server/responses/core.ts` reads `x-codex-parent-thread-id` into `parsed._clientThreadId`.
- `src/server/request-log-conversation.ts` prioritizes that value for `conversationIdFromResponsesRequest`, hashing SHA-256 to 32 hex characters. CLI matching accepts the original ID or digest.
- `src/server/request-log.ts` and `src/usage/log.ts` retain request/attempt accounting and conversation grouping. Their inspected record types have no separate requesting-thread or pstack-role field.
- `src/usage/totals.ts` treats normalized input as inclusive of cache reads and creation. `src/adapters/anthropic.ts` adds provider cache reads/writes to raw input during normalization.
- `src/cli/observe.ts` supports the read-only log filters used by this audit. Its bounded log command does not offer a historical paging argument.

The supported usage and log commands returned JSON while `opencodex debug usage status` reported off. This establishes normal accounting availability, not complete retention or child attribution. Resolve the active installation again before changing this contract; do not hardcode the inspection machine's package path.

The [official Codex subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents?surface=app) distinguishes main and agent threads. It does not guarantee that every routed request exposes a child identity header. Confirm the requesting identity at the actual ingress before implementing this extension.

## Proposed additive fields

Preserve the existing `conversationId`, `_clientThreadId`, routing, continuation, replay, provider/account affinity, and admission behavior. Add an optional attribution object to existing request logs and persisted usage records:

```json
{
  "attribution": {
    "version": 1,
    "threadId": "SHA256_OF_REQUESTING_THREAD_TRUNCATED_TO_32_HEX",
    "parentThreadId": "SHA256_OF_IMMEDIATE_DELEGATING_THREAD_TRUNCATED_TO_32_HEX",
    "identityFormat": "sha256-128",
    "source": "thread-id"
  }
}
```

`threadId` must come from a separately observed requesting-thread identity, such as a verified `thread-id` header. Never fill it from the parent header, conversation grouping, a prompt-cache key, or a session fallback. Validate bounded values before hashing. Keep `parentThreadId` absent or null for an observed main thread; use the separately observed parent header for an agent thread. If its meaning is root ancestry rather than immediate delegation, leave attribution unavailable until the schema can express both correctly.

If the ingress exposes no trustworthy requesting ID, omit the object. The auditor must not invent one. The audit accepts `identityFormat: "raw"` only for explicitly supplied fixture or supported metadata projections; deployed persistence should use opaque digests. This attribution joins evidence; it is not authentication or authorization.

Persist the object through request finalization, retry aggregation, disk serialization, hydration, the existing Logs API, and CLI JSON output. Each attempt inherits the request's actor identity but retains its own provider, model, usage status, ordinal, and token fields. Do not copy the last attempt's model to earlier attempts. Do not emit a second usage event for attribution.

Use existing dispatch/history records to join thread IDs to roles in the audit. Do not send role names through model routing or add a parallel dispatch ledger. Preserve request IDs across log snapshots and ordinal identity across retries. Adding attribution must not change provider routing or account affinity.

## Acceptance and deployment

An upstream implementation needs tests for main-thread calls, two concurrent subagents sharing a conversation group, nested delegation, retries, resumed agents, missing child headers, conflicting headers, reload persistence, and CLI export. Assert unchanged routing/account-affinity keys before and after the change. Assert that request bodies, credentials, login tokens, and tool payloads never enter this object.

Prepare and review that change in an isolated OpenCodex source checkout. Deploy through the user's explicit OpenCodex upgrade workflow with a separately authorized installation/restart. This pstack task does not patch the live package, alter global configuration, enable debug telemetry, or restart the proxy.

After deployment, validate identity against existing supported history and read-only log exports. Reusing already authorized traffic is sufficient; do not launch paid traffic only to manufacture a demonstration. Historical records without identity remain unattributed unless another exact supported source independently establishes request-to-thread correspondence.
