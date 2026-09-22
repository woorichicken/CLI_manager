---
description: When changing how an external AI drives sessions (Control API), or when a local listening port looks like it contradicts decision 0001
authority: Rationale for the AI Control API's transport, access rule, and busy/idle detection
status: active
owner: maintainer
last-reviewed: 2026-09-22
---

# 0005. An AI drives sessions through an opt-in local HTTP API

## Context

The request: "open a folder, start my Claude Code template, type the task, wait" is manual work,
and `claude -p` removes the manual part only by removing the terminal — the user can no longer see
or step into what the agent does. The goal is an AI (usually another Claude Code session) that opens
sessions **inside CLI Manager**, drives them, and reads the result, while the user watches.

That needs something a local process can call. [0001](0001-hook-delivery-via-file-spool.md) chose a
file spool over HTTP for hook events, so a listening port needs a reason.

## Decision

A local HTTP server in the main process: REST under `/v1`, and MCP (Streamable HTTP, stateless,
JSON-only responses) at `/mcp` so Claude Code can use it as a tool server with one
`claude mcp add` command. Reference: [`../architecture/control-api.md`](../architecture/control-api.md).

- **Why HTTP here but not in 0001.** 0001 rejected HTTP because a hook fires in *every* agent
  session on the machine and would block on a dead server. Here the caller is an AI that explicitly
  asked to talk to the app; if the app is closed the call fails fast (connection refused), and
  nothing else on the machine is affected. MCP clients also need a transport — a spool cannot
  answer a tool call.
- **Closed by default at every layer.** Off until enabled in Settings > Agents; bound to
  `127.0.0.1`; bearer token on every request; `Host` must be `127.0.0.1`/`localhost` (DNS
  rebinding) and any foreign `Origin` is rejected (a web page cannot drive it).
- **The API reaches only sessions it opened** (`TerminalSession.aiControl`). It can list folders and
  templates, but cannot read or type into the user's own terminals. "Disconnect AI" in the sidebar
  clears the flag, which is how the user takes a session back mid-task.
- **Text is refused while the screen shows a question.** Enter on a selection dialog picks the
  highlighted option. Verified against Claude Code 2.1.278: a prompt typed into the folder-trust
  dialog selected "No, exit" and closed the agent. Keys are always allowed; `force: true` overrides.
- **Screen, not bytes.** A headless xterm (`TerminalMirror`) replays each API session's output so
  reads return the rendered screen. Busy = output in the last 1.5s, "esc to interrupt" on screen,
  or a hook reporting a running turn. Hooks alone are not enough: a template that starts the agent
  through a shell alias bypasses `--session-id` injection, so its hook events can only match by
  directory — and hooks are opt-in.
- **A started command is a child process.** Before the first prompt, the shell must have a child
  and the screen must then be quiet for 2s. Silence alone was measured wrong: this machine's zsh
  profile took over 2s to print a prompt, and a silence-only check typed the prompt ahead into the
  shell.
- **MCP is hand-rolled** (four methods). The official SDK would add an Express stack to the main
  bundle for them. Claude Code 2.1.278's HTTP MCP client was verified against it end to end.

## Consequences

- A listening port exists while the feature is on. It shows up in the Port Monitor if the user
  picks a port inside its filter range (the default 47821 is outside 3000–9000).
- The token sits in `config.json` (userData) and in `~/.climanager/control-api.json` (mode 600,
  removed on quit). Any process running as the user can read both — the same trust boundary as the
  user's shell history. Regenerate invalidates every client.
- Busy/idle and question detection read English UI strings of external CLIs. A vendor UI change
  can make `wait_for_idle` return early or miss a dialog; `integrations/CLAUDE.md` records the
  strings and the date they were checked.
- Each API session costs one extra terminal emulator in the main process. User sessions cost
  nothing.

## Reversal

- If hooks gain an exact pane identity (the Orca pane-key design in 0001's reversal), hook events
  can replace screen parsing for busy/idle — keep the screen for question detection unless hooks
  report those too.
- If a use case needs the AI to drive sessions the user opened, add an explicit per-session
  "Connect to AI" hand-off rather than widening the access rule. The screen mirror would then need
  seeding, because it only sees output from the moment it is attached.
- If the MCP surface grows past a handful of methods (resources, prompts, server-initiated
  requests), switch to the official SDK instead of extending the hand-rolled handler.
