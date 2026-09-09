# Token usage attribution

Use this workflow when an audit asks which subagents or pstack roles consumed a model's usage. The installed skill name is `conversation-audit`; `audit-conversation` is not a separate skill.

Run `scripts/audit-usage.mjs` from the plugin root, three directories above this reference. It requires Node.js 20 or later. It reads explicit exports and writes reports, without a daemon or additional ledger.

```bash
node scripts/audit-usage.mjs \
  --root MAIN_THREAD_ID --cutoff 2026-09-09T18:00:00Z \
  --since 2026-09-09T00:00:00Z \
  --history /path/main-history.json --history /path/agent-history.json \
  --roles /path/reviewed-role-bindings.json \
  --provider anthropic --model claude-fable-5-1 \
  --json /tmp/new-usage-report.json --markdown /tmp/new-usage-report.md \
  /path/opencodex-logs.json
```

Output files must be new paths. Without `--json`, JSON goes to stdout. Each report retains request and attempt IDs, source references, field coverage, quarantine reasons, and alternative aggregation views. Do not sum those views together.

## Supported collection

Use `--live` instead of, or alongside, explicit log files to call the active `opencodex` executable on `PATH`. The reader checks its version, then calls `logs --json --conversation ID --limit N`. It queries only the main thread and subagents bound by supported exported spawn receipts. No history means main-task grouping only. `--limit` defaults to 1000 and cannot exceed 2000; more than 128 bound threads requires explicit exports.

The reader does not apply model or provider filters to the CLI. A request can retry on another route. The analyzer applies those filters to each attempt afterward. Use the exact logged model and provider spelling; requested aliases are separate fields.

The live reader uses bounded read-only commands. It does not enable debug logging, read private host stores, change telemetry, inspect credentials, start agents, or restart OpenCodex. It retains only accounting fields in reports. It does not persist raw CLI output, prompt bodies, tool payloads, account labels, or `rawUsage` objects.

For a manual read-only check, the supported interfaces include:

```bash
opencodex --version
opencodex logs --json --limit 1000 --provider anthropic --conversation MAIN_THREAD_ID
opencodex usage --range today --provider anthropic --json
opencodex debug usage status
```

The usage command supplies account/provider context only. Do not import its summary as task usage. Debug usage being off does not disable ordinary accounting. Log retention, bounded slices, active requests, and omitted exports prevent a completeness claim. A `total` field or an empty filtered result does not prove full historical coverage. Keep report coverage partial even when every retained row has tokens.

Accepted log exports are the JSON CLI envelope `{ "logs": [...] }` or a JSON array of request records. Multiple files can overlap. Unknown fields are discarded. Other telemetry schemas require a separate, reviewed adapter; do not relabel account or cumulative summaries as requests.

## Bind agents and roles

Supply supported history exports using the [existing history contract](history-analysis.md). Only validated completed spawn receipts establish nested membership. A thread name, a waiting tool call, or a claimed ancestry field is insufficient. Edges with uncertain cutoff placement cannot bind usage. Resume operations retain the same agent identity and do not create another actor.

OpenCodex's existing `conversationId` groups requests. With main-task grouping, it cannot separate the main agent from subagents. The analyzer reports `threadId: null`, `role: null`, and `parentTask: null` for those requests. It still reports the verified conversation group and model totals. Grouping can use the requesting thread itself, so it cannot establish the immediate delegating task. The analyzer never apportions tokens by workload size, timing overlap, role expectations, or model names.

Separate requesting-thread metadata is accepted only under the [OpenCodex integration contract](opencodex-attribution-contract.md). That contract is proposed instrumentation, not a field guaranteed by current OpenCodex. Binding requires its identity plus the supported history graph. An invalid explicit attribution is quarantined instead of silently treated as main-agent work.

Join roles through existing dispatch briefs, explicit role receipts, or run events carrying `actor.threadId` and `actor.role`. A registry entry alone cannot prove its application to that dispatch. Project only the necessary fields from reviewed evidence:

