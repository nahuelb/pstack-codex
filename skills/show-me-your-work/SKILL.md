---
name: show-me-your-work
description: "Keep a private, reviewable decision and execution trail for Poteto Mode, long-running work, or work reviewed after a delay. Use for $show-me-your-work, autonomous runs, multi-phase work, and audit review."
---

# Show me your work

Delegation and optional capabilities follow `../poteto-mode/references/codex-agent-runtime.md`.

Keep one concise decision ledger and one linked execution trace. These artifacts let an owner distinguish progress, waiting, scope changes, and failure without reconstructing hidden reasoning or scraping host data.

## Start or adopt the run

Poteto Mode's trusted activation hook creates one private run beneath plugin data. Its receipt names the stable run ID, parent task, canonical ledger, and execution trace. Adopt that run. Resolve `scripts/audit.mjs` relative to this skill. Run `node scripts/audit.mjs status <run-dir>` before other work to verify the receipt.

If a Poteto activation has no usable receipt, initialize one private run before continuing:

```text
node scripts/audit.mjs init <private-state-root> <parent-task-id> <project-dir>
```

Use a runtime-owned private state root outside the repository. If no such root is writable, stop and report that Poteto Mode cannot satisfy its audit contract. Never replace the private ledger with a repository file, public issue, checklist, or task summary.

Standalone `$show-me-your-work` use may keep the older local `decisions.tsv` format through `scripts/log.sh`. Poteto Mode always uses the private run from `audit.mjs`.

## Canonical decision ledger

`decisions.tsv` is append-only. It has `ts`, `run_id`, `phase`, `decision`, `why`, `evidence`, `result`, and `ref`. One row records one decision or meaningful checkpoint. `ref` points to the relevant task turn or agent when available.

Append through:

```text
node scripts/audit.mjs decision <run-dir> <phase> <decision> <why> <evidence> <result> <ref>
```

Write the row as a concise teammate update. Record the current unit, scope or owner decision, remaining gates, and next action when they change. Evidence is a safe path, commit, digest, verification receipt, or task reference.

## Private execution trace

`events.tsv` links to the ledger through `run_id`. It records only lifecycle facts needed to review performance. Its columns are `ts`, `run_id`, `actor_id`, `parent_actor_id`, `event`, `detail`, `evidence`, `state`, and `ref`.

Use events for run and agent starts, delegation, state changes, waits and timeouts, handoffs, checkpoints, commits, verification, actual blockers, review findings, and terminal states. The hooks record task turns, subagent starts, and stop observations. A stop observation is not terminal because another hook can continue the subagent. Each subagent records its own meaningful checkpoints. The main agent records the terminal event after receiving the result and reconciles any missing event before accepting it.

Append through:

```text
node scripts/audit.mjs event <run-dir> <actor> <parent> <event> <detail> <evidence> <state> <ref>
```

Do not record chain-of-thought, prompt text, commentary transcripts, unrelated commands, or routine tool calls. The trace explains lifecycle and visibility gaps. It is not a transcript.

## Freshness boundaries

Append a decision row before a new phase, after a commit, after a subagent result, after a failed gate, and before an irreversible action. Record scope changes and owner decisions when received. A commit or verification receipt also earns a matching trace event.

During long active work, checkpoint at the next supported task turn or authorized heartbeat when the current unit, evidence, blocker, remaining gates, or next action changed. If nothing changed, do not duplicate the ledger row. Record one `wait` or `timeout` event with the awaited predicate and last evidence. Never create a fixed-frequency shell loop for audit logging.

Any derived checklist, status page, or handoff names the audit run ID and canonical ledger path. It may summarize rows, but it cannot become another decision log.

## Privacy and evidence

The run metadata labels both artifacts `private`. Keep them outside the repository and never commit, upload, or paste them into public review. Public repository cleanup must leave the private run intact.

Use references and digests instead of payloads. Never store credentials, tokens, prompt bodies, environment dumps, customer data, or command output that can contain secrets. `audit.mjs` rejects common secret-shaped references and spreadsheet formulas, but the writer still owns content safety.

## Review the run

At handoff, compare both files with supported task history, live git, receipts, and artifacts. Do not scrape a private host store. Confirm that every row happened, every evidence pointer resolves, every agent has a start and terminal state, and every long gap has a wait, timeout, blocker, or checkpoint. Append corrections. Never edit or delete earlier rows.

Before handoff, resolve `arena cross-judge pool` through `../setup-pstack/references/model-profile.md`. Use a different observable model family when available. If independent review is unavailable, report that limitation. Append each finding as a `review` event and a ledger row whose `ref` names the affected row or event. This keeps cross-model findings traceable.

Every reply for a run with a trail ends with an `Attention` section. Name the reviewing model, then list flags with ledger or event references. `No flags` is valid.
