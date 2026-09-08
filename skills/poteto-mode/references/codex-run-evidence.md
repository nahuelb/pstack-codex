# Codex run evidence

Use this extension for multi-part implementation, release work, or an explicitly measured workflow. Keep small edits lightweight. It adds evidence collection to the existing workflow; it does not replace its reviews, user acceptance, or release gates.

## Turn decisions into proof

Before dispatching implementation, write the important settled decisions as acceptance criteria and name the checks that will establish them. For example, “expired invitations cannot grant access” needs an expired-invitation assertion, not just a successful build. Reuse existing tests. Add coverage only where the behavior lacks meaningful proof. If a decision is unresolved, leave its dependent unit blocked and advance independent work.

The main agent owns one run record outside the source checkout. Initialize it early, then record events as work happens. Commands below resolve from the plugin root, three directories above this reference; they do not require installing scripts into the product repository.

```sh
node <plugin-root>/scripts/run-record.mjs init <run-dir> <manifest.json>
node <plugin-root>/scripts/run-record.mjs event <run-dir> <event.json>
node <plugin-root>/scripts/run-record.mjs verify <run-dir> <check-id>
node <plugin-root>/scripts/run-record.mjs status <run-dir>
```

The manifest uses this shape. Replace the example with the actual acceptance contract and repository commands; do not treat a command's name or exit code as proof that it covers a decision.

```json
{
  "schemaVersion": 1,
  "runId": "invitation-expiry",
  "objective": "Reject expired invitations",
  "sourceRoot": "/absolute/product-checkout",
  "createdAt": "2026-01-01T10:00:00.000Z",
  "decisions": [{ "id": "expiry", "text": "Expired invitations grant no access" }],
  "units": [{ "id": "implement", "title": "Enforce expiry", "dependsOn": [] }],
  "criteria": [{
    "id": "expired-rejected", "description": "An expired invitation is rejected without granting access",
    "decisionIds": ["expiry"], "checkIds": ["invitation-test"]
  }],
  "checks": [{
    "id": "invitation-test", "description": "Expired invitation regression assertions",
    "sourcePaths": ["src/invitations", "tests/invitations.test.mjs", "package.json", "package-lock.json"],
    "command": ["node", "--test", "tests/invitations.test.mjs"]
  }]
}
```

Include the source, shared contracts, relevant configuration and dependency locks that can affect each check. Directory snapshots include new files. `.git` and `node_modules` are excluded; name dependency lockfiles explicitly. Source symlinks are rejected rather than silently following unrecorded inputs. A snapshot cannot cover undeclared dependencies, environment changes or remote state: reverify those when they change. Keep generated build outputs outside a check's declared source inputs when possible.

Verification captures the exact manifest, relevant source hashes before and after execution, exit code, timestamps and output hash. Changes during verification, later source changes or missing/altered proof make the receipt stale. Rerun affected checks after integration; reuse current evidence for unaffected checks. The record is an auditable local assertion, not a tamper-proof attestation or a sandbox. Run only commands authorized by the task, and keep secrets out of recorded output.

For browser, review or external tool evidence, the main agent reviews the actual result and attaches a proof file:

```sh
node <plugin-root>/scripts/run-record.mjs attach <run-dir> <proof.json>
```

`proof.json` contains `checkId`, absolute `artifact`, `verdict` (`passed` or `failed`), and a substantive `summary`. Attach only evidence reviewed against the current inputs. The receipt labels this origin `reviewed-artifact`, separately from a command executed by the helper. Attaching an old artifact does not reverify it.

## Record progress without repeated polling

Use supported Codex results and the main agent's own operations to append events. Keep one main writer; a conflicting write fails and can be retried after it finishes. Verification runs do not hold the event lock while their command executes. Do not install hooks, scrape private stores, schedule monitors, or infer token counts from output length.

An event has `type`, optional `at` (the actual occurrence timestamp), and optional `actor`: `{ "threadId": "...", "kind": "main" | "subagent", "role": "...", "requestedModel": "...", "servedModel": "..." }`. The helper adds an ID and recording timestamp. Omit unobserved fields. Use these events where observable:

- `run_started`, `run_finished`: actual scope boundaries. A late start measures only the remaining segment; label its objective accordingly.
- `unit_ready`, `unit_started`, `unit_finished`: include a manifest `unitId`; a finish may include `outcome: "passed"` or `"failed"`. Record subsequent attempts separately.
- `external_wait_started`, `external_wait_finished`: pair with `waitId`; use for external blockers such as an outstanding owner action or service response.
- `integration_finished`, `release_finished`: record actual completed milestones with a short `summary`. Acceptance passing does not establish either milestone.
- `token_usage`: include actor, supported receipt `source`, and `usage.totalTokens` (or `null` when unavailable). Optional input, output, cached-input and reasoning-output counts are cumulative for this run and actor. Only the latest snapshot counts; cached and reasoning counts are subsets, never additional tokens. Do not attribute account-wide usage to a task.

Elapsed unit spans include tool waits and can overlap. They do not establish active model computation or main-agent idle time. Label requested models separately from served models, and mark the latter unverified when the runtime does not expose them. Events support reporting; they do not start agents or unlock dependencies. The main agent still validates scheduling and required results.

## Generate closeout and measure actual runs

```sh
node <plugin-root>/scripts/render-run-report.mjs <run-dir> --output <report.md> --ticket-output <ticket-draft.md>
node <plugin-root>/scripts/benchmark-runs.mjs <baseline-run-dir> <candidate-run-dir>
```

Generate the report after integration and final verification. It must show blocked criteria and stale/missing proof, observed main/subagent work, unavailable usage, and the release milestones actually recorded. A ticket draft is proposed text only. The main agent must validate live issue state, destination, payload and authorization before any external update. Never mark a task complete merely because a report was generated.

For a planned benchmark, add `benchmark: { "caseId": "...", "environment": "...", "models": ["..."] }` to the manifest before starting. Compare real completed runs with the same acceptance contract, environment and model setup. Freeze scope before measurement; repeat against controlled starting inputs when claiming a causal improvement. A historical estimate, a synthetic fixture, or two unrelated features is not a throughput benchmark. Report elapsed time, queue delay, rework and external waits only where their event pairs exist. Keep collecting representative feature runs before changing policy based on a speedup claim.
