# Codex parallel execution

Use this policy for authorized multi-part work with potentially independent units. It governs scheduling through `codex-agent-runtime.md`.
It does not authorize delegation, change model routing, or waive the workflow's acceptance, review, permission, or release requirements.
Keep small, tightly coupled work with one owner when splitting it would add coordination without useful overlap.

## Identify real dependencies

Use the existing assignment brief to name its stable ID and revision, required input contracts and revisions, owned source/build paths, output and acceptance evidence.
Name the specific missing input or conflicting owner when a unit is blocked. A broad phase label is not a dependency.
Include independent verification preparation, documentation, and release readiness when they advance the accepted scope.
Surface required human access early while continuing work that does not need it.

Give shared schemas, public interfaces, generated files, and common build outputs an explicit owner.
Publish the smallest settled interface and accepted examples before its full implementation when that unblocks other units.
Identify the interface revision and its limits. Contract readiness permits consumer implementation; it does not prove upstream behavior.
Keep integration and behavior-dependent verification blocked until their actual prerequisites pass.

## Start ready work before waiting

Before waiting for an agent, check for unstarted units with available inputs, safe write ownership, and usable runtime capabilities.
Start independent ready units together within available capacity. Do not wait for one just to start another independent unit.
When a prerequisite arrives, start its newly ready consumers without waiting for unrelated agents or the entire phase to finish.
If nothing else is ready, do useful main-agent work or collect required results through the [subagent lifecycle](codex-subagent-lifecycle.md).

When capacity is full, queue work. Close completed agent threads after collecting their results when their retained context is no longer needed.
Do not interrupt active work or increase limits simply to fill more slots.
Reuse an agent when its context still fits a coherent assignment; a new phase alone does not require a replacement.
If a subagent cannot delegate, the main agent schedules the independent units through the supported subagent tools.

## Keep parallel work compatible

Use the runtime contract's disjoint ownership or isolated worktrees before writable fan-out.
Separate build and test output directories when commands would otherwise share mutable artifacts, even if source-file ownership differs.
Agents may propose interface changes but must not silently alter another unit's contract or ownership.
The main agent resolves those changes and updates affected briefs before dependent work proceeds.

Verify integrated snapshots identified by a commit or content digest. Other isolated work may continue while that snapshot is tested.
Report the revision, behavior checked, result, and limitations with each proof.
Invalidate affected evidence when source, contracts, configuration, or relevant dependencies change.
A passing result from an older snapshot does not verify the changed integration.

## Preserve verification and delivery order

Apply verify-before-advancing to dependent units and ordered migrations or sweeps. Independent ready work need not share that barrier.
An explicit task requirement to serialize work still applies.
Prioritize the smallest complete flow through the relevant real boundary before expanding dependent implementation.
A failed prerequisite blocks its consumers, while unrelated units may continue.
Final integration, required independent review, and release gates still cover the exact delivered revision.

Return the assignment ID/revision, source revision, result, proof pointers and limits in the existing result message. The main agent accepts that result explicitly before integration. An acknowledgement, pause or clarification does not replace it; a new assignment revision invalidates affected results and requires updated dependency pins.
For complex reused assignments, [optional assignment records](codex-assignments.md) generate briefs and status from one record. Use conversation briefs directly when they suffice; do not maintain both.
The main agent integrates the results and performs authorized external actions under the runtime contract.
Report missing required work as incomplete; parallel activity is not evidence of completion.
