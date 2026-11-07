import { lstat, open, readdir, realpath } from 'fs/promises'
import { basename, join } from 'path'
import type { TerminalSession } from '../shared/types'
import type {
    AgentConversationConnectInput, AgentConversationConnectResult, AgentConversationFront,
    AgentConversationItem, AgentConversationLink, AgentConversationList, ConversationAgent
} from '../shared/conversation'
import { claudeProjectSlug } from './TranscriptReader'
import { parseClaudeTranscript } from './transcript/claudeTranscript'
import { parseCodexTranscript } from './transcript/codexTranscript'
import { maskSecretLines } from './maskSecrets'
import { parseCodexRolloutHead } from './CodexSessionLocator'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LIST_LIMIT = 30
const HEAD_LIMIT = 2000
const DAY_LIMIT = 90
const DAY_MS = 86_400_000
const CODEX_HEAD = 512 * 1024
const CLAUDE_HEAD = 64 * 1024

export class AgentConversationError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string,
        public readonly details?: { runningId?: string | null; linkedTo?: AgentConversationLink }) {
        super(message)
    }
}

export interface AgentConversationsDeps {
    sessions: () => TerminalSession[]
    foreground: (sessionId: string) => Promise<AgentConversationFront>
    update: (sessionId: string, values: { cliSessionId: string; cliToolName: ConversationAgent; cliCommand: string }) => void
    write: (sessionId: string, data: string) => void
    /** Flushes and rejects questions or a nonempty input line before any mutation. */
    beforeResume: (sessionId: string) => Promise<void>
    waitForAgent?: (sessionId: string, agent: ConversationAgent, conversationId: string) => Promise<boolean>
    resolveAlias?: (name: string) => string | undefined
    forget?: (sessionId: string) => void
    codexHome: () => string
    claudeConfigDir: () => string
    now?: () => number
}

interface Candidate extends Omit<AgentConversationItem, 'startedHere' | 'linkedTo'> { cwd: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const canonical = async (cwd: string): Promise<string> => { try { return await realpath(cwd) } catch { return cwd } }
const names = async (dir: string): Promise<string[]> => { try { return await readdir(dir) } catch { return [] } }
const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const matchesId = (name: string, id: string): boolean => name.toLowerCase().endsWith(`-${id.toLowerCase()}.jsonl`) || (name.endsWith('.jsonl') && name.toLowerCase().includes(`-${id.toLowerCase()}_`))

/** Lists local conversations and validates manual links, shared by IPC and the Control API. */
export class AgentConversations {
    constructor(private readonly deps: AgentConversationsDeps) {}

    async list(sessionId: string): Promise<AgentConversationList> {
        const session = this.session(sessionId)
        const cwd = await canonical(session.cwd)
        const front = await this.deps.foreground(sessionId)
        const found: Candidate[] = []
        let truncated = false
        let heads = 0
        const now = this.deps.now?.() ?? Date.now()
        const dirs = await this.codexDays()
        for (const dir of dirs) {
            if (now - dayTimestamp(dir) >= DAY_LIMIT * DAY_MS) { truncated = true; break }
            for (const name of (await names(dir)).sort().reverse()) {
                if (!name.endsWith('.jsonl')) continue
                if (++heads > HEAD_LIMIT) { truncated = true; break }
                const item = await readCandidate(join(dir, name), 'codex', cwd)
                if (item && await canonical(item.cwd) === cwd) found.push(item)
            }
            await yieldTurn()
            if (heads > HEAD_LIMIT || found.length >= LIST_LIMIT) { truncated = true; break }
        }
        const project = join(this.deps.claudeConfigDir(), 'projects', claudeProjectSlug(session.cwd))
        // A real-path alias may have its own project folder in Claude's tree.
        const projects = [...new Set([project, join(this.deps.claudeConfigDir(), 'projects', claudeProjectSlug(cwd))])]
        let claudeHeads = 0
        for (const folder of projects) {
            for (const name of await names(folder)) {
                if (!UUID.test(name.slice(0, -6)) || !name.endsWith('.jsonl')) continue
                if (++claudeHeads > HEAD_LIMIT) { truncated = true; break }
                const item = await readCandidate(join(folder, name), 'claude')
                if (item && await canonical(item.cwd) === cwd) found.push(item)
            }
            await yieldTurn()
        }
        const unique = [...new Map(found.map((item) => [`${item.agent}:${item.id}`, item])).values()]
        unique.sort((a, b) => b.updatedAt - a.updatedAt)
        return {
            cwd: session.cwd,
            front: { kind: front.kind, runningId: front.runningId, startedAt: front.startedAt },
            current: (session.cliToolName === 'claude' || session.cliToolName === 'codex') && session.cliSessionId
                ? { agent: session.cliToolName, id: session.cliSessionId } : null,
            items: unique.slice(0, LIST_LIMIT).map(({ cwd: _cwd, ...item }) => ({
                ...item, startedHere: startsHere(front, item), linkedTo: this.linkedTo(sessionId, item.agent, item.id)
            })),
            truncated: truncated || unique.length > LIST_LIMIT
        }
    }

