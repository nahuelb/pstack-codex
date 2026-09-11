# Audit storage

Apply this extension before creating verification hosts, captured inputs, dependency installs, native builds, or audit scratch directories, and at task closeout.

Keep durable proof separate from regenerable storage. Retain acceptance receipts, focused logs, source identity, lockfiles, harness inputs and failure evidence needed to explain the result. Link existing evidence instead of copying repositories into each audit round. Never treat a source hash alone as reconstructable proof of uncommitted inputs.

Use one owned scratch host per concurrent verification lane. Reuse it for sequential checks when toolchain, dependencies and source identity match. Invalidate affected outputs when they change. Separate mutable build output, Gradle homes and emulator state between concurrent writers; share only caches whose tools support concurrent access. Never hard-link mutable build trees. Do not duplicate dependency installs or native hosts merely to capture another receipt.

Before expensive work, check filesystem free space and estimate peak scratch demand. If it will not fit, serialize independent build lanes, clean verified inactive scratch, or report the storage blocker. Preserve all required checks. Record the scratch paths and owner in the existing task brief so cleanup can establish scope later.

At completion, retain no regenerable native build output or copied dependency trees for finished verification lanes unless an explicit debugging or reuse need remains. For retained scratch, record its owner, reason and next cleanup point. Keep evidence required by acceptance, reproducibility or project retention rules. Capture bounded relevant logs before removing bulky output; do not truncate a receipt's hashed artifact in place.

Cleanup requires current task status, process/open-file checks, and Git inspection for each exact path. Missing task history and old timestamps do not prove inactivity. Preserve active or pinned work, uncommitted and untracked user files, and detached commits. Remove only verified regenerable paths within authorized scope. Do not blanket-delete audit roots, Git worktrees, shared caches or conversation stores. Coordinate ownership with other cleanup tasks before deletion.

Report exact removed paths and retained exceptions. Compare filesystem free space before and after, separately from directory sizes. APFS clones and hard links mean directory totals do not establish exclusive physical bytes. Concurrent cleanup also prevents attributing the full filesystem change to one task.

The optional run-record helper compresses input snapshots with gzip and hashes the stored bytes. It accepts legacy JSON snapshots. Capture defaults to 16 MiB of source bytes and 10,000 files per check, with a separate limit of 20,000 total file and directory entries; overlapping paths count once. Checks can set positive `maxInputBytes`, `maxInputFiles` and `maxInputEntries` budgets after reviewing storage demand. Exceeding a budget blocks capture before the command runs; narrow generated inputs or explicitly size the budget instead of omitting required proof. Compression bounds each capture's footprint but does not expire receipts. Preserve historical evidence according to project retention needs.
