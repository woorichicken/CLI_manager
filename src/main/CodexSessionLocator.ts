import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

/**
 * Finds the conversation id of a Codex session so a restart can
 * `codex … resume <id>` instead of starting over.
 *
 * Claude Code takes `--session-id` from us; Codex has no such flag. It names
 * the conversation itself and records it in a rollout file under
 * $CODEX_HOME/sessions/YYYY/MM/DD/ whose first line is a `session_meta`
 * record with the id, the working directory and the start time (checked
 * against codex-cli 0.155.1, 2026-10-01). So after a terminal starts Codex, we
 * look for a new rollout whose directory matches that terminal's.
 */

/** Codex subcommands that are not an interactive conversation to resume later. */
const NON_INTERACTIVE = new Set([
    'exec', 'e', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox', 'debug',
    'apply', 'a', 'cloud', 'features', 'resume', 'fork', 'help', '-h', '--help', '-V', '--version'
])
/** Codex flags that take the next token as their value. */
const FLAGS_WITH_VALUE = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--enable', '--disable', '--add-dir', '--remote', '--remote-auth-token-env', '--local-provider'])

/** Rollouts can be written a little before our clock reading of "started". */
const START_SLACK_MS = 2_000
const START_WINDOW_MS = 30_000
const AMBIGUITY_MS = 10_000
const POLL_MS = 10_000
/** Unconfirmed launches have a bounded discovery window; confirmed PIDs are watched until exit. */
const WATCH_MS = 15 * 60 * 1000
/** session_meta is the first line; it is long (it carries instructions) but its fields come first. */
const HEAD_BYTES = 8 * 1024

/**
 * True when `tokens` (an already alias-expanded command line) starts an
 * interactive Codex conversation.
 */
export function isInteractiveCodex(tokens: string[]): boolean {
    const name = (tokens[0] ?? '').split('/').pop()
    if (name !== 'codex') return false
    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i]
        if (FLAGS_WITH_VALUE.has(token)) {
            i++
            continue
        }
        if (token.startsWith('-')) {
            if (NON_INTERACTIVE.has(token)) return false
            continue
        }
        // The first bare word is either a subcommand or the opening prompt.
        return !NON_INTERACTIVE.has(token)
    }
    return true
}

/** An explicit UUID resume is a candidate; the caller must verify the actual foreground agent. */
export function parseCodexResume(tokens: string[]): { id: string; baseCommand: string } | null {
    const parsed = parseCodexResumePosition(tokens)
    return parsed ? { id: parsed.id, baseCommand: parsed.baseCommand } : null
}

export function parseCodexResumePosition(tokens: string[]): { id: string; baseCommand: string; resumeIndex: number } | null {
    const executable = agentExecutable(tokens)
    if (executable?.kind !== 'codex') return null
    for (let i = executable.index + 1; i < tokens.length; i++) {
        const token = tokens[i]
        if (FLAGS_WITH_VALUE.has(token)) { if (tokens[i + 1] === undefined) return null; i++; continue }
        if (token.startsWith('-')) continue
        if (token !== 'resume' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(tokens[i + 1] ?? '')) return null
        // A second positional word is a new prompt. Do not save it as part of the command to replay.
        for (let j = i + 2; j < tokens.length; j++) {
            if (FLAGS_WITH_VALUE.has(tokens[j])) { if (tokens[j + 1] === undefined) return null; j++; continue }
            if (!tokens[j].startsWith('-')) return null
        }
        return { id: tokens[i + 1], baseCommand: [...tokens.slice(0, i), ...tokens.slice(i + 2)].join(' '), resumeIndex: i }
    }
    return null
}

export interface CodexProcess { pid: number; startedAt: number }
export interface CodexLocatorDependencies {
    findProcess?: (shellPid: number) => Promise<CodexProcess | null>
    heldRollouts?: (pid: number) => Promise<string[] | null>
    isClaimed?: (id: string) => boolean
    isAlive?: (pid: number) => boolean
    now?: () => number
    pollMs?: number
}

const execFileAsync = promisify(execFile)

export type AgentCommandRunner = (file: string, args: string[], options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>
const runAgentCommand: AgentCommandRunner = async (file, args, options) => {
    const result = await execFileAsync(file, args, { ...options, encoding: 'utf8' })
    return { stdout: result.stdout }
}

export interface AgentProcess {
    pid: number
    ppid: number
    pgid: number
    tpgid: number
    startedAt: number
    command: string
    argv: string
}

/** Parse the C-locale ps columns; a failed or empty snapshot is unknown, never "no agent". */
export function parseAgentProcesses(stdout: string): AgentProcess[] | null {
    const rows = stdout.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(.{24})\s+(.+)$/.exec(line)
        if (!match || !Number.isFinite(Date.parse(match[5]))) return []
        return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tpgid: Number(match[4]), startedAt: Date.parse(match[5]), command: match[6].trim().split(/\s+/)[0], argv: match[6].trim() }]
    })
    return rows.length ? rows : null
}

