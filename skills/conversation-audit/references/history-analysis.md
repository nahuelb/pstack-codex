# Offline history timing analysis

Use `scripts/analyze-history.mjs` to reconstruct timing facts from explicitly exported supported history. It requires an exact main-thread ID and audit cutoff. It has no dependencies beyond Node.js 20 or later.

Run it from the repository root:

```bash
node scripts/analyze-history.mjs \
  --root MAIN_THREAD_ID \
  --cutoff 2026-09-08T23:00:00Z \
  --json /tmp/history-analysis.json \
  --markdown /tmp/history-analysis.md \
  /path/main-export.json /path/agent-export.json
node --test tests/history-analysis.test.mjs
```

Without `--json`, stdout contains machine JSON. Diagnostics go to stderr. Markdown is a small summary; JSON retains evidence references, intervals, conflicts, and quarantine reasons. All reported interval coordinates use Unix milliseconds.

## Export contract

Supply files explicitly. The importer never follows index paths, reads referenced artifacts, executes commands, fetches URLs, or inspects a private history store. Snapshot text remains inert data.

Accepted shapes include:

- A `thread/read` result: `{ "thread": { "id": "...", "turns": [...] } }`.
- A combined export: `{ "thread": {...}, "turns": [...], "items": [{ "turnId": "...", "item": {...} }], "capturedAt": "..." }`.
- A turns page: `{ "threadId": "...", "turns": { "data": [...] } }`.
- An items page: `{ "threadId": "...", "turnId": "...", "items": { "data": [...] } }`.
- A JSON-RPC export retaining `method`, `params.threadId`, optional `params.turnId`, and `result`. Methods `thread/turns/list`, `thread/items/list` and `thread/turns/items/list` select their `result.data` records.
- Arrays of these exports. Index entries with numeric `turns` and `items` counts supply catalog identities and latest metadata, never timing or binding edges.

Arrays may replace the page objects. Embedded `turn.items` are also imported. Bare page results need their exported request context; filenames do not establish identity. In JavaScript, call `analyzeHistory({ rootId, cutoff, snapshots, notes })`. A snapshot may be `{ source, document }` to preserve a source label.

Numeric timestamps mean Unix seconds. String timestamps must include `T` and a timezone. Turn and item intervals require `startedAt` and `completedAt`. `durationMs` alone never supplies missing boundaries. Missing open-turn endpoints remain unknown; the cutoff does not invent an endpoint. Snapshot capture time selects latest metadata only.

Only completed native `collabAgentToolCall` items with `tool: "spawnAgent"` bind agent threads. Their `senderThreadId` must match the containing thread. `receiverThreadIds` identify the spawned agents. Binding continues through exported agent spawn items. Names, index edges, ancestry fields, prompts, wait items, and incoming messages cannot independently establish membership.

A spawn without its own timestamps uses its containing turn only as a possible time range. If that turn crosses the cutoff, the edge reports unknown cutoff placement. Agent intervals still require their own timestamps. No duration comes from spawn-to-close lifetime. Turns wholly before the earliest possible spawn are excluded.

Thread-scoped turn and item IDs deduplicate repeated pages. Response IDs deduplicate native token receipts. Conflicting populated identity, timing, request, and receipt fields quarantine the record. Cross-thread ID collisions and incompatible spawn ancestry also quarantine evidence. Missing fields can be filled by another snapshot. Completed status can replace an earlier pending status. Quarantine is conservative; omitted history can reduce totals.

## Timing and gaps

`totals.mainTurnUnion` merges overlapping main-thread turn intervals. `agentTurnUnion` merges all agent turn intervals. `agentTurnSumMs` sums each agent's turn union, so concurrent agents remain cumulative. These are turn spans, not measured active work.

Each actor reports gaps between observed turns and time inside turns without explicit item intervals. The audit window runs from the first observed main turn to the supplied cutoff. Its uncovered intervals mean no observed turn, not proven idle time. Separate gap metrics show portions covered by observed agent turns and portions without that coverage. Neither proves why the main agent waited.

`withinTurnWithoutActivityClassification` excludes service lifetimes and unknown intervals from activity coverage. A service running throughout a turn cannot erase uncertainty about the agent’s activity. Coverage counts identify missing agent exports; zero observed intervals do not establish zero work.

Tool receipts report incomplete cumulative `durationMs` totals by classification. They can exceed wall time through overlap. Missing and zero durations have separate counts. A duration without item timestamps contributes only when its containing turn ends by the cutoff. Straddling receipts remain excluded from cumulative totals; explicit observed intervals are clipped independently.

Requested sleep comes only from structured sleep-tool arguments. It never creates an observed wait interval. Attachments, screenshots, capture times, and command output never extend test duration.

An export adapter can retain explicit timing evidence on an item:

```json
{
  "id": "emulator-start",
  "type": "commandExecution",
  "startedAt": 1788838904,
  "completedAt": 1788838964,
  "durationMs": 60000,
  "timingEvidence": {
    "classification": "service-lifetime",
    "sourceItemId": "emulator-start"
  }
}
```

`timingEvidence` is an importer extension, not a guaranteed native history field. Set it only when the referenced exported item explicitly establishes the timing meaning. The source item must exist in the same thread and must survive quarantine. Accepted classifications are `active`, `wait`, `blocking`, `test`, and `service-lifetime`. Everything else remains `unknown`. A command mentioning an emulator or test does not establish classification. Service lifetimes remain separate from blocking and test intervals.

Use `--notes /path/notes.json` for optional semantic notes. Each note contains `threadId`, `kind`, and `text`. Supported kinds are `why`, `blocker`, and `readiness`. Other fields are discarded. Notes cannot change timing, membership, metadata, or token totals.

## Metadata and tokens

Spawn fields establish requested model, effort, provider, and tier. Thread fields and index summaries establish latest exported metadata, selected by `capturedAt`. Sources distinguish index summaries from thread exports. Conflicts are reported per agent. Equal-time conflicts remain ambiguous. Latest metadata can postdate the cutoff and never proves settings used throughout the run.

Actual tokens require explicit native response receipts exported as `modelResponse`, `response`, or `tokenUsage` items. The receipt must have a `responseId`, `scope: "response"`, and `usage.total_tokens` or `usage.totalTokens`. Thread and turn bindings must agree with the export. Account totals, cumulative summaries, receipts including agents, and prose claims are excluded. An adapter must preserve native values; it must not manufacture receipts from estimates.

`actualTokens` sums only accepted native receipt totals. Its coverage remains incomplete unless another source establishes completeness. No receipt means `null`, not zero. Cached and reasoning fields remain receipt details and are never added again. `servedModel` and `servedTier` require explicit served fields on these receipts. Requested or latest tier does not establish served tier.

## Limits

This reference is a separately invoked offline workflow. It does not change the conversation-audit skill entry point or runtime adapter. Use the full report schema for conclusions beyond deterministic timing facts.

The importer cannot recover missing exports, prove a critical-path duration, classify gaps, establish full token coverage, or infer historical served settings. Reconstruct audit facts by rerunning it against retained exports. Do not maintain a second hand-entered timing ledger.
