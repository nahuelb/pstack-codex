# User input visibility

Apply this policy when the main agent needs a user decision, approval or required access. A pending request must remain visible while independent work continues. Ordinary CI, build or subagent waits do not require a user-input marker.

## Ask clearly and keep the decision visible

Prepare the concrete choice before asking. Use the supported input control for questions and the required approval mechanism for permission requests. State the recommendation, why input is needed, the exact effect of each choice, and which work is blocked. Reuse existing authorization; never treat silence or unrelated replies as approval.

Keep unresolved requests in the existing task context, tied to the question or approval they concern. Combine related decisions when useful. Do not create another audit ledger or ask a subagent to manage the user's decisions.

While input is pending, lead meaningful progress updates with **Needs your decision**, the outstanding choice and its blocked work. Put implementation progress afterward. Summarize results rather than relaying routine subagent activity. Resurface the existing request at milestones and when it becomes the remaining blocker; do not recreate identical question cards or add polling updates just to repeat it.

After a partial reply, resolve only the matching request. A clear answer, rejection or genuine withdrawal resolves that request; completion of unrelated work does not. State what was resolved and what still needs input. If everything remaining requires input, say the task is waiting. Resolving an approval request does not establish implementation completion.

## Mark the main task title

When the first unresolved request is presented, read the main task's actual current title through supported context or task APIs. Retain that exact original title and the title written by this agent in the existing task context. Set the title to `Needs Input: {original title}` through `set_thread_title` when available, or the supported `thread/name/set` API. In the app tool, omit `threadId` to target the calling task; otherwise use its verified ID. Subagents report blockers to the main agent and do not rename their agent threads or other tasks for this policy.

Use one prefix only. If the title already starts with `Needs Input:`, leave it unchanged unless retained history establishes ownership of that marker. The title describes pending user input even when independent implementation remains active; it is not a native Codex status flag.

Keep the marker while any request remains unresolved. Once all requests resolve, read the current title again. Restore the original only when it still equals the title this agent wrote. If the user or another actor renamed it, leave that title unchanged and stop automatic title changes for the current pending-input cycle.

Commit title ownership to task context only after the rename succeeds. Recover lost ownership information from supported task history before restoring a title; never guess or strip an unowned prefix. If a tool result is uncertain, read the title before retrying. These tools do not provide an atomic title comparison, so check immediately before a write.

If title discovery or renaming is unavailable, use the same visible request headline and state that the sidebar marker could not be applied. A title-tool failure must not swallow the question, authorize its dependent action, or block independent work. Do not edit private host stores or create a monitor to manage titles.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) documents `thread/name/set` and reading `thread.name`. Live tool availability still determines which route this task can use.