export async function readAgentProcesses(run: AgentCommandRunner = runAgentCommand): Promise<AgentProcess[] | null> {
    try {
        const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,lstart=,args='], { timeout: 2_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
        return parseAgentProcesses(stdout)
    } catch { return null }
}

/** Only the executable or a known Node launcher identifies an agent; arguments do not. */
export function classifyAgentProcess(row: AgentProcess): 'codex' | 'claude' | null {
    return agentExecutable(row.argv.trim().split(/\s+/), row.command)?.kind ?? null
}

/** Process classification and resume verification must accept the same executable spellings. */
function agentExecutable(tokens: string[], command = tokens[0] ?? ''): { kind: 'codex' | 'claude'; index: number } | null {
    const executable = basename(command).replace(/^-/, '')
    if (/^codex(?:-(?:aarch64|x86_64|arm64)[\w-]*)?$/.test(executable)) return { kind: 'codex', index: 0 }
    if (executable === 'claude') return { kind: 'claude', index: 0 }
    if (!/^(node|nodejs)$/.test(executable)) return null
    for (let index = 1; index < tokens.length; index++) {
        const script = tokens[index]
        if (/^(?:-[epcr]|--(?:eval|print|check|require|import)(?:=|$))/.test(script)) return null
        if (script.startsWith('-')) continue
        if (/^(codex|codex\.js)$/.test(basename(script))) return { kind: 'codex', index }
        if (/^(claude|claude\.js)$/.test(basename(script)) || /[/]@anthropic-ai[/]claude-code[/]cli\.js$/.test(script)) return { kind: 'claude', index }
        return null
    }
    return null
}

/** The native agent child wins over its npm wrapper in the pty's foreground group. */
export function selectForegroundAgentProcess(rows: AgentProcess[], shellPid: number): AgentProcess | null {
    const shell = rows.find((row) => row.pid === shellPid)
    if (!shell || shell.tpgid <= 0) return null
    const group = rows.filter((row) => row.pgid === shell.tpgid)
    return group.find((row) => classifyAgentProcess(row) && !/^(node|nodejs)$/.test(basename(row.command)))
        ?? group.find((row) => classifyAgentProcess(row))
        ?? group.find((row) => row.pid === shell.tpgid)
        ?? null
}

export async function findCodexProcess(shellPid: number, run: AgentCommandRunner = runAgentCommand): Promise<CodexProcess | null> {
    const rows = await readAgentProcesses(run)
    const current = rows && selectForegroundAgentProcess(rows, shellPid)
    return current && classifyAgentProcess(current) === 'codex' ? { pid: current.pid, startedAt: current.startedAt } : null
}

export function parseHeldCodexRollouts(stdout: string): string[] {
    return stdout.split('\n').filter((line) => line.startsWith('n/') && line.endsWith('.jsonl')).map((line) => line.slice(1))
}

export async function heldCodexRollouts(pid: number, run: AgentCommandRunner = runAgentCommand): Promise<string[] | null> {
    try {
        const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-p', String(pid), '-Fn'], { timeout: 2_000, maxBuffer: 2 * 1024 * 1024 })
        return parseHeldCodexRollouts(stdout)
    } catch { return null }
}

export interface RolloutMeta { id: string; cwd: string; startedAt: number; file: string }

export function readCodexRolloutMeta(file: string): RolloutMeta | null {
    return readMeta(file) ?? null
}

/** Metadata-only filtering can run before the bounded transcript parser reads the first message. */
export function parseCodexRolloutHead(head: string, file = ''): RolloutMeta | null {
    try {
        if (!/"type"\s*:\s*"session_meta"/.test(head)) return null
        const id = /"id"\s*:\s*"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"/i.exec(head)?.[1]
        const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
        const timestamp = /"payload"\s*:\s*\{[^}]*?"timestamp"\s*:\s*"([^"]+)"/.exec(head)?.[1]
        const source = /"source"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}]+)/.exec(head)?.[1]
        const originator = /"originator"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
        if (source !== undefined && source !== '"cli"' && source !== '"vscode"') return null
        if (originator && originator !== 'codex-tui') return null
        if (!id || !cwd || !timestamp || !Number.isFinite(Date.parse(timestamp))) return null
        return { id, cwd: canonical(JSON.parse(`"${cwd}"`)), startedAt: Date.parse(timestamp), file }
    } catch { return null }
}

