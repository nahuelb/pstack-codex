# Example: which subagents used this model most?

Synthetic fixture audit, as of 2026-09-09T13:00:00Z. Main task: `main`. Filter: `anthropic`, `claude-fable-5-1`. Reproduce with the command in [usage attribution](usage-attribution.md).

The reviewer has the largest observed reported subtotal among identified agents: **360 tokens**. This does not establish the true highest consumer: **1,100 reported tokens lack agent identity**, and one retry lacks usage.

| Evidence coverage | Result |
|---|---|
| Retained request/attempt records | 7, partial history |
| Usage grades | 5 reported, 1 estimated, 1 missing |
| Requesting-thread identity | 6 of 7 records |
| Explicit role assignment | 5 of 7 records |
| Duplicate exports | 1 discarded copy of `r-build` |
| Observed request window | 12:02 to 12:09 UTC |

| Rank | Agent / role | Reported subtotal | Estimated subtotal | Evidence |
|---:|---|---:|---:|---|
| 1 | reviewer / reviewer | 360 | 600 | `r-review:1`, `r-estimate:1` |
| 2 | builder / implementer | 300 | unavailable | `r-build:1`, `r-resumed:1`; `r-retry:1` is missing |
| 3 | main / unattributed role | 120 | unavailable | `r-main:1` |
| unavailable | unattributed agent / role | 1,100 | unavailable | `r-historical:1` |

The reported model subtotal is **1,880**. Input is 1,650 and output is 230. Cached input and cache reads each report 1,260; these are overlapping detail fields. Cache creation is 60. Reasoning is 25, included in output. Do not add the detail fields to the total. Estimated input/output are 500/100, producing a separate 600-token estimate.

The `claude-opus-5` filter produces 520 reported tokens: 480 for nested tester `r-test:1` and 40 for builder retry `r-retry:2`. The tester belongs to immediate delegating task `builder`; other identified records belong to `main`. The historical record retains conversation group `main`, but its immediate delegating task is unknown. Across both models, reported usage is 2,400 and estimated usage remains 600. Each aggregation view counts a request attempt once.

Fixture API-equivalent cost is approximately $0.06 for the filtered attempts with estimates. One attempt is unpriced. The alternative request estimates also sum to $0.06; these must not be added. Fixture costs are illustrative, not a pricing table. Actual billing and subscription quota are unavailable.

Request references resolve to `tests/fixtures/usage-audit/logs.json`. Delegation and role projections use `history.json` and `roles.json` in that directory. Their separate requesting-thread metadata demonstrates the proposed integration contract. Removing that metadata preserves model totals and makes every agent/role row unattributed, as tested.

A live read-only check on 2026-09-09 used OpenCodex 2.46.0. The analyzer accepted three retained records for the implementation's main task, with reported usage and no agent or role identity. Ordinary usage JSON also returned measured accounting while usage debug was off. No paid traffic was launched for this check. These observations validate interface compatibility, not complete historical coverage or deployment of child attribution.