    async connect(sessionId: string, input: AgentConversationConnectInput, hooks: { beforeWrite?: () => void; baseCommand?: string } = {}): Promise<AgentConversationConnectResult> {
        const session = this.session(sessionId)
        if (!input || (input.agent !== 'claude' && input.agent !== 'codex') || typeof input.id !== 'string' || !UUID.test(input.id)) {
            throw new AgentConversationError(400, 'invalid_id', 'Choose an agent conversation with a valid UUID.')
        }
        if ((input.resume !== undefined && typeof input.resume !== 'boolean') || (input.force !== undefined && typeof input.force !== 'boolean')) {
            throw new AgentConversationError(400, 'invalid_request', 'resume and force must be booleans.')
        }
        const item = await this.find(input.agent, input.id, session.cwd)
        if (!item) throw new AgentConversationError(404, 'not_found', 'The conversation file is unavailable.')
        if (await canonical(item.cwd) !== await canonical(session.cwd)) throw new AgentConversationError(409, 'cwd_mismatch', 'The conversation belongs to another working folder.')
        const linkedTo = this.linkedTo(sessionId, input.agent, input.id)
        if (linkedTo) throw new AgentConversationError(409, 'linked_elsewhere', 'The conversation is linked to another terminal.', { linkedTo })
        const front = await this.deps.foreground(sessionId)
        if (front.kind === 'unknown') throw new AgentConversationError(409, 'foreground_unknown', 'Cannot verify the foreground program. Try again before connecting.')
        if (front.kind === 'claude' || (front.kind === 'codex' && (input.agent !== 'codex' || front.runningId && front.runningId.toLowerCase() !== input.id.toLowerCase()))) {
            throw new AgentConversationError(409, 'agent_running', 'Exit the running agent before linking another conversation.', { runningId: front.runningId })
        }
        if (front.kind === 'codex' && !front.runningId && !startsHere(front, item) && !input.force) {
            throw new AgentConversationError(409, 'not_started_here', 'The conversation may differ from the running Codex. Confirm Connect anyway.')
        }
        const cliCommand = hooks.baseCommand !== undefined
            ? normalizeAgentCommand(hooks.baseCommand, input.agent, this.deps.resolveAlias)
            : commandFor(session, input.agent, front, this.deps.resolveAlias)
        if (input.resume) {
            await this.deps.beforeResume(sessionId)
            const latest = await this.deps.foreground(sessionId)
            // The process may have changed while the disk and process checks were in flight.
            if (front.kind !== 'shell' || latest.kind !== 'shell') throw new AgentConversationError(409, 'not_shell', 'Resume requires an idle shell.')
        }
        // Recheck the mutable store after the final await, before persisting or typing.
        this.session(sessionId)
        const conflict = this.linkedTo(sessionId, input.agent, input.id)
        if (conflict) throw new AgentConversationError(409, 'linked_elsewhere', 'The conversation is linked to another terminal.', { linkedTo: conflict })
        this.deps.update(sessionId, { cliSessionId: item.id, cliToolName: input.agent, cliCommand })
        this.deps.forget?.(sessionId)
        let resumed = false
        if (input.resume) {
            hooks.beforeWrite?.()
            this.deps.write(sessionId, `${cliCommand} ${input.agent === 'codex' ? 'resume' : '--resume'} ${item.id}\r`)
            try { resumed = await this.deps.waitForAgent?.(sessionId, input.agent, item.id) ?? false } catch { /* A command typed is not proof of startup. */ }
        }
        return { status: 'connected', resumed, typed: input.resume === true, cliCommand }
    }

