# Conversation audit report

Use this schema for the final report. Omit an empty detail table only when its coverage row says the source is unavailable.

## Calculations

- Conversation wall time: terminal timestamp minus earliest supported start timestamp. For an open conversation, use an explicit report `as of` timestamp and label the elapsed value partial. If neither terminal nor trustworthy `as of` time exists, mark wall time unavailable.
- Actor wall time: actor terminal minus actor start. For an open actor, use the report's `as of` timestamp and label the duration partial. If no trustworthy `as of` time exists, mark it unavailable.
- Role duration: report both cumulative actor wall time and the union of overlapping role intervals. Also report count, median, maximum, and critical-path contribution when timestamps support them.
- Active and wait time: sum only explicit state intervals. Do not subtract guessed idle time from wall time.
- Peak concurrency: maximum overlapping actor intervals with supported boundaries.
- Critical path: split actor timelines at start, delegation, wait, handoff, resume, and terminal events. Build a dependency graph from those non-overlapping event segments and find its longest weighted path. Never sum a delegating actor's wall interval when it contains subagent execution. If segment boundaries or edges are incomplete, report path topology without a duration.
- Token totals: prefer each provider receipt's native total. For OpenAI-compatible usage, `total_tokens` already contains input and output tokens; cached tokens are a subset of input and reasoning tokens are a subset of output. Display those details but never add them to `total_tokens`. For another provider, use only its documented total or state the provider-specific formula. Deduplicate by conversation, response, and actor identity before aggregation. Do not add a main-thread summary receipt to the agent-thread tokens it summarizes.
- Rework ratio: reverted or superseded implementation units divided by completed implementation units. State the chosen unit.
- Retry rate: retried operations divided by attempted operations for the same operation class.
- Verification coverage: completed units with authoritative proof divided by completed units.
- Review yield: confirmed review findings divided by total review findings, with severity distribution.
- Token efficiency: exact non-overlapping tokens divided by a meaningful accepted output such as verified units, accepted commits, or confirmed findings. Omit the ratio when the denominator is arbitrary.

## Required sections

### 1. Executive verdict

State the report's `as of` timestamp, outcome quality, process quality, efficiency, audit confidence, and the three most important lessons.

### 2. Evidence coverage

| Source or metric | Coverage | Grade | Limitation |
|---|---:|---|---|

Include thread history, agent threads, model identity, pstack role, timestamps, token fields, tool receipts, audit artifacts, commits, and verification.

### 3. Run topology and timeline

Show the main thread, agent threads, delegation edges, phases, scope changes, waits, blockers, handoffs, commits, and terminal states. Identify the critical path and parallel work that did not affect it.

### 4. Actor, model, role, time, and tokens

| Actor | Thread | Pstack role | Requested model | Served model | Effort/tier | Start | End | Wall | Active | Wait | Input | Output | Cached detail | Reasoning detail | Native total | Outcome | Sources |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|

Annotate every identity, duration, and token value with its own provenance grade, such as `42s [D,S3]` or `unavailable [U]`. The Sources column resolves source IDs. Use `unattributed`, `unverified`, or `unavailable` instead of blanks that look like zero.

Provide rollups by model, pstack role, phase, and successful versus discarded work. State how double counting was prevented.

For usage questions, include the [usage analyzer](usage-attribution.md) coverage and rankings by subagent, role, model/provider, and immediate delegating task. Include the combined dimensions and first/last request timestamps. Display input, cached input, cache reads, cache creation, output, reasoning, and native total separately. Rank observed reported subtotals; retain estimates, missing fields, and unattributed rows separately. A partial ranking cannot prove the highest total consumer across missing records. Keep API-equivalent cost estimates separate from actual billing and subscription quota.

### 5. Performance analysis

Report wall time, role-duration rollups, critical path, peak concurrency, serial bottlenecks, idle or stuck intervals, timeout behavior, commit cadence, tool time, retry rate, rework ratio, token efficiency, compactions, model switches, and context churn. Separate measured duration from inferred delay. Do not call a run inefficient solely because it lacks a comparison baseline.

### 6. Decision and execution quality

List strong decisions worth preserving, weak or late decisions, scope drift, user corrections, evidence gaps, verification quality, review findings, and unresolved risks. Point to turns, events, commits, or receipts.

### 7. Findings

Use P0 through P3 severity. Each finding includes evidence, impact, root cause, confidence, and whether it is a conversation defect, pstack defect, runtime limitation, or missing telemetry. Distinguish an absent instruction, an instruction that was not followed, a weak model or role choice, a tool failure, and an observability gap.

### 8. Pstack improvement backlog

| Priority | Evidence | Root cause | Target | Proposed change | Test or eval | Expected benefit | Tradeoff |
|---|---|---|---|---|---|---|---|

Prefer a small ordered set. Separate confirmed changes from experiments.

### 9. Unknowns and next instrumentation

Name every requested metric that remains unavailable. State the smallest future capture that would make it exact, such as response token receipts, explicit role-resolution events, actor start and stop events, or tool-duration telemetry. Do not present account-wide usage as conversation usage.

### 10. Recommended next changes

End with the smallest high-confidence implementation set. Do not modify files until the user approves specific items.
