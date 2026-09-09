# Codex run evidence

Use this policy for multi-part implementation and releases. Its purpose is to preserve facts needed to explain inefficiency later, with little work during implementation. Explicit benchmark or project evidence requirements still apply.

## Reuse the record that already exists

The conversation, assignment briefs, Git history, CI results and verifier artifacts are the default record. Before writing audit material, check whether those sources already preserve the fact. Link to it instead of copying it. Do not create a parallel decision ledger, progress report, model receipt or checkpoint merely because this policy loaded.

Keep important accepted requirements linked to meaningful checks in the existing plan or test descriptions. An audit table does not establish coverage. Preserve actual proof, source identity and limitations required by the verification workflow.

## Record only missing context

Add a short note in the current conversation or existing task artifact when a consequential fact would otherwise be lost:

- A decision or reversal, its reason and the evidence that changed the plan.
- The specific missing input, capability or ownership conflict that blocks a unit; why independent work cannot proceed, if that is true.
- A contract becoming usable before full implementation, or a result accepted or rejected for a reason its artifacts do not show.
- A correction or repeated verification cycle, what caused it and which earlier evidence it invalidated.
- An external wait's cause and observed start/end, when existing tool records omit them. Distinguish time actually blocked from work continuing alongside a service.

Record the fact once at the transition, with the affected assignment or source revision and evidence pointer. Conversation timestamps suffice for contemporaneous notes. Mark delayed observations and unknown times; never backfill a guessed timestamp as exact. If a durable note is needed for pickup, extend the existing task artifact instead of maintaining another status view.

Do not manually transcribe agent IDs, model choices, commands, test output or timings already retained by supported tools. Preserve transient proof before cleanup when it cannot be reconstructed from committed source or retained artifacts. Keep credentials and private payloads out of audit notes.

## Keep recording off the completion path

Once a finding is validated, send the bounded repair before polishing its narrative. Record the brief and evidence in that dispatch. Optional report generation or a broken audit helper must not block unrelated authorized implementation. Failed or stale verification still blocks its dependent acceptance gate.

At handoff, summarize the accepted result and remaining work using existing evidence. Do not reconstruct the whole conversation or spawn an extra trail reviewer by default. Required independent code, architecture and runtime reviews still apply. An explicit audit request can perform deeper reconstruction afterward.

Use [structured run-record tools](codex-run-record-tools.md) only for an explicit benchmark or a project gate that needs these receipts. They are optional for ordinary implementation and do not replace an existing verifier. When selected, generate views from that record rather than writing competing ledgers. This policy does not enable telemetry or change model settings.
