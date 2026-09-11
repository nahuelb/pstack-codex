# Verified execution

Use this local extension with [run evidence](codex-run-evidence.md) when acceptance depends on runtime identity, concurrency, or a proof harness. It preserves the workflow's required reviews, permissions, and acceptance gates. Follow the [runtime contract](codex-agent-runtime.md) for delegation. Codex terminology follows the [official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents?surface=app).

## Establish the execution target first

Declare the exact source checkout before building or testing. `verify` resolves `sourceRoot` to its canonical path and executes there. Optional check `cwd` must resolve to that same checkout. A nested directory or another checkout fails preflight. A wrapper that changes directory still needs project assertions for its actual build and runtime target.

Declare project checks for toolchain versions, dependency resolution, package identity, installed artifacts, and required environment values before expensive execution. Use `preflight: [{ "command": ["node", "scripts/check-runtime.cjs"], "expectedStdout": "runtime verified\n" }]`. Each command runs in the canonical checkout with the same captured environment as the proof command. Both exit zero and exact stdout are required. A mismatch prevents the proof command from starting. Include these assertion scripts and relevant configuration in the captured inputs.

Use `environment: { "RUNTIME_MODE": "native", "UNWANTED_OVERRIDE": null }` for exact environment expectations; null requires absence. Keep secrets out of expectations, snapshots, and output. Preflight hooks are authorized project commands, not a sandbox. They must inspect the actual resolved toolchain and installed artifact, rather than echo the requested values. The generic helper cannot infer project-specific identity or resolution rules.

## Declare and capture the proof inputs

Keep check `sourcePaths` focused on relevant source, contracts, configuration, and dependency locks. Add `proof.inputPaths` for the actual harness and fixtures, including ignored files. Git ignore rules do not exclude declared inputs. Directory traversal skips `.git` and `node_modules`; name required files inside skipped directories explicitly. Symlinks and checkout escapes fail closed. Declare external dependencies through project preflight assertions; the snapshot only captures files within the checkout.

New receipts store a gzip-compressed, hashed input snapshot containing canonical cwd, the relevant contract, sorted file inventory, executable bits, content hashes, and base64 bytes. The input inventory reconstructs `sourceHash`; snapshot and artifact hashes bind the captured evidence to the receipt. Source changes during preflight prevent proof execution. Changes during execution make the receipt stale. Attached reviewed artifacts are copied into the run directory, so later edits to their original paths cannot replace captured evidence. Original-file changes still invalidate freshness, preserving the existing integrity gate.

These are local integrity checks, not tamper-proof attestations. A writer who controls both evidence and receipts can forge them. Before/after snapshots do not detect a transient mutation that restores the original bytes. Isolate writers and inspect harness coverage. An omitted dependency cannot be established by a hash.

## Require observed milestones

A proof check declares ordered, unique, exact output lines:

```json
{
  "proof": {
    "inputPaths": ["proof/runtime.cjs", "proof/fixtures.json"],
    "milestones": ["runtime identity asserted", "both participants reached barrier", "result asserted"]
  }
}
```

The harness must emit each line only after its corresponding assertion succeeds. Capture payload values when observed; do not retain a mutable object reference and serialize it later. For concurrency, assert participant arrival and overlap at the actual barrier before release. A planned barrier or a final success message does not establish that it was reached. Missing or reordered milestones fail even with exit zero. Preflight output cannot supply proof milestones. A nonzero exit, spawn error, signal termination, or source change remains a failure or stale result.

Declare milestones that establish the specific claim. A generic line matcher cannot establish actual JSI execution, native threading, or concurrency by itself. Review the captured harness and its observations. Distinguish a real native runtime from a simulated bridge. A simulation proves only its modeled behavior. Browser readiness establishes a handoff point; it does not establish native execution or completed browser acceptance. Verify each required surface with its own observations.

Proof-specific or preflight checks require `verify`; `attach` cannot supply their execution binding. Legacy review-only checks still accept reviewed attachments. Their provenance is a reviewer assertion against current inputs, not proof that an earlier external execution used those inputs.

## Reuse only the relevant proof

Receipts become stale when their check definition, linked criterion description, linked decision text, declared inputs, expected environment, or captured evidence changes. Unit progress, unrelated checks and criteria, and check `status` or `metadata` do not invalidate unaffected proof. Keep acceptance requirements in contract fields, never in ignored status or metadata fields. Old receipts remain readable but fail closed until rerun under the new capture format.

Status checks validate stored observations and declared local inputs. They do not rerun preflight hooks or inspect a live device, package installation, remote service, or toolchain. Rerun verification when that external state changes or current readiness matters. A service readiness receipt proves readiness at its timestamp, not continued service lifetime. Recheck readiness at browser handoff and preserve the required service ownership until acceptance finishes.

The library `createManifest(input)` and CLI `init` supply `createdAt` only when omitted. Supplied timestamps must be valid ISO timestamps with a timezone; malformed values fail instead of being replaced. Run records and captured input bytes stay outside the source checkout.
