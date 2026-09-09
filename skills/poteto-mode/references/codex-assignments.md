# Optional assignment records

Use this tool when a complex workflow benefits from reusable, revision-bound handoffs. Ordinary tasks use conversation briefs directly. This record is optional. It does not start subagents or require a separate manual ledger for every task.

The main agent keeps one record and generates both briefs and status from it. Assignment IDs remain stable. Revisions bind contract readiness, acknowledgements, results, and acceptance. These are local tool semantics, not native Codex guarantees. For Codex terminology, see the [official subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents?surface=app).

## Record and contract example

Run commands from the plugin root, or resolve `../../../scripts/assignment-record.mjs` relative to this reference's directory. The CLI reads JSON from stdin and writes JSON to stdout. It does not write files.

Initialize with this input:

```json
{
  "maxActive": 2,
  "assignments": [
    {
      "id": "api",
      "owner": "api-agent",
      "goal": "Implement the item endpoint",
      "sourcePaths": ["/work/api/src"],
      "buildPaths": ["/build/api"],
      "provides": [{"name": "response-v1", "description": "GET /items returns {items: [{id: string}]}"}],
      "requires": [],
      "verification": "Check response schema and endpoint behavior",
      "stopCondition": "Return implementation and focused check evidence"
    },
    {
      "id": "ui",
      "owner": "ui-agent",
      "goal": "Render items using the response contract",
      "sourcePaths": ["/work/ui/src"],
      "buildPaths": ["/build/ui"],
      "provides": [],
      "requires": [{"assignmentId": "api", "revision": 1, "contract": "response-v1"}],
      "verification": "Check rendering against the agreed response fixture",
      "stopCondition": "Return implementation and focused check evidence"
    }
  ]
}
```

```sh
node scripts/assignment-record.mjs init < spec.json > assignments.json
node scripts/assignment-record.mjs brief ui < assignments.json
node scripts/assignment-record.mjs status < assignments.json
node scripts/assignment-record.mjs validate < assignments.json
```

`init` sets every revision to 1. `brief` includes ownership, required contract descriptions and evidence, forbidden paths, and status. `status` accepts an optional assignment ID.

## Transitions

Call `apply` with `{"record": <current record>, "event": <event>}`. Save its successful output as the next record. Never redirect output onto its input file. Errors return exit code 1 and a JSON error on stderr, with no replacement record on stdout.

Every event requires `assignmentId` and the exact current `revision`.

| Event `type` | Additional fields | Effect |
| --- | --- | --- |
| `start` | None | Starts queued work when required contracts are ready and capacity exists. |
| `acknowledge` | None | Records receipt after start without changing result or acceptance. |
| `ready` | `contract`, `evidence` | Publishes one declared contract while working. |
| `result` | `summary`, `evidence`, optional `outcome` | Records a `completed` result after all provided contracts are ready, or a `blocked` result with partial evidence. |
| `accept` or `reject` | `actor: "main"`, `evidence` | Records the main agent's decision on a reported result. |
| `revise` | `spec` containing the complete assignment specification | Preserves the ID and increments the revision. |

For example, after starting `api@1`, apply:

```json
{"type":"ready","assignmentId":"api","revision":1,"contract":"response-v1","evidence":"schema.json at tree abc; fixture check passed"}
```

Now `ui@1` can start in its owned paths while API behavior checks continue. Its integration remains blocked until both current results are accepted. Acceptance records the main agent's evidence judgment; the tool does not judge evidence quality. `canIntegrate` checks the complete dependency chain and grants no permission to merge, publish, or perform external writes.

A blocked result cannot be accepted or satisfy integration. Reject it with the observed blocker, then revise when work can resume.

A revision clears readiness, acknowledgement, result, and acceptance. It also increments and clears every transitive consumer revision. Dependency pins remain unchanged. Reissue affected specifications with current dependency revisions before restarting. Old results and acknowledgements fail the revision check. Rejection also invalidates consumers. Duplicate transitions fail; corrections require a new revision.

## Bounds and limits

`maxActive` bounds assignments in `working` state. Reported results release a slot. Before revising running work, the main agent must stop or collect its subagent. The record cannot stop processes or release actual filesystem ownership.

Source and build paths must be canonical absolute literal paths. Empty arrays permit read-only work. Paths cannot overlap across assignments, including directory descendants and source/build collisions. Ownership remains reserved after acceptance. The tool checks declared paths lexically; it cannot detect symlink aliases, filesystem case aliases, undeclared writes, or shared external resources. The main agent must establish actual isolation before starting work.

Unknown dependencies, future dependency revisions, dependency cycles, stale events, and invalid transition order fail closed. This is a single-writer JSON utility without locks, persistence, authentication, scheduling services, or runtime integration. The `actor` field records responsibility; it does not authenticate the caller. Other verification and permission gates still apply.
