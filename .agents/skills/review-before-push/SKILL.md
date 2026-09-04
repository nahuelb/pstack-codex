---
name: review-before-push
description: Use before any git push, PR creation, or PR update, including when the user asks to push or publish changes. Run an independent review of the outgoing diff, fix confirmed findings, validate, and report.
---

# Review before push

Review exactly what is about to be pushed, then act on the findings before pushing.

## Select the scope

- For uncommitted work, review the working-tree diff.
- For committed work, resolve the upstream and review its branch diff.
- For committed and uncommitted work, commit the intended work before reviewing the branch diff.
- Confirm the selected diff is non-empty.

Resolve the upstream from repository evidence. Never assume the base branch.

## Run the review

Use judgment to skip an independent review only for clearly trivial, non-behavioral changes.

In Codex, start a `default` subagent with `gpt-6-astra` and `medium` reasoning. Follow `subagent-lifecycle`. Tell the subagent to read `~/.codex/skills/.system/review-agent/SKILL.md` completely. Pass the resolved review target and intended outcome. Require read-only review and the complete findings and verdict.

Do not add a custom review focus unless the user requested one. If the reviewer fails, report the failure and do not claim a review occurred.

## Triage

1. Verify every finding against the code, intended outcome, and diff boundary.
2. Fix confirmed in-design defects.
3. Dismiss false positives with a code-backed reason.
4. Record out-of-scope improvements without implementing them.
5. Run the relevant checks.

Skip a repeat review for a small, understood P2 or P3 fix covered by relevant checks. Review a P0 or P1 fix again only when it stays inside the chosen design. A second consecutive review with a new P0 or P1 requires design reassessment before another review.

Push only after the bounded review process and validation are clean.

## Report

Include the review verdict, the complete reviewer output, fixes, dismissals, validation, repeat-review decision, and any design checkpoint.
