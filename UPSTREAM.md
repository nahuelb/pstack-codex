# Upstream maintenance

This repository derives from `pstack` in `https://github.com/cursor/plugins`. The locked source is version `0.14.8` at commit `7314f723a487ec406b6369fe5865ba034cfed166`.

The delivered repository contains only the modified Codex version. Do not push a raw upstream branch or snapshot commit. Do not keep an upstream remote in the delivered checkout.

## Codex-owned execution policy

`skills/poteto-mode/references/codex-agent-runtime.md`, `skills/poteto-mode/references/codex-parallelism.md`, and `skills/poteto-mode/references/codex-run-evidence.md` are local extensions, not upstream source files.
The runtime contract is the single loading point for scheduling and run evidence. Keep execution preferences there instead of duplicating them across upstream skills.
Model routing remains in the existing registry, and workflow acceptance and verification requirements remain authoritative.

Preserve these extensions during upstream refreshes. Review their semantics against changed workflows, including dependencies, ownership, and required gates.
Keep their loading and behavioral checks in `tests/codex-parallelism.test.mjs` and `evals/cases/codex-parallelism.json`.

For a live behavioral check, generate scenarios without reference answers using `node scripts/grade-parallelism-eval.mjs --inputs`.
Give those scenarios to a fresh agent through the runtime contract. Request a JSON array with `id`, `dispatch`, `blocked`, `close`, `invalidate`, `coordinator`, and `canFinish` for each scenario.
The evaluation plans actions only; it must not execute them. Save the response and run `node scripts/grade-parallelism-eval.mjs <answers.json>`.
Offline tests validate loading and grading, not model behavior. Retain live results separately and repeat them when scheduling semantics change.

The Codex-owned run tools are `scripts/run-record.mjs`, `scripts/lib/run-record.mjs`, `scripts/render-run-report.mjs`, and `scripts/benchmark-runs.mjs`. Preserve them and their `tests/run-*.test.mjs` checks during refreshes. They capture local evidence and produce reports; they neither perform external closeout actions nor replace required verification. Project-specific release helpers belong in the target project, outside this plugin.

The standalone prompt refresh extension consists of `skills/setup-pstack/scripts/refresh-agent-prompts.mjs`, `skills/setup-pstack/references/agent-prompt-refresh.md`, and `tests/agent-prompt-refresh.test.mjs`. Its small loading reference belongs in the existing Codex model adapter. Preserve it during refreshes and check compatibility with the installer receipt schema; prompt refresh must retain user configuration and expose, rather than silently adopt, model-registry drift.

The existing Codex installer also rejects `preserved-unverified` records before rewriting files. This small guard belongs at the write boundary in `manage-agents.mjs`: a separate refresh helper cannot prevent a later installer from discarding preserved configuration.

## Local upstream copy

This checkout keeps a full upstream clone at `.upstream/plugins`. Its local branch `locked-0.14.8` points at the locked commit `7314f723a487ec406b6369fe5865ba034cfed166`.

The checkout-local `.git/info/exclude` ignores `.upstream/`. Do not add this entry to the tracked `.gitignore`. That file is hash-locked as preserved in `compatibility/pstack-map.json`, so editing it makes `compatibility:check` fail.

Recreate the local copy after a fresh checkout of this repository:

```bash
printf '%s\n' '.upstream/' >> .git/info/exclude
git clone https://github.com/cursor/plugins .upstream/plugins
git -C .upstream/plugins switch --create locked-0.14.8 \
  7314f723a487ec406b6369fe5865ba034cfed166
```

## Provenance files

- [`NOTICE`](./NOTICE) records attribution and the source commit.
- [`upstream.lock.json`](./upstream.lock.json) records the 158 source paths, sizes, and SHA-256 hashes.
- [`compatibility/pstack-map.json`](./compatibility/pstack-map.json) assigns each source path a Codex path, classification, invariant, and validation.
- [`compatibility/report.md`](./compatibility/report.md) is the generated human-readable report.

## Check the locked source

Prefer the persistent local copy when `.upstream/plugins` exists:

```bash
node scripts/import-upstream.mjs \
  --source .upstream/plugins/pstack \
  --verify-lock \
  --dry-run

node scripts/generate-compatibility-report.mjs \
  --check \
  --upstream-dir .upstream/plugins/pstack
```

The import command must report `Verified 158 files`.

When `.upstream/plugins` is absent, use the repository URL as a fallback. The import helper removes its temporary clone, and it never writes into the derived tree.

```bash
node scripts/import-upstream.mjs \
  --source https://github.com/cursor/plugins \
  --subdirectory pstack \
  --commit 7314f723a487ec406b6369fe5865ba034cfed166 \
  --verify-lock \
  --dry-run
```

This import command must also report `Verified 158 files`.

## Review a newer source commit

Fetch the persistent local clone and list newer commits that changed `pstack`:

```bash
git -C .upstream/plugins fetch origin
git -C .upstream/plugins log --oneline \
  locked-0.14.8..origin/main -- pstack
```

Then review a candidate:

1. Check out the exact candidate commit in a separate local worktree or temporary clone.
2. Point `scripts/generate-compatibility-report.mjs --upstream-dir` at the candidate `pstack` directory.
3. Review every added, changed, deleted, or renamed path. Record a `refreshDisposition` in `compatibility/pstack-map.json` before adapting code.
4. Port behavior into the Codex tree. Do not copy host-specific installation or runtime claims.
5. Update the source metadata and hashes in `upstream.lock.json` only after review.
6. Regenerate `compatibility/report.md` and run the full release checks.
7. Delete the candidate worktree or temporary clone. Confirm that the delivered repository has no upstream remote or raw source branch.

To inspect a candidate without changing the committed report, run:

```bash
node scripts/generate-compatibility-report.mjs \
  --check \
  --upstream-dir /absolute/path/to/temporary/plugins/pstack
```

The command exits with blocking findings until every source delta has an explicit disposition. The import helper refuses to overwrite an existing output directory, and the inventory rejects symlinks.

## Regenerate the report

After the lock and compatibility map agree, run:

```bash
node scripts/generate-compatibility-report.mjs
node scripts/generate-compatibility-report.mjs --check
node --test tests/upstream-provenance.test.mjs tests/compatibility-map.test.mjs
```

Review the generated diff. A complete report accounts for every locked path and has no unresolved source delta.
