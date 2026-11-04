// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/skills/claude.ts and server/skills/codex.ts — the command tables (names, descriptions, which
// ones only the terminal can show). The discovery is rewritten small: SKILL.md and command files in the
// usual folders and enabled Claude plugins, without ovis's skillOverrides, managed settings, synced skills,
// name folding or walk budget. Claude Code pinned at 2.1.301, codex-rs at rust-v0.163.0, as ovis has them.
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { ChatCommand, ConversationAgent } from '../shared/conversation'

const CLAUDE_REFERENCE: readonly string[] = [
    'add-dir', 'advisor', 'agents', 'artifacts', 'auto-mode-setup', 'autocompact', 'autofix-pr', 'background', 'batch', 'branch',
    'btw', 'bug', 'cd', 'chrome', 'clear', 'code-review', 'color', 'compact', 'config', 'context', 'copy', 'cost', 'debug', 'desktop',
    'diff', 'doctor', 'effort', 'exit', 'export', 'fast', 'feedback', 'fewer-permission-prompts', 'focus', 'fork', 'goal', 'help', 'hooks',
    'ide', 'import', 'init', 'insights', 'install-github-app', 'install-slack-app', 'keybindings', 'list-agents', 'login', 'logout', 'loop',
    'mcp', 'memory', 'mobile', 'model', 'output-style', 'passes', 'permissions', 'plan', 'plugin', 'powerup', 'privacy-settings',
    'rate-limit-options', 'recap', 'release-notes', 'reload-plugins', 'reload-skills', 'remote-control', 'remote-env', 'rename', 'resume',
    'review', 'rewind', 'run', 'sandbox', 'schedule', 'scroll-speed', 'security-review', 'simplify', 'skill-doctor', 'skills', 'stats',
    'status', 'statusline', 'stop', 'subtask', 'tasks', 'teleport', 'terminal-setup', 'theme', 'tui', 'ultrareview', 'update-config',
    'upgrade', 'usage', 'usage-credits', 'verify', 'voice', 'web-setup', 'workflows'
]

/** Sent bare in an isolated 2.1.306 session, these left a panel, picker, form or prompt on screen until Esc (ovis). */
const CLAUDE_TERMINAL: ReadonlySet<string> = new Set([
    'config', 'hooks', 'permissions', 'plugin', 'resume', 'skills', 'theme', 'cost', 'usage', 'stats', 'status', 'help', 'memory', 'sandbox',
    'tasks', 'workflows', 'powerup', 'scroll-speed', 'mobile', 'passes', 'add-dir', 'cd', 'mcp', 'artifacts', 'auto-mode-setup',
    'autofix-pr', 'bug', 'chrome', 'desktop', 'feedback', 'import', 'install-github-app', 'install-slack-app', 'login', 'logout',
    'privacy-settings', 'rate-limit-options', 'remote-control', 'remote-env', 'skill-doctor', 'teleport', 'terminal-setup', 'ultrareview',
    'upgrade', 'usage-credits', 'web-setup', 'diff', 'ide', 'copy', 'voice', 'keybindings'
])
/** Bare, these open a picker or dialog; given a value they set it and return (ovis `forms`). */
const CLAUDE_TERMINAL_BARE: ReadonlySet<string> = new Set(['model', 'effort', 'goal', 'btw', 'rewind', 'fast', 'autocompact', 'advisor', 'export'])

