Delegation, lifecycle, isolation, history, and capability fallbacks follow `../references/codex-agent-runtime.md`.

### Opening a PR

Invoked at the end of every other playbook.

**Worktree.** Work from a git worktree off main; subagents inherit it. Multiple subagent dispatches on the same branch each get their own worktree, or `git fetch && git reset --hard origin/<branch>` between them. Dirty branch with unrelated work: patch out, fresh worktree, apply. Snarled worktree: reset from main, redo minimally.

**Commits.** Commit liberally; rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit; new commit when separable.

**PRs.** Run `$unslop` over the diff before commit and `$no-comments` before review. Write every PR title, description, and commit body with `$technical-writing`, then apply `$unslop`. Apply every technical-writing layer except Diátaxis.

**Titles.** Use Conventional Commits in the form `type(scope): subject`. Use `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf` as the type. Use the changed area as the scope. Keep the subject short and imperative. Apply the same `$technical-writing` and `$unslop` pass as the body.

**Descriptions.** Write a short briefing with the problem, approach, scope, and proof. Link detailed logs and metric tables. Retain material limitations and required evidence. Follow the repository's merge policy.

Use these sections in order. Drop a section when it is empty.

- `## Why`. State the intent and why this approach fits.
- `## Scope`. State facts from the diff. Name real symbols and paths. Name both sides of a rename or retarget. State what is in and out when the boundary matters.
- `## Tradeoffs`. State real choices only. Skip this section when there are none.
- `## Blast Radius`. State who and what the change touches. Explain why the change is safe or risky. If main is red without the fix, name the continuing cost.
- `## Verification`. State how you ran each check and its rigor. Name the real path, such as `control-cli`, `control-ui`, or the targeted tests. State the outcome of each check, not only the command name.

After these sections, attach videos or screenshots when they prove a claim. Do not use `## Summary` or `## Test plan` boilerplate. A commit body does not restate its subject.

**Size and stacks.** Prefer five narrow PRs to one large PR. A stack is a base-branch chain on GitHub. The root PR targets main. Each child branch rebases onto its parent's exact tip, and its PR targets that parent branch. Create a child with `gh pr create --base <parent-branch>`. Retarget one with `gh pr edit <pr> --base <parent-branch>`. Branch from main only for independent work.

**Readiness.** Open every PR ready, never as a draft. Omit `--draft` with `gh`, and set `draft: false` on PR API calls. If a PR still opens as a draft, run `gh pr ready <number>`. Run `gh pr view <number>` before you refer to PR status.

**Babysit.** Post the URL and keep independent work moving. At final handoff, collect current feedback under [Codex delivery flow](../references/codex-delivery-flow.md). Handle available in-scope findings and honor explicitly authorized automatic-review follow-through. Do not start a separate full babysit after every PR unless requested. Push back when feedback drifts from intent.

A subagent that opens a PR runs `$interrogate`, `$unslop`, and `$no-comments`. It returns the URL and does not babysit. Return to the main agent.