    private session(id: string): TerminalSession {
        const session = this.deps.sessions().find((value) => value.id === id)
        if (!session) throw new AgentConversationError(404, 'unknown_session', 'The terminal session no longer exists.')
        return session
    }

    private linkedTo(sessionId: string, agent: ConversationAgent, id: string): AgentConversationLink | null {
        const other = this.deps.sessions().find((entry) => entry.id !== sessionId && entry.cliToolName === agent && entry.cliSessionId?.toLowerCase() === id.toLowerCase())
        return other ? { sessionId: other.id, name: other.name } : null
    }

    private async codexDays(): Promise<string[]> {
        const root = join(this.deps.codexHome(), 'sessions')
        const result: string[] = []
        for (const year of (await names(root)).filter((value) => /^\d{4}$/.test(value))) {
            for (const month of (await names(join(root, year))).filter((value) => /^\d{2}$/.test(value))) {
                for (const day of (await names(join(root, year, month))).filter((value) => /^\d{2}$/.test(value))) result.push(join(root, year, month, day))
            }
        }
        return result.sort().reverse()
    }

    private async find(agent: ConversationAgent, id: string, cwd: string): Promise<Candidate | null> {
        if (agent === 'codex') {
            for (const dir of await this.codexDays()) {
                for (const name of (await names(dir)).filter((value) => matchesId(value, id))) {
                    const candidate = await readCandidate(join(dir, name), agent)
                    if (candidate?.id.toLowerCase() === id.toLowerCase()) return candidate
                }
                await yieldTurn()
            }
        } else {
            const projects = join(this.deps.claudeConfigDir(), 'projects')
            const direct = await readCandidate(join(projects, claudeProjectSlug(cwd), `${id}.jsonl`), agent)
            if (direct) return direct
            for (const dir of (await names(projects)).slice(0, HEAD_LIMIT)) {
                const candidate = await readCandidate(join(projects, dir, `${id}.jsonl`), agent)
                if (candidate) return candidate
                await yieldTurn()
            }
        }
        return null
    }
}

function startsHere(front: AgentConversationFront, item: Pick<Candidate, 'agent' | 'startedAt'>): boolean {
    return front.kind === item.agent && front.startedAt !== null && item.startedAt >= front.startedAt - 2000 && item.startedAt <= front.startedAt + 30_000
}

function dayTimestamp(dir: string): number {
    const parts = dir.split(/[\\/]/).slice(-3).map(Number)
    return new Date(parts[0], parts[1] - 1, parts[2]).getTime()
}

/** Inspect metadata before parsing bounded transcript text. Unrelated large heads stay unread. */
async function readCandidate(file: string, agent: ConversationAgent, targetCwd?: string): Promise<Candidate | null> {
    try {
        const stat = await lstat(file)
        if (!stat.isFile()) return null
        const handle = await open(file, 'r')
        let text: string
        let id = ''
        let cwd = ''
        let startedAt = NaN
        try {
            let buffer = Buffer.alloc(agent === 'codex' ? 8192 : CLAUDE_HEAD)
            let length = 0
            if (agent === 'codex') {
                length = (await handle.read(buffer, 0, 8192, 0)).bytesRead
                const meta = parseCodexRolloutHead(buffer.subarray(0, length).toString('utf8'), file)
                if (!meta || targetCwd !== undefined && await canonical(meta.cwd) !== targetCwd) return null
                ;({ id, cwd, startedAt } = meta)
                const transcript = Buffer.alloc(CODEX_HEAD)
                buffer.copy(transcript, 0, 0, length)
                buffer = transcript
            }
            const rest = await handle.read(buffer, length, buffer.length - length, length)
            const head = buffer.subarray(0, length + rest.bytesRead).toString('utf8')
            text = head.slice(0, head.lastIndexOf('\n') + 1)
        } finally { await handle.close() }
        if (agent === 'claude') {
            const records = text.split('\n').flatMap((line) => { try { return [object(JSON.parse(line))] } catch { return [] } })
            const header = records.find((record) => typeof record.cwd === 'string')
            id = basename(file, '.jsonl')
            cwd = typeof header?.cwd === 'string' ? header.cwd : ''
            startedAt = Date.parse(String(header?.timestamp))
        }
        if (!UUID.test(id) || !cwd || !Number.isFinite(startedAt)) return null
        const turns = agent === 'codex' ? parseCodexTranscript(text, 1000) : parseClaudeTranscript(text, 1000)
        const first = turns.find((turn) => turn.role === 'user' && turn.parts.some((part) => part.kind === 'text' && part.text.trim()))
        const words = first?.parts.flatMap((part) => part.kind === 'text' ? [part.text] : []).join('\n')
        if (!words?.trim()) return null
        const firstMessage = maskSecretLines(words.split(/\r?\n/)).lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200)
        return { agent, id, cwd, startedAt, updatedAt: stat.mtimeMs, bytes: stat.size, firstMessage }
    } catch { return null }
}