const CLAUDE_DESCRIPTIONS: Record<string, string> = {
    'add-dir': 'Add a new working directory', advisor: 'Let Claude consult a stronger model', agents: 'Print a reminder to ask Claude to manage subagents',
    artifacts: 'Browse published and shared artifacts', 'auto-mode-setup': 'Teach auto mode about your environment',
    autocompact: 'Set how full context gets before summarizing', 'autofix-pr': 'Monitor and autofix issues with the current pull request',
    background: 'Send this session to the background', batch: 'Orchestrate large-scale changes across a codebase in parallel',
    branch: 'Branch the current conversation', btw: 'Ask a side question without interrupting the current work',
    bug: 'Report a bug or share your conversation', cd: 'Move this session to a new working directory', chrome: 'Open Claude in Chrome settings',
    clear: 'Clear the conversation and start fresh', 'code-review': 'Review the current diff or a pull request for bugs',
    color: 'Set the prompt bar color', compact: 'Summarize the conversation to free context', config: 'Open the Settings interface',
    context: 'Show current context usage', copy: 'Copy a response to the clipboard', cost: 'Alias of /usage',
    debug: 'Enable debug logging and troubleshoot issues', desktop: 'Continue the session in the Claude Code Desktop app',
    diff: 'Show the uncommitted changes', doctor: 'Health-check your Claude Code setup and fix issues', effort: 'Set the reasoning effort',
    exit: 'Exit Claude Code', export: 'Export the conversation to a file or clipboard', fast: 'Toggle fast mode',
    feedback: 'Send feedback or report a bug', 'fewer-permission-prompts': 'Add an allowlist for common read-only commands',
    focus: 'Toggle the focused conversation view', fork: 'Copy this conversation into a background session',
    goal: 'Set or view a goal Claude keeps working toward', help: 'Show help', hooks: 'View hook configurations', ide: 'Manage IDE integrations',
    import: 'Import configuration from another coding agent', init: 'Initialize a new CLAUDE.md file with codebase documentation',
    insights: 'Generate a report analyzing your Claude Code sessions', 'install-github-app': 'Set up Claude GitHub Actions',
    'install-slack-app': 'Install the Claude Slack app', keybindings: 'Open keyboard shortcuts',
    'list-agents': 'List subagents, teammates and other sessions', login: 'Sign in', logout: 'Sign out',
    loop: 'Run a prompt repeatedly while the session stays open', mcp: 'Manage MCP servers', memory: 'Edit memory files',
    mobile: 'Show a QR code for the mobile app', model: 'Set the AI model', 'output-style': 'List or switch output styles',
    passes: 'Share a free week of Claude Code', permissions: 'Manage allow, ask and deny rules', plan: 'Enable plan mode or view the session plan',
    plugin: 'Manage Claude Code plugins', powerup: 'Discover Claude Code features through interactive lessons',
    'privacy-settings': 'View and update privacy settings', 'rate-limit-options': 'Manage usage limits and upgrade options',
    recap: 'Generate a one-line session recap', 'release-notes': 'Show the release notes', 'reload-plugins': 'Activate pending plugin changes',
    'reload-skills': 'Reload skills added or changed on disk', 'remote-control': 'Control this session from your phone or browser',
    'remote-env': 'Choose the default cloud environment', rename: 'Rename the current conversation', resume: 'Resume a conversation by ID or name',
    review: 'Alias of /code-review', rewind: 'Restore code or conversation to an earlier point', run: 'Launch and drive your app to see a change working',
    sandbox: 'Configure sandboxing', schedule: 'Create, update, list or run routines', 'scroll-speed': 'Adjust mouse wheel scroll speed',
    'security-review': 'Complete a security review of the pending changes', simplify: 'Review changed code for cleanup and apply fixes',
    'skill-doctor': 'Show unused skills that cost context', skills: 'List available skills', stats: 'Alias of /usage, opened on the Stats tab',
    status: 'Show version, model, account and connectivity', statusline: "Set up Claude Code's status line UI",
    stop: 'Stop the background session you are attached to', subtask: 'Send a subagent off with the full context',
    tasks: 'View and manage background work', teleport: 'Send this session to the cloud or resume a cloud session',
    'terminal-setup': 'Set up the terminal for Shift+Enter', theme: 'Change the color theme', tui: 'Set the terminal UI renderer',
    ultrareview: 'Start a cloud agent that finds and verifies bugs', 'update-config': 'Describe a settings change and Claude edits settings.json',
    upgrade: 'Upgrade your plan', usage: 'Show session cost, plan usage and activity', 'usage-credits': 'Configure or request usage credits',
    verify: 'Confirm a code change works by running your app', voice: 'Toggle voice mode', 'web-setup': 'Set up cloud sessions with GitHub',
    workflows: 'Browse workflows'
}

