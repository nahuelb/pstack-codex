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