function readMeta(file: string): RolloutMeta | null | undefined {
    let fd: number | undefined
    try {
        fd = openSync(file, 'r')
        const buffer = Buffer.alloc(HEAD_BYTES)
        const read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
        const head = buffer.toString('utf-8', 0, read)
        const meta = parseCodexRolloutHead(head, file)
        return meta ?? (head.includes('\n') || read === HEAD_BYTES ? null : undefined)
    } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}

function canonical(dir: string): string {
    try { return realpathSync(dir) } catch { return dir }
}

function dayDir(sessionsDir: string, at: number): string {
    const d = new Date(at)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return join(sessionsDir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
}

interface Start { key: string; cwd: string; startedAt: number; recordedAt: number }

interface Watch {
    key: string
    cwd: string
    startedAt: number
    requestedAt: number
    shellPid?: number
    process?: CodexProcess
    onFound: (id: string) => void
    start: Start
}

export class CodexSessionLocator {
    private readonly sessionsDir: string
    private readonly claimed = new Set<string>()
    private readonly excluded = new Set<string>()
    private readonly starts: Start[] = []
    private readonly watches = new Map<string, Watch>()
    private readonly cache = new Map<string, RolloutMeta | null>()
    private readonly inspected = new Map<string, Set<number>>()
    private readonly held = new Map<number, Set<string>>()
    private readonly deps: Required<CodexLocatorDependencies>
    private interval?: ReturnType<typeof setInterval>
    private polling = false
    private sequence = 0

    constructor(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), dependencies: CodexLocatorDependencies = {}) {
        this.sessionsDir = join(codexHome, 'sessions')
        this.deps = {
            findProcess: findCodexProcess,
            heldRollouts: heldCodexRollouts,
            isClaimed: () => false,
            isAlive: (pid) => { try { process.kill(pid, 0); return true } catch { return false } },
            now: Date.now,
            pollMs: POLL_MS,
            ...dependencies
        }
    }

    /** Starts and replacements share one timer; identified PIDs have no time limit. */
    watch(cwd: string, startedAt: number, onFound: (id: string) => void, options: { terminalId?: string; shellPid?: number } = {}): () => void {
        const key = options.terminalId ?? `watch-${++this.sequence}`
        this.pruneStarts(key)
        const start = { key, cwd: canonical(cwd), startedAt, recordedAt: this.deps.now() }
        this.starts.push(start)
        const watch: Watch = { key, cwd: start.cwd, startedAt, requestedAt: this.deps.now(), onFound, shellPid: options.shellPid, start }
        this.watches.set(key, watch)
        if (!this.interval) this.interval = setInterval(() => { void this.poll().catch((error) => console.warn('[codex-session] rollout probe failed', error)) }, this.deps.pollMs)
        return () => { if (this.watches.get(key) === watch) this.remove(key) }
    }

    private remove(key: string): void {
        this.watches.delete(key)
        this.pruneStarts()
        if (this.watches.size === 0) {
            if (this.interval) clearInterval(this.interval)
            this.interval = undefined
            this.cache.clear()
            this.inspected.clear()
            this.held.clear()
        }
    }

    private pruneStarts(replacedKey?: string): void {
        const active = [...this.watches.values()].filter((watch) => watch.key !== replacedKey)
        const cutoff = this.deps.now() - WATCH_MS
        for (let index = this.starts.length - 1; index >= 0; index--) {
            const start = this.starts[index]
            const stillRelevant = active.some((watch) => watch.start === start || (watch.cwd === start.cwd && Math.abs(watch.startedAt - start.startedAt) <= AMBIGUITY_MS))
            if (start.key === replacedKey || (start.recordedAt < cutoff && !stillRelevant)) this.starts.splice(index, 1)
        }
    }

    /** True when a rollout still exists, including Codex's optional suffix fragments. */
    exists(id: string): boolean {
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !existsSync(this.sessionsDir)) return false
        const escaped = id.replace(/[-]/g, '\\-')
        const filename = new RegExp(`-${escaped}(?:_[^/]*)?\\.jsonl$`, 'i')
        const visit = (dir: string, depth: number): boolean => {
            try {
                return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory() && depth > 0 ? visit(join(dir, entry.name), depth - 1) : entry.isFile() && filename.test(entry.name))
            } catch { return false }
        }
        return visit(this.sessionsDir, 3)
    }

    private candidates(): RolloutMeta[] {
        // Codex chooses this directory from the metadata timestamp, not the first write time.
        const dirs = new Set<string>()
        for (const watch of this.watches.values()) for (const offset of [-86_400_000, 0, 86_400_000]) dirs.add(dayDir(this.sessionsDir, watch.startedAt + offset))
        const result: RolloutMeta[] = []
        for (const dir of dirs) {
            let files: string[]
            try { files = readdirSync(dir).filter((name) => name.endsWith('.jsonl')) } catch { continue }
            for (const name of files) {
                const file = join(dir, name)
                if (!this.cache.has(file)) {
                    const meta = readMeta(file)
                    // An empty first write can become a complete header on the next poll.
                    if (meta !== undefined) this.cache.set(file, meta)
                    if (meta) result.push(meta)
                } else {
                    const meta = this.cache.get(file)
                    if (meta) result.push(meta)
                }
            }
        }
        return result.filter((meta) => !this.claimed.has(meta.id) && !this.excluded.has(meta.id) && !this.deps.isClaimed(meta.id) && [...this.watches.values()].some((watch) => this.matches(meta, watch)))
    }

    private matches(meta: RolloutMeta, watch: Watch): boolean {
        if (watch.shellPid !== undefined && !watch.process) return false
        return meta.cwd === watch.cwd && meta.startedAt >= watch.startedAt - START_SLACK_MS && meta.startedAt <= watch.startedAt + START_WINDOW_MS
    }

    private async poll(): Promise<void> {
        if (this.polling) return
        this.polling = true
        try {
            this.pruneStarts()
            // A delayed shell/setup command is not proof of absence. Retry only until a PID is confirmed.
            await Promise.all([...this.watches.values()].map(async (watch) => {
                if (watch.shellPid === undefined || watch.process) return
                if (this.deps.now() - watch.requestedAt >= WATCH_MS) { this.remove(watch.key); return }
                const found = await this.deps.findProcess(watch.shellPid).catch(() => null)
                if (this.watches.get(watch.key) !== watch) return
                if (!found) return
                watch.process = found
                watch.startedAt = found.startedAt
                watch.start.startedAt = found.startedAt
            }))
            for (const watch of this.watches.values()) {
                if ((watch.process && !this.deps.isAlive(watch.process.pid)) || (!watch.process && this.deps.now() - watch.requestedAt >= WATCH_MS)) this.remove(watch.key)
            }
            if (!this.watches.size) return
            const candidates = this.candidates().sort((a, b) => a.startedAt - b.startedAt)
            // A PID is inspected again only when a new candidate file appears, never on every tick.
            for (const candidate of candidates) {
                const inspected = this.inspected.get(candidate.file) ?? new Set<number>()
                this.inspected.set(candidate.file, inspected)
                await Promise.all([...this.watches.values()].filter((watch) => this.matches(candidate, watch) && watch.process && !inspected.has(watch.process.pid)).map(async (watch) => {
                    const pid = watch.process!.pid
                    const paths = await this.deps.heldRollouts(pid).catch(() => null)
                    if (paths === null) return
                    inspected.add(pid)
                    this.held.set(pid, new Set(paths.map(canonical)))
                }))
                const matching = [...this.watches.values()].filter((watch) => this.matches(candidate, watch))
                // Unknown ownership is not evidence for the time rule. Retry only failed pairs.
                if (matching.some((watch) => watch.process && !inspected.has(watch.process.pid))) continue
                const holders = matching.filter((watch) => watch.process && this.held.get(watch.process.pid)?.has(canonical(candidate.file)))
                let owner: Watch | undefined
                if (holders.length === 1) owner = holders[0]
                else if (holders.length === 0) {
                    const preceding = matching.filter((watch) => watch.startedAt <= candidate.startedAt).sort((a, b) => b.startedAt - a.startedAt)
                    owner = preceding[0] ?? (matching.length === 1 ? matching[0] : undefined)
                    // Reserve a PID for the parent file it actually holds before applying a time fallback.
                    if (owner?.process) {
                        const held = this.held.get(owner.process.pid)
                        if (candidates.some((other) => other.id !== candidate.id && this.matches(other, owner!) && held?.has(canonical(other.file)))) owner = undefined
                    }
                    if (owner && this.starts.some((start) => start !== owner!.start && start.cwd === owner!.cwd && Math.abs(start.startedAt - owner!.startedAt) <= AMBIGUITY_MS)) {
                        this.excluded.add(candidate.id)
                        owner = undefined
                    }
                }
                if (!owner || this.watches.get(owner.key) !== owner || this.deps.isClaimed(candidate.id)) continue
                this.claimed.add(candidate.id)
                this.remove(owner.key)
                console.log(`[codex-session] matched ${candidate.id} delta=${candidate.startedAt - owner.startedAt}ms held=${holders.length === 1}`)
                owner.onFound(candidate.id)
            }
        } finally { this.polling = false }
    }
}