const CODEX_BUILTINS: readonly string[] = [
    'model', 'ide', 'permissions', 'keymap', 'vim', 'experimental', 'approve', 'memories', 'skills', 'import', 'hooks', 'review', 'rename',
    'new', 'archive', 'delete', 'resume', 'fork', 'worktree', 'init', 'compact', 'config', 'recap', 'plan', 'voice', 'goal', 'agents', 'side',
    'btw', 'copy', 'export', 'raw', 'tui', 'diff', 'mention', 'status', 'warnings', 'cd', 'pwd', 'usage', 'title', 'statusline', 'theme',
    'mcp', 'plugins', 'logout', 'quit', 'exit', 'feedback', 'ps', 'stop', 'clear', 'subagents'
]
const CODEX_TERMINAL: ReadonlySet<string> = new Set([
    'resume', 'permissions', 'agents', 'hooks', 'mcp', 'plugins', 'skills', 'voice', 'theme', 'config', 'keymap', 'experimental', 'approve',
    'memories', 'import', 'new', 'archive', 'delete', 'fork', 'worktree', 'side', 'btw', 'copy', 'tui', 'mention', 'warnings', 'cd', 'usage',
    'title', 'statusline', 'feedback', 'subagents', 'vim', 'logout', 'status', 'diff', 'pwd', 'ps'
])
const CODEX_TERMINAL_BARE: ReadonlySet<string> = new Set(['model', 'review', 'rename', 'export'])
const CODEX_DESCRIPTIONS: Record<string, string> = {
    model: 'Choose what model and reasoning effort to use', config: 'Configure Codex preferences', btw: 'Start a side conversation in an ephemeral fork',
    quit: 'Exit Codex', ide: 'Include current selection, open files, and other context from your IDE', keymap: 'Remap TUI shortcuts',
    vim: 'Toggle Vim mode for the composer', experimental: 'Toggle experimental features', approve: 'Approve one retry of a recent auto-review denial',
    memories: 'Configure memory use and generation', import: 'Import setup, this project, and recent chats from Claude Code',
    review: 'Review my current changes and find issues', rename: 'Rename the current thread', new: 'Start a new chat during a conversation',
    archive: 'Archive this session', delete: 'Permanently delete this session', fork: 'Fork the current chat',
    worktree: 'Start or continue a conversation in a new worktree', init: 'Create an AGENTS.md file with instructions for Codex',
    compact: 'Summarize conversation to prevent hitting the context limit', recap: 'Summarize the current conversation now', plan: 'Switch to Plan mode',
    goal: 'Set or view the goal for a long-running task', side: 'Start a side conversation in an ephemeral fork', copy: 'Copy the last response or part of it',
    export: 'Export the conversation as markdown', raw: 'Toggle raw scrollback mode for copy-friendly terminal selection',
    tui: 'Choose the TUI mode for the next launch', diff: 'Show git diff (including untracked files)', mention: 'Mention a file',
    status: 'Show current session configuration and token usage', warnings: 'View retained warnings and diagnostic details',
    cd: 'Change the current working directory', pwd: 'Show the current working directory', usage: 'View account usage or use a usage limit reset',
    title: 'Configure which items appear in the terminal title', statusline: 'Configure which items appear in the status line',
    logout: 'Log out of Codex', exit: 'Exit Codex', feedback: 'Send logs to maintainers', ps: 'List background terminals',
    stop: 'Stop all background terminals', clear: 'Clear the terminal and start a new chat', subagents: "Switch between this session's subagents",
    resume: 'Resume a saved chat', permissions: 'Choose what Codex is allowed to do', agents: 'Open the agent command center',
    hooks: 'View and manage lifecycle hooks', mcp: 'List MCP tools', plugins: 'Browse plugins', skills: 'Use skills to improve how Codex performs specific tasks',
    voice: 'Start or stop voice', theme: 'Choose a syntax highlighting theme'
}

/** A SKILL.md or command file's frontmatter is read up to this much. */
const MAX_HEAD_BYTES = 16 * 1024
/** Folders looked into per discovery, so a huge skills tree cannot stall main. */
const MAX_FOLDERS = 600
/** One list per agent and folder for this long. */
const CACHE_MS = 30_000

/**
 * The first MAX_HEAD_BYTES of a regular file, or null. A project can hold a FIFO (a plain open waits
 * for a writer forever) or a link to /dev/zero (a read that never ends) named SKILL.md: main must not
 * stop on either. The path is checked, then opened non-blocking (a regular file ignores the flag) and
 * the descriptor checked again, so a FIFO swapped in between is refused too. Only the head is read —
 * a huge skill file is never loaded whole. From ovis server/skills/walk.ts:68-83 (openRegular).
 */
