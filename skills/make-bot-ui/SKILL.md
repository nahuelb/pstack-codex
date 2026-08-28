---
name: make-bot-ui
description: Use when building a local page or dashboard whose fixed buttons start approved Codex CLI tasks, with optional tailnet-only access.
---

# Make a Codex task UI

Build a small local page whose buttons start fixed Codex tasks on the same computer. Keep the action map on the server. Do not let the browser supply a shell command, project path, model, flag, or free-form prompt.

Codex scheduled tasks do not provide generic webhook ingress for local projects. Do not claim that a button wakes an existing desktop task. If the user needs an existing task to resume, stop and explain that this path is unsupported. Offer a scheduled task or a new bounded CLI run instead.

## Confirm the action contract

Before writing code, agree on each button's:

- stable action ID and label
- fixed project directory
- fixed prompt or prompt template with named, validated fields
- allowed external effects
- timeout and concurrency rule
- success evidence shown in the UI

Reject actions that need secrets from the browser or accept arbitrary instructions. Keep credentials in the local process environment or an approved secret store. Never place credentials in HTML, JavaScript, URLs, logs, or committed files.

## Build the local server

Serve the page from the same process that handles button requests. Bind to `127.0.0.1` by default.

For every request:

1. Require `POST` and JSON.
2. Enforce same-origin requests.
3. Match one server-owned action ID.
4. Validate every input against a narrow schema.
5. Build the prompt from server-owned text.
6. start `codex` with an argument array and no shell.
7. Record the run ID, start time, exit status, and a redacted output summary.

Use a bounded queue. Default to one active task. Reject duplicate action IDs while the same action is active. Set a timeout and terminate the child process if it expires.

The project directory must be an absolute path chosen during setup. Resolve it once and reject symlinks or paths outside the approved project roots.

## Start Codex

Check that the `codex` executable exists before enabling buttons. Use `codex exec` for a new bounded run. Keep approval, sandbox, model, and reasoning settings at their configured defaults unless the user explicitly chose different values during setup.

Do not add `--dangerously-bypass-approvals-and-sandbox`, `--full-auto`, or equivalent broad authority. Do not run a user-provided command through `sh`, `bash`, `zsh`, or another shell.

If a task needs external writes, encode the exact destination and effect in the fixed action contract. The button press authorizes only that declared action. It does not authorize new destinations or broader effects discovered during execution.

## Optional tailnet access

Keep localhost-only access unless the user asks for remote access. Prefer Tailscale Serve over binding the application to every network interface.

If Tailscale is already online, expose the localhost service only to the tailnet. Show the user the resulting tailnet URL. Do not install Tailscale or change its node configuration without explicit approval.

Do not expose the service to the public internet. Do not use an unauthenticated public tunnel. Treat tailnet membership as transport control, not as authority to add arbitrary actions.

## Verify it

Before calling the UI ready:

1. Test an unknown action ID and expect rejection.
2. Test malformed input and expect rejection.
3. Confirm concurrent duplicate requests do not start two tasks.
4. Run one harmless fixed action after the user approves the test.
5. Confirm the UI reports the child exit status without exposing the full prompt or secrets.
6. Confirm the repository contains no credentials or generated run logs.

Stop if the host lacks the Codex CLI, the project path cannot be fixed safely, or the requested action requires unsupported webhook delivery.