type AliasResolver = (name: string) => string | undefined
const AND_TOKEN = '\0and'
const SEMI_TOKEN = '\0semi'

function commandFor(session: TerminalSession, agent: ConversationAgent, front: AgentConversationFront, resolveAlias?: AliasResolver): string {
    const candidates = [session.cliToolName === agent ? session.cliCommand : undefined, session.initialCommand, front.kind === agent ? front.argv : undefined]
    for (const command of candidates) {
        const normalized = normalizeCommand(command, agent, resolveAlias)
        if (normalized) return normalized.command
    }
    return agent
}

/** Every persistence path drops opening prompts, resume targets and noninteractive modes. */
export function normalizeAgentCommand(command: string | undefined, agent: ConversationAgent, resolveAlias?: AliasResolver): string {
    return normalizeCommand(command, agent, resolveAlias)?.command ?? agent
}

/** Recognizes the executable after shell setup, including a known safe alias expansion. */
export function commandAgent(command: string | undefined, resolveAlias?: AliasResolver, depth = 0): ConversationAgent | null {
    if (!command || depth > 4) return null
    const tokens = commandTokens(command)
    if (!tokens?.length) {
        // Classification only: malformed prompts still identify a command that needs sanitizing.
        const first = /^\s*([^\s]+)/.exec(command)?.[1]
        if (!first) return null
        const name = basename(first)
        return name === 'claude' || name === 'codex' ? name : commandAgent(resolveAlias?.(first), resolveAlias, depth + 1)
    }
    let start = Math.max(tokens.lastIndexOf(AND_TOKEN), tokens.lastIndexOf(SEMI_TOKEN)) + 1
    if (tokens[start] === 'env') start++
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start] ?? '')) start++
    if (/^(node|nodejs)$/.test(basename(tokens[start] ?? ''))) start++
    const executable = tokens[start]
    if (!executable) return null
    const name = basename(executable)
    return name === 'claude' || name === 'codex' ? name : commandAgent(resolveAlias?.(executable), resolveAlias, depth + 1)
}

