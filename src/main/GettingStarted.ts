/**
 * Getting started checklist (main side) and the "is claude / codex installed" hint for the
 * built-in templates. The rules live in `shared/gettingStarted.ts`; this file reads the app's
 * real state and keeps the latched result in its own store key (`gettingStarted`) — not inside
 * `settings`, which the welcome screen and the Settings window write back whole from their copy.
 */
import { spawn } from 'child_process'
import {
    beginGettingStarted,
    gettingStartedVisible,
    isProjectFolder,
    latchGettingStarted,
    readGettingStartedState,
    type AgentCli,
    type AgentCliStatus,
    type AgentCliStatuses,
    type GettingStartedState,
    type GettingStartedStep
} from '../shared/gettingStarted'
import type { Workspace } from '../shared/types'

export interface GettingStartedDeps {
    load(): unknown
    save(state: GettingStartedState): void
    workspaces(): Workspace[]
    /** sessions whose terminal runs Claude Code or Codex in the foreground; null when unknown */
    foregroundAgents(): Promise<Map<string, AgentCli> | null>
    /**
     * Whether an agent was started anywhere (a session the app tied to claude/codex when its command
     * was entered). Until then the process list is not read: one `ps` of every process is ~0.15 s.
     */
    agentStarted(): boolean
    /** whether a session's linked conversation has a message from the person; undefined when unknown */
    hasConversation(sessionId: string): boolean | undefined
    now?(): number
}

export class GettingStarted {
    constructor(private readonly deps: GettingStartedDeps) {}

    get(): GettingStartedState | null {
        return readGettingStartedState(this.deps.load())
    }

    /**
     * The welcome screen was accepted: show the card (again), keeping steps already done — and
     * look at once, so a replay does not draw a card the first check then takes away.
     */
    async begin(): Promise<GettingStartedState | null> {
        this.deps.save(beginGettingStarted(this.get(), this.deps.now?.() ?? Date.now()))
        return this.check()
    }

    dismiss(): GettingStartedState | null {
        const state = this.get()
        if (!state || state.dismissed) return state
        const next = { ...state, dismissed: true }
        this.deps.save(next)
        return next
    }

    /**
     * Looks at the app as it is now and latches what it finds. Does nothing while the card is not
     * shown, and skips a step already done — so a finished or closed checklist costs no `ps` and no read.
     */
    async check(): Promise<GettingStartedState | null> {
        const state = this.get()
        if (!gettingStartedVisible(state)) return state
        const workspaces = this.deps.workspaces()
        const seen: Partial<Record<GettingStartedStep, boolean>> = {}
        if (!state.done.folder) seen.folder = workspaces.some(isProjectFolder)
        if (!state.done.chat) {
            seen.chat = workspaces.some((workspace) => (workspace.sessions ?? []).some((session) =>
                !!session.cliSessionId && this.deps.hasConversation(session.id) === true))
        }
        if (!state.done.agent) {
            // a conversation with a first message is proof the agent ran, even if it has since exited
            if (seen.chat) seen.agent = true
            else if (this.deps.agentStarted()) {
                const running = await this.deps.foregroundAgents()
                seen.agent = !!running && running.size > 0
            }
        }
        const next = latchGettingStarted(state, seen)
        if (next !== state) this.deps.save(next)
        return next
    }
}

export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<string>

const CLI_CHECK_TIMEOUT_MS = 6_000
const CLI_CACHE_MS = 60_000

const OUTPUT_LIMIT = 64 * 1024

// stdin is closed: an rc file that reads input (a prompt, `read`) gets EOF instead of waiting for the kill
const runShell: ShellRunner = (shell, args, timeoutMs) => new Promise((resolve, reject) => {
    const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('shell check timed out'))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { if (out.length < OUTPUT_LIMIT) out += chunk.toString() })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', () => { clearTimeout(timer); resolve(out) })
})

/** The marker line keeps whatever a profile prints (banners, `instant prompt`) out of the answer. */
const PROBE = (name: AgentCli): string => `command -v ${name} >/dev/null 2>&1 && echo CLIM_FOUND_${name} || echo CLIM_MISSING_${name}`

function parseProbe(output: string, names: AgentCli[]): Partial<AgentCliStatuses> {
    const result: Partial<AgentCliStatuses> = {}
    for (const name of names) {
        if (output.includes(`CLIM_FOUND_${name}`)) result[name] = 'installed'
        else if (output.includes(`CLIM_MISSING_${name}`)) result[name] = 'missing'
    }
    return result
}

/**
 * Whether `claude` and `codex` can be started from a terminal in this app. A non-interactive
 * login shell skips `.zshrc`, where PATH for these tools is often set, while the app's terminals
 * are interactive — so a "missing" from the login shell is asked again in an interactive one
 * before it counts. A check that times out or fails stays 'unknown' (drawn as normal, never dim).
 */
export async function checkAgentClis(shell: string, run: ShellRunner = runShell): Promise<AgentCliStatuses> {
    const names: AgentCli[] = ['claude', 'codex']
    const statuses: AgentCliStatuses = { claude: 'unknown', codex: 'unknown' }
    const script = names.map(PROBE).join('; ')
    try {
        Object.assign(statuses, parseProbe(await run(shell, ['-l', '-c', script], CLI_CHECK_TIMEOUT_MS), names))
    } catch { /* stays unknown */ }
    const recheck = names.filter((name) => statuses[name] !== 'installed')
    if (recheck.length > 0) {
        try {
            const second = parseProbe(await run(shell, ['-i', '-l', '-c', recheck.map(PROBE).join('; ')], CLI_CHECK_TIMEOUT_MS), recheck)
            for (const name of recheck) {
                const found = second[name]
                // missing only when both shells said so; an interactive shell that failed leaves it unknown
                statuses[name] = found === 'installed' ? 'installed' : found === 'missing' && statuses[name] === 'missing' ? 'missing' : 'unknown'
            }
        } catch {
            for (const name of recheck) statuses[name] = 'unknown'
        }
    }
    return statuses
}

/** `claude=missing,codex=installed` — the test-mode stand-in for the shell check. */
export function parseAgentCliFake(value: string): AgentCliStatuses {
    const statuses: AgentCliStatuses = { claude: 'unknown', codex: 'unknown' }
    for (const pair of value.split(',')) {
        const [name, status] = pair.split('=').map((part) => part.trim())
        if ((name === 'claude' || name === 'codex') && (status === 'installed' || status === 'missing' || status === 'unknown')) {
            statuses[name] = status as AgentCliStatus
        }
    }
    return statuses
}

/** One check at a time, remembered for a minute — the "+" menu asks each time it opens. */
export class AgentCliChecker {
    private cached: { at: number; value: AgentCliStatuses } | null = null
    private pending: Promise<AgentCliStatuses> | null = null

    constructor(private readonly check: () => Promise<AgentCliStatuses>, private readonly now: () => number = Date.now) {}

    get(): Promise<AgentCliStatuses> {
        if (this.cached && this.now() - this.cached.at < CLI_CACHE_MS) return Promise.resolve(this.cached.value)
        if (!this.pending) {
            this.pending = this.check()
                .then((value) => {
                    this.cached = { at: this.now(), value }
                    return value
                })
                .catch(() => ({ claude: 'unknown', codex: 'unknown' }) as AgentCliStatuses)
                .finally(() => { this.pending = null })
        }
        return this.pending
    }
}
