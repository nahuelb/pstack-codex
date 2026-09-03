Delegation, lifecycle, isolation, history, and capability fallbacks follow `../references/codex-agent-runtime.md`.

### Shipping

**You own what lands. Verify each PR independently, land only the verified run from the root, then keep your hands off the queue.** For "land the stack", "ship it", "enable merge when ready", or the second half of a stack that **Babysit** already drove to green.

This is the half after `playbooks/babysit.md`. Babysit makes a stack mergeable. Shipping decides what is safe and lands it from the bottom, one PR at a time. Green is not safe.

1. **Verify every PR independently before arming anything.** Use one isolated Codex worktree subagent per PR. Each exercises the real surface against base and head. Each returns `PASS`, `PASS+NOTES`, or `FAIL` and posts that verdict on its PR. Safe means an agent that did not write the code produced the verdict. CI green and bot approval are not verdicts.
2. **Land only the contiguous verified run rooted at the bottom.** Walk up from the lowest unmerged PR and stop at the first one without a passing verdict, where both `PASS` and `PASS+NOTES` pass. A verified PR sitting above an unverified one is not landable, because merging it would pull the gap in underneath it. Report the ceiling as a PR number and say what breaks the chain.
3. **Re-check that each verdict still describes the patch.** Record the verdict head SHA, base SHA, and stable `git patch-id` of the base-to-head diff. Before landing, compare that patch-id with the current base-to-head patch. Re-verify changed patches. For unchanged patches, keep the code verdict but rerun mergeability and CI at the current head.
4. **Prepare only the bottom PR.** Fetch current trunk. Rebase the lowest verified branch onto the exact trunk tip when needed, push it, and retarget only that PR to trunk with `gh pr edit <pr> --base <trunk>`. Repeat step 3 after any push. Do not prepare descendants yet.
5. **Land one PR at a time.** If the bottom PR is mergeable, squash it with `gh pr merge <pr> --squash`. If checks are pending and the user asked for merge-when-ready, arm only that PR with `gh pr merge <pr> --squash --auto`. Wait for that PR to merge before preparing the next one.
6. **Treat `autoMergeRequest` as one PR's state only.** It does not prove a descendant is queued, a patch verdict is current, or the full stack is safe. Confirm it only for the current bottom PR. Report unknown state when GitHub cannot confirm it.
7. **Recompute after every merge.** Fetch trunk, confirm the merged SHA is present, remove that PR from the frozen bottom-to-top list, and inspect the next PR's base, head, checks, and patch-id. GitHub may retarget a child automatically. Verify the actual base before continuing.
8. **Watch the current frontier until it merges or fails.** When the request authorizes continued monitoring, run the GitHub watcher for only the current bottom PR and use a thread heartbeat. After each wake, read `state`, `mergedAt`, `mergeStateStatus`, `statusCheckRollup`, and `autoMergeRequest` with `gh pr view`. Continue only after GitHub reports the PR merged. Diagnose a stall before any mutation.
9. **Stop at the ceiling.** When the verified run is merged, report what landed, what the next unverified PR is, and what verifying it would take. Extending the run is a new pass through step 1, not a judgment call you make at 3am.

**Reply:** the verified run and its ceiling, each PR's verdict and who produced it, what you armed and how you confirmed it, what landed, and what the next gap needs.