function readHead(path: string): string | null {
    let fd: number | null = null
    try {
        if (!statSync(path).isFile()) return null
        fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0))
        if (!fstatSync(fd).isFile()) return null
        const buffer = Buffer.alloc(MAX_HEAD_BYTES)
        let length = 0
        for (let count = 1; count > 0 && length < buffer.length; length += count) count = readSync(fd, buffer, length, buffer.length - length, null)
        return buffer.subarray(0, length).toString('utf8')
    } catch {
        return null
    } finally {
        if (fd !== null) closeSync(fd)
    }
}

/** The file's frontmatter fields; null when it is no regular file (it is then not listed at all). */
function frontmatter(path: string): Record<string, string> | null {
    const text = readHead(path)
    if (text === null) return null
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    const fields: Record<string, string> = {}
    if (!match) return fields
    let key: string | null = null
    for (const line of match[1].split(/\r?\n/)) {
        const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
        if (pair) {
            key = pair[1]
            fields[key] = pair[2].replace(/^["'>|]\s*|["']$/g, '').trim()
        } else if (key && /^\s+\S/.test(line)) {
            fields[key] = `${fields[key]} ${line.trim()}`.trim()
        }
    }
    return fields
}

const isOff = (value: string | undefined): boolean => value !== undefined && ['false', 'no', 'off', '0'].includes(value.trim().toLowerCase())

interface Budget {
    folders: number
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory()
    } catch {
        return false
    }
}

/** `<root>/<name>/SKILL.md` (Claude: one level; Codex: down to `depth`). */
function skillsIn(root: string, budget: Budget, depth = 1): { name: string; description: string }[] {
    const found: { name: string; description: string }[] = []
    const visit = (directory: string, level: number): void => {
        if (budget.folders <= 0 || !isDirectory(directory)) return
        budget.folders -= 1
        const file = join(directory, 'SKILL.md')
        if (level > 0 && existsSync(file)) {
            const fields = frontmatter(file)
            if (fields && !isOff(fields['user-invocable'])) found.push({ name: fields.name || basename(directory), description: fields.description ?? '' })
            // A skill folder holds its scripts/references, not more skills — walking them spent the folder budget, so a
            // 300-skill ~/.codex/skills listed only about half (new-worktree, park-finding missing)
            return
        }
        if (level >= depth) return
        let entries: string[]
        try {
            entries = readdirSync(directory)
        } catch {
            return
        }
        for (const entry of entries) if (!entry.startsWith('.') && entry.toLowerCase() !== 'synced') visit(join(directory, entry), level + 1)
    }
    visit(root, 0)
    return found
}

/** Command files: `<root>/a/b.md` is `/a:b`. */
function commandsIn(root: string, budget: Budget): { name: string; description: string }[] {
    const found: { name: string; description: string }[] = []
    const visit = (directory: string, prefix: string[]): void => {
        if (budget.folders <= 0 || !isDirectory(directory)) return
        budget.folders -= 1
        let entries: string[]
        try {
            entries = readdirSync(directory)
        } catch {
            return
        }
        for (const entry of entries) {
            if (entry.startsWith('.')) continue
            const path = join(directory, entry)
            if (entry.endsWith('.md') && !isDirectory(path)) {
                const fields = frontmatter(path)
                if (fields && !isOff(fields['user-invocable'])) found.push({ name: [...prefix, entry.slice(0, -3)].join(':'), description: fields.description ?? '' })
            } else if (prefix.length < 3) {
                visit(path, [...prefix, entry])
            }
        }
    }
    visit(root, [])
    return found
}

/** The folder and its parents up to the repository root (the folder holding `.git`), nearest first; the folder alone outside one. */
function ancestorsToRepoRoot(cwd: string, home: string): string[] {
    const chain: string[] = []
    let current = cwd
    for (let i = 0; i < 20; i++) {
        chain.push(current)
        if (existsSync(join(current, '.git'))) return chain
        const parent = dirname(current)
        if (parent === current || current === home) break
        current = parent
    }
    return [cwd]
}

function readJson(path: string): Record<string, unknown> | null {
    try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
    } catch {
        return null
    }
}