```json
[
  {
    "threadId": "AGENT_THREAD_ID",
    "parentThreadId": "MAIN_THREAD_ID",
    "dispatchItemId": "NATIVE_SPAWN_ITEM_ID",
    "role": "implementer",
    "source": "supported-export.json#explicit-role-brief-item",
    "from": "2026-09-09T12:00:00Z",
    "to": "2026-09-09T13:00:00Z"
  }
]
```

This optional projection is audit input, not a new dispatch ledger. The analyzer verifies the spawn edge and assignment window. The auditor must verify that `source` actually names the role for that dispatch; the helper never follows source paths. A free-form assignment `owner` is not a native thread ID unless a supported receipt binds it. Missing role evidence stays unattributed.

Omit `from` and `to` only when the same explicit role governs the whole observed agent lifetime. The defaults are the earliest supported spawn bound and audit cutoff. Reused agents with changed roles require separate evidence windows. Overlapping different roles remain unattributed. Timestamps select request starts; they cannot split a request between roles or establish model active time.

## Accounting rules

1. Count unique `requestId` records. Exact repeated snapshots deduplicate; conflicting accounting or identity snapshots quarantine the whole request. This conservative behavior can omit usage after a live snapshot changes. Re-export a finalized slice rather than summing snapshots.
2. Use attempt records when present, keyed by request ID and positive `ordinal`. Ignore the request's aggregate token summary in that case. Duplicate ordinals quarantine the request. Without attempts, count the request aggregate once and label retry coverage unknown.
3. Count usage on failed attempts when reported. Distinct retry requests count separately. Internal recoveries with `sendCount > 1` remain partial when per-send receipts are absent; never multiply one receipt by send count.
4. Keep `reported`, `estimated`, and missing/unsupported records separate. Preserve null versus zero for every token field. Malformed or contradictory totals become missing, with a quarantine reason. Large sums fail rather than lose integer precision.
5. OpenCodex normalizes input to include cache reads and creation. Use explicit `totalTokens`, or derive `inputTokens + outputTokens` when both exist. Cached input and cache-read aliases are details, not additive categories. Reasoning is an output subset. Preserve larger historical native totals without guessing how old exclusive-input fields were normalized.
6. Exclude cumulative, context-only, and agent-inclusive counters. The existing run-record `token_usage` events are cumulative snapshots and are not this meter's requests. Native response receipts from the history analyzer are an alternative meter; compare coverage, never add overlapping totals without proven request correspondence.
7. Rank observed reported totals by agent, role, model/provider, immediate delegating task, and their combination. Unknown identities have no rank. Keep estimate subtotals alongside those rankings. Include request time ranges, per-field missing counts, and evidence IDs. Missing records can change the true order.
8. Report `displayMetrics.cost` as an estimated API equivalent. Attempt and whole-request estimates overlap; show them as alternatives. A model filter can exclude a whole-request estimate when it selects only some attempts. No price table, invoice, account multiplier, or subscription quota formula is inferred.

The logged attempt model identifies the OpenCodex route. It is not independent proof of the backend's served identity. The requested model and reasoning effort remain separate. Do not spread a final request's resolved model across earlier retry attempts.

## Validation and example

```bash
node --test tests/usage-audit.test.mjs
node scripts/audit-usage.mjs \
  --root main --cutoff 2026-09-09T13:00:00Z \
  --history tests/fixtures/usage-audit/history.json \
  --roles tests/fixtures/usage-audit/roles.json \
  --model claude-fable-5-1 \
  tests/fixtures/usage-audit/logs.json
```

The [example report](usage-example.md) uses synthetic records. Its child identity fields demonstrate the integration contract, not current historical availability. Tests cover main/subagent separation, nested agents, model switches, retry attempts and internal sends, resumed identities, missing usage, cache details, overlapping exports, role changes, attribution conflicts, and privacy.
