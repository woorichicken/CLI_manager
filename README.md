<div align="center">
  <img src="resources/logo-final.png" alt="CLI Manager" width="80" />
  <h1>CLI Manager</h1>
  <p><strong>Your CLI Agents, All in One Place.</strong></p>
  <p>Claude Code, Codex CLI, Gemini CLI — manage them all from a single macOS desktop app.</p>

  [![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
  [![macOS](https://img.shields.io/badge/platform-macOS-blue.svg)](https://github.com/woorichicken/CLI_manager/releases)
  [![Open Source](https://img.shields.io/badge/open%20source-%E2%9D%A4-red.svg)](https://github.com/woorichicken/CLI_manager)
  [![GitHub release](https://img.shields.io/github/v/release/woorichicken/CLI_manager)](https://github.com/woorichicken/CLI_manager/releases/latest)

  [**Download for macOS**](https://github.com/woorichicken/CLI_manager/releases/latest) · [Website](https://solhun.com) · [Report a Bug](https://github.com/woorichicken/CLI_manager/issues)
</div>

---

## Demo

**▶ [Watch full demo on solhun.com](https://solhun.com)**

https://solhun.com/videos/various-project-main.mp4

---

## Why CLI Manager?

**Stop switching between terminals and losing context.**

As AI-powered development grows, developers are juggling Claude Code, Codex CLI, Gemini CLI — and dozens of project contexts at once. CLI Manager keeps everything organized so you can focus on building.

| | Without CLI Manager | With CLI Manager |
|---|---|---|
| **Context switching** | Re-open terminals, lose history | Instant tab switch, full state preserved |
| **Agent management** | Separate windows per tool | All agents in one sidebar |
| **Project organization** | Scattered folders | Workspaces with named sessions |
| **Git branching** | Manual worktree setup | One-click worktree workspace |

---

## Performance

- **Zero state loss** — Terminal sessions live in the DOM (`display: none`), never destroyed on tab switch
- **Instant session switching** — No re-initialization overhead; switch in milliseconds
- **Real-time port detection** — Local dev servers detected within 5 seconds via `lsof` polling
- **500ms debounced auto-save** — Session memos save automatically without blocking your workflow
- **Minimal footprint** — Built on Electron + xterm.js with no unnecessary background processes

---

## Features

### All CLI Agents, One Dashboard
Manage Claude Code, Codex CLI, and Gemini CLI from a single sidebar. Assign custom names and roles — "Frontend Dev", "Backend API", "Design Review" — so multi-agent workflows stay intuitive.

https://solhun.com/videos/changename-main.mp4

---

### Git Worktree as Independent Workspaces
Create Git worktrees directly from the UI. Each worktree becomes its own workspace with independent terminal sessions, branch tracking, and GitHub actions — no manual setup required.

https://solhun.com/videos/makeworktree.mp4

---

### GitHub Integration
Push branches, create pull requests, and check GitHub Actions workflow status — all from within the app using your existing `gh` CLI authentication.

https://solhun.com/videos/commit-push.mp4

---

### Real-Time Port Monitoring
Automatically detects running local development servers. See which ports are active across all your projects at a glance, with filtering and one-click kill.

https://solhun.com/videos/port-manager.mp4

---

### Custom Terminal Templates
Save your most-used command sequences as named templates — with icons and descriptions. Launch complex multi-step setups with a single click.

https://solhun.com/videos/templates.mp4

---

### Playground — Instant Isolated Environments
Spin up a temporary workspace in your Downloads folder with one click. Experiment freely without touching your real projects.

https://solhun.com/videos/playground.mp4

---

### Session Persistence
Every terminal session remains alive while you navigate. Switch between a dozen sessions without losing a single line of output.

### Per-Session Memo Pad
Each terminal session has its own notepad. Jot down context, commands, or notes — they auto-save and persist with the session.

### Split View
View and interact with two terminals side by side. Ideal for running a dev server while watching logs.

### Fully Configurable Shortcuts
Every action is bindable. Open the keyboard shortcut editor and make CLI Manager fit your workflow.

---

## Download

| Platform | Link |
|----------|------|
| macOS Apple Silicon (arm64) | [cli-manager-1.5.0-arm64.dmg](https://pub-dc249db286af4c1991fedf690157891d.r2.dev/cli-manager-1.5.0-arm64.dmg) |
| macOS Intel (x64) | [cli-manager-1.5.0-x64.dmg](https://pub-dc249db286af4c1991fedf690157891d.r2.dev/cli-manager-1.5.0-x64.dmg) |

Or download from [GitHub Releases](https://github.com/woorichicken/CLI_manager/releases/latest).

---

## Build from Source

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) v8+
- [Git](https://git-scm.com/)
- [gh CLI](https://cli.github.com/) *(optional — required for GitHub integration)*

### Install & Run

```bash
git clone https://github.com/woorichicken/CLI_manager.git
cd CLI_manager
pnpm install
pnpm dev
```

### Build

```bash
pnpm build        # Build for current platform
pnpm build:mac    # Build signed macOS DMG
```

### Type Check

```bash
pnpm typecheck
```

---

## Project Structure

```
src/
  main/         # Electron main process — IPC, terminal, port monitoring
  preload/      # Context bridge (main ↔ renderer)
  renderer/     # React frontend
    components/ # UI components (Sidebar, TerminalView, GitPanel, …)
    hooks/      # Custom React hooks
    utils/      # Utilities (terminalResizeManager, …)
  shared/       # Shared TypeScript types
```

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## License

MIT — see [LICENSE](./LICENSE) for details.