/** Skills and commands of the Claude plugins switched on in settings.json, as `/<plugin>:<name>`. */
function claudePluginCommands(config: string, budget: Budget): ChatCommand[] {
    const enabled = (readJson(join(config, 'settings.json'))?.enabledPlugins ?? {}) as Record<string, unknown>
    const installed = (readJson(join(config, 'plugins', 'installed_plugins.json'))?.plugins ?? {}) as Record<string, Array<{ installPath?: unknown }>>
    const result: ChatCommand[] = []
    for (const [id, on] of Object.entries(enabled)) {
        if (on !== true) continue
        const installPath = installed[id]?.[0]?.installPath
        if (typeof installPath !== 'string') continue
        const plugin = id.split('@')[0]
        for (const skill of skillsIn(join(installPath, 'skills'), budget)) result.push({ name: `${plugin}:${skill.name}`, description: skill.description, source: 'skill' })
        for (const command of commandsIn(join(installPath, 'commands'), budget)) result.push({ name: `${plugin}:${command.name}`, description: command.description, source: 'command' })
    }
    return result
}

export interface ChatCommandDirs {
    home: string
    claudeConfigDir: () => string
    codexHome: () => string
}

/**
 * The `/` commands (and Codex `$` skills) an agent offers in a folder: its built-ins, then personal
 * and project skills and command files. `terminal` marks the ones whose screen only the terminal can
 * show — the chat switches to the terminal after sending one.
 */
export function createChatCommandLister(dirs: ChatCommandDirs): (agent: ConversationAgent, cwd: string | undefined) => ChatCommand[] {
    const cache = new Map<string, { at: number; commands: ChatCommand[] }>()
    return (agent, cwd) => {
        const key = `${agent}\0${cwd ?? ''}`
        const hit = cache.get(key)
        if (hit && Date.now() - hit.at < CACHE_MS) return hit.commands
        const budget: Budget = { folders: MAX_FOLDERS }
        const ancestors = cwd ? ancestorsToRepoRoot(cwd, dirs.home) : []
        const all: ChatCommand[] = []
        if (agent === 'claude') {
            const config = dirs.claudeConfigDir()
            for (const skill of skillsIn(join(config, 'skills'), budget)) all.push({ name: skill.name, description: skill.description, source: 'skill' })
            for (const directory of ancestors) {
                for (const skill of skillsIn(join(directory, '.claude', 'skills'), budget)) all.push({ name: skill.name, description: skill.description, source: 'project' })
            }
            for (const command of commandsIn(join(config, 'commands'), budget)) all.push({ name: command.name, description: command.description, source: 'command' })
            for (const directory of ancestors) {
                for (const command of commandsIn(join(directory, '.claude', 'commands'), budget)) all.push({ name: command.name, description: command.description, source: 'project' })
            }
            all.push(...claudePluginCommands(config, budget))
            for (const name of CLAUDE_REFERENCE) {
                all.push({
                    name,
                    description: CLAUDE_DESCRIPTIONS[name] ?? `Run /${name}`,
                    source: 'builtin',
                    ...(CLAUDE_TERMINAL.has(name) ? { terminal: 'always' as const } : CLAUDE_TERMINAL_BARE.has(name) ? { terminal: 'bare' as const } : {})
                })
            }
        } else {
            const codexHome = dirs.codexHome()
            for (const name of CODEX_BUILTINS) {
                all.push({
                    name,
                    description: CODEX_DESCRIPTIONS[name] ?? `Run /${name}`,
                    source: 'builtin',
                    ...(CODEX_TERMINAL.has(name) ? { terminal: 'always' as const } : CODEX_TERMINAL_BARE.has(name) ? { terminal: 'bare' as const } : {})
                })
            }
            // Codex runs a skill by `$name` (ovis guide.md:313)
            const roots = [...ancestors.map((directory) => join(directory, '.codex', 'skills')), join(codexHome, 'skills'), join(dirs.home, '.agents', 'skills')]
            for (const root of roots) {
                for (const skill of skillsIn(root, budget, 6)) {
                    if (skill.description) all.push({ name: skill.name, description: skill.description, source: 'skill', trigger: '$' })
                }
            }
        }
        // the first of a name wins: a skill replaces a built-in of the same name
        const seen = new Set<string>()
        const commands = all.filter((command) => {
            const key = `${command.trigger ?? '/'}${command.name}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
        })
        cache.set(key, { at: Date.now(), commands })
        return commands
    }
}
