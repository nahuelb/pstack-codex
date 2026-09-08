# Refresh standalone agent prompts

Use this local extension only after the user approves prompt refresh and reconciliation of the two existing agent records. It does not install agents or change model routing. Main owns review and real configuration changes.

The helper requires Node 20+ and `python3` with Python 3.11+ `tomllib`. It imports the existing manager's name scanner. Full TOML parsing also catches quoted names and duplicate keys. It reads portable prompts from this plugin checkout.

Create a plan with explicit scope and absolute paths. Paths must have no symbolic links, including ancestor directories.

```sh
node skills/setup-pstack/scripts/refresh-agent-prompts.mjs plan \
  --scope user --project-root /absolute/project --user-home /absolute/home \
  --plan /absolute/new-plan.json
```

Review the printed `plan_sha256`, file diffs, `reconciliation`, and `expected_receipt`. The plan contains complete configuration snapshots. Store it privately. Apply exactly that plan with its reviewed hash:

```sh
node skills/setup-pstack/scripts/refresh-agent-prompts.mjs apply \
  --plan /absolute/new-plan.json --expected-plan-hash REVIEWED_SHA256
```

API exports are `planPromptRefresh(options)`, `promptRefreshPlanHash(plan)`, and `applyPromptRefresh(plan, { expectedPlanHash })`. `replaceAgentPrompt(content, prompt, name)` performs the isolated string replacement.

Only the root `developer_instructions` string value changes. Other TOML bytes remain intact, including model, effort, sandbox, comments, and tables. Ambiguous assignment locations require manual review. Both agent directories are scanned. Unknown receipts, missing records, relocated files, duplicate names, symlinks, hard links, and malformed TOML stop planning.

The receipt records the refreshed agent hash and source hash. A divergent agent record stores its previous receipt as history. Its current model fields become `preserved-unverified` observations, with no requested or resolved model claim. Previous capability assertions move into history. This review accepts ownership of each complete preserved agent file; an old hash cannot prove that models were the only prior edits. Review the full agent configuration before applying.

Registry bytes and registry receipt records remain unchanged, even when their hashes differ. Registry role policies remain historical setup data. A divergent registry therefore still blocks ordinary installation. This helper does not repair or adopt it. Refresh does not validate model availability or runtime permissions.

Ordinary installation also refuses any `preserved-unverified` custom-agent record, even when the registry matches its receipt. A reviewed prompt refresh must not let a later installation silently replace preserved settings with inheritance or template defaults. Continue using prompt refresh for instruction updates; changing these configurations requires a separate reviewed setup migration.

Before mutation, the helper saves the complete plan and numbered original files under `.codex/pstack-prompt-refresh-backups/refresh-*`. The plan identifies each numbered file through `changes`. Apply regenerates the plan and compares all inputs before writing. Changed sources, configuration, receipt, or agent inventory require a new review.

Write failures restore files changed by this operation. A concurrent edit is preserved and reported for manual recovery. Use the backup's `plan.json` and numbered `.before` files to inspect recovery. Do not restore over newer user changes.

File replacement is atomic per file, not across the whole set. Hash checks detect observed races; they cannot exclude an external writer between a check and rename. Stop other configuration writers during apply. A process crash can require manual recovery from the backup. The helper does not claim a filesystem transaction or runtime verification.

Standalone fields and identity follow the [official Codex subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents?surface=app). Main must wire this extension into setup guidance and record its ownership in `UPSTREAM.md`.
