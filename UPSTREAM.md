# Upstream maintenance

This repository derives from `pstack` in `https://github.com/cursor/plugins`. The locked source is version `0.14.5` at commit `fd878692de15a3069c21c8f429eb0b9f2fe178fa`.

The delivered repository contains only the modified Codex version. Do not push a raw upstream branch or snapshot commit. Do not keep an upstream remote in the delivered checkout.

## Local upstream copy

This checkout keeps a full upstream clone at `.upstream/plugins`. Its local branch `locked-0.14.5` points at the locked commit `fd878692de15a3069c21c8f429eb0b9f2fe178fa`.

The checkout-local `.git/info/exclude` ignores `.upstream/`. Do not add this entry to the tracked `.gitignore`. That file is hash-locked as preserved in `compatibility/pstack-map.json`, so editing it makes `compatibility:check` fail.

Recreate the local copy after a fresh checkout of this repository:

```bash
printf '%s\n' '.upstream/' >> .git/info/exclude
git clone https://github.com/cursor/plugins .upstream/plugins
git -C .upstream/plugins switch --create locked-0.14.5 \
  fd878692de15a3069c21c8f429eb0b9f2fe178fa
```

## Provenance files

- [`NOTICE`](./NOTICE) records attribution and the source commit.
- [`upstream.lock.json`](./upstream.lock.json) records the 157 source paths, sizes, and SHA-256 hashes.
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

The import command must report `Verified 157 files`.

When `.upstream/plugins` is absent, use the repository URL as a fallback. The import helper removes its temporary clone, and it never writes into the derived tree.

```bash
node scripts/import-upstream.mjs \
  --source https://github.com/cursor/plugins \
  --subdirectory pstack \
  --commit fd878692de15a3069c21c8f429eb0b9f2fe178fa \
  --verify-lock \
  --dry-run
```

This import command must also report `Verified 157 files`.

## Review a newer source commit

Fetch the persistent local clone and list newer commits that changed `pstack`:

```bash
git -C .upstream/plugins fetch origin
git -C .upstream/plugins log --oneline \
  locked-0.14.5..origin/main -- pstack
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