const VALUE_FLAGS: Record<ConversationAgent, Set<string>> = {
    codex: new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--enable', '--disable', '--add-dir']),
    claude: new Set(['--model', '--permission-mode', '--effort', '--agent', '--agents', '--add-dir', '--mcp-config', '--settings', '--setting-sources', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--append-system-prompt', '--append-system-prompt-file', '--system-prompt', '--system-prompt-file', '--betas'])
}
const NONINTERACTIVE: Record<ConversationAgent, Set<string>> = {
    codex: new Set(['exec', 'e', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox', 'debug', 'apply', 'a', 'cloud', 'features', 'fork', 'help']),
    claude: new Set(['install', 'uninstall', 'update', 'config', 'mcp', 'doctor', 'api-key'])
}
const quoteToken = (token: string): string => /^[A-Za-z0-9_./:=,+@%~-]+$/.test(token) ? token : "'" + token.replace(/'/g, "'\\''") + "'"

/** A small shell lexer: quotes are understood, but substitutions and control operators are refused. */
function commandTokens(command: string): string[] | null {
    if (/[\x00-\x08\x0a-\x1f]/.test(command)) return null
    const tokens: string[] = []
    let word = ''
    let quoted = false
    let quote = ''
    let escaped = false
    const flush = (): void => { if (word || quoted) tokens.push(word); word = ''; quoted = false }
    for (let i = 0; i < command.length; i++) {
        const character = command[i]
        if (escaped) { word += character; escaped = false; continue }
        if (character === '\\' && quote !== "'") { escaped = true; continue }
        if (quote) { if (character === quote) quote = ''; else word += character; continue }
        if (character === '"' || character === "'") { quote = character; quoted = true; continue }
        if (/\s/.test(character)) { flush(); continue }
        if (character === ';' || character === '&' && command[i + 1] === '&') {
            flush(); tokens.push(character === ';' ? SEMI_TOKEN : AND_TOKEN); if (character === '&') i++; continue
        }
        if (/[|&<>`$\r\n]/.test(character)) return null
        word += character
    }
    if (quote || escaped) return null
    flush()
    return tokens
}

function normalizeCommand(command: string | undefined, agent: ConversationAgent, resolveAlias?: AliasResolver, depth = 0): { command: string; stripped: boolean } | null {
    if (!command || depth > 4) return null
    const tokens = commandTokens(command)
    if (!tokens?.length) return null
    const segment = Math.max(tokens.lastIndexOf(AND_TOKEN), tokens.lastIndexOf(SEMI_TOKEN)) + 1
    let start = segment
    if (tokens[start] === 'env') start++
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start] ?? '')) start++
    // Node wrappers are only a command fallback; the native executable can be resumed directly.
    if (/^(node|nodejs)$/.test(basename(tokens[start] ?? ''))) start++
    const executable = tokens[start]
    if (!executable) return null
    if (basename(executable) !== agent) {
        const expansion = resolveAlias?.(executable)
        const resolved = normalizeCommand(expansion, agent, resolveAlias, depth + 1)
        if (!resolved) return null
        // Keeping an alias that secretly carries a prompt would replay it despite stripping its text.
        if (resolved.stripped) return { command: agent, stripped: true }
    }
    const result = tokens.slice(0, start + 1)
    let stripped = false
    for (let i = start + 1; i < tokens.length; i++) {
        const token = tokens[i]
        const flag = token.split('=', 1)[0]
        if (agent === 'codex' && token === 'resume') {
            if (!UUID.test(tokens[i + 1] ?? '')) return { command: agent, stripped: true }
            i++; stripped = true; continue
        }
        if (['--resume', '-r', '--session-id'].includes(flag)) {
            if (!token.includes('=')) i++
            stripped = true; continue
        }
        if (['--help', '-h', '--version', '-V'].includes(flag) || agent === 'claude' && (/^-p/.test(flag) || ['--print', '--continue', '-c', '--fork-session'].includes(flag))) {
            return { command: agent, stripped: true }
        }
        if (token === '--' || !token.startsWith('-')) {
            if (NONINTERACTIVE[agent].has(token)) return { command: agent, stripped: true }
            stripped = true; break
        }
        result.push(token)
        if (VALUE_FLAGS[agent].has(flag) && !token.includes('=')) {
            const value = tokens[++i]
            if (value === undefined) return { command: agent, stripped: true }
            result.push(value)
        }
    }
    // Only command separators emitted by the lexer stay executable; all argument values are literals.
    return { command: result.map((token) => token === AND_TOKEN ? '&&' : token === SEMI_TOKEN ? ';' : quoteToken(token)).join(' '), stripped }
}
