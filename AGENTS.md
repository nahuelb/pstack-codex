# Local plugin release

Any push from this repository must refresh the installed local Codex plugin.

Enable the repository's tracked Git hooks once per checkout:

```bash
./scripts/install-git-hooks.sh
```

The pre-push hook rejects direct `git push` commands, verifies the final commit's plugin cachebuster, and runs the offline verification suite. Do not bypass the hook.

Before the final commit, run:

```bash
python3 /Users/nahue/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py /Users/nahue/Projects/pstack-codex
```

Include the resulting `.codex-plugin/plugin.json` change in the reviewed commit. Run the repository verification suite after updating the cachebuster.

After the required pre-push review passes, use this command instead of `git push`:

```bash
./scripts/push-and-reinstall-local-plugin.sh
```

Pass normal push arguments to the wrapper when needed. It authorizes the tracked pre-push hook for that push, then reinstalls only after a successful push. If the push succeeds but installation fails, report both outcomes clearly. Do not claim that an existing Codex task loaded the update. Test the updated plugin in a new task.

# Upstream maintenance

Keep upstream pstack skills and playbooks close to their source to reduce future refresh conflicts.
Check `upstream.lock.json` and `compatibility/pstack-map.json` before choosing which files to customize.

Prefer separate Codex-specific reference files for local execution policies, such as parallelism and scheduling.
Connect them through the existing `skills/poteto-mode/references/codex-agent-runtime.md` adapter with small, explicit references.
State when each extension applies and verify that the workflow actually loads it.
Avoid copying whole playbooks or spreading the same local guidance across upstream files.
Keep model choices in the model registry rather than duplicating them in execution policies.

Edit upstream-derived files when necessary for correctness or Codex compatibility, keeping the change small.
Explain why a separate extension cannot express the required behavior.
Local policies must preserve required verification, permission, and acceptance boundaries.

Document extension ownership in `UPSTREAM.md` and preserve local extensions during upstream refreshes.
Review semantic compatibility after refreshes, including extension loading and required gates; clean Git merges alone are insufficient.

# Codex terminology

Use the current official OpenAI documentation when changing Codex behavior, configuration, tools, or terminology. Open the relevant current page before editing. Start with the [Codex Subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents?surface=app) for subagent workflows. Prefer `learn.chatgpt.com` for ChatGPT and Codex app behavior and `developers.openai.com` for API behavior.

Use these terms for Codex subagent workflows:

- **Main thread:** The thread that delegates work and consolidates results.
- **Main agent:** The agent operating in the main thread.
- **Subagent:** A delegated agent handling a specific task.
- **Agent thread:** The thread where a subagent works and reports progress or results.
- **Built-in agent:** A Codex-provided agent such as `default`, `worker`, or `explorer`.
- **Custom agent:** A named agent configured by a standalone TOML file.

Use **spawn** or **start** for creating subagents, **wait** for collecting results, **steer** for follow-up direction, **stop** for ending active subagents, and **close** for completed agent threads. Use **Active** and **Done** only when referring to the app's status labels.

Do not use parent, child, worker thread, profile, cancellation, or terminal result as substitutes for these Codex terms. Exact tool fields, schema names, and established internal identifiers may retain their required spelling. Internal pstack terms such as **completion callback** must be defined where introduced and must not be presented as native Codex guarantees.
