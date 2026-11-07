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
                const item = await readCandidate(join(dir, name), 'codex')
                if (item && await canonical(item.cwd) === cwd) found.push(item)
            }
            await yieldTurn()
            if (heads > HEAD_LIMIT || found.length >= LIST_LIMIT) { truncated = true; break }
        }
        const project = join(this.deps.claudeConfigDir(), 'projects', claudeProjectSlug(session.cwd))
        // A real-path alias may have its own project folder in Claude's tree.
        const projects = [...new Set([project, join(this.deps.claudeConfigDir(), 'projects', claudeProjectSlug(cwd))])]
        for (const folder of projects) {
            for (const name of await names(folder)) {
                if (!UUID.test(name.slice(0, -6)) || !name.endsWith('.jsonl')) continue
                if (++heads > HEAD_LIMIT) { truncated = true; break }
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

    async connect(sessionId: string, input: AgentConversationConnectInput): Promise<AgentConversationConnectResult> {
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
        if (front.kind === 'claude' || (front.kind === 'codex' && front.runningId && (input.agent !== 'codex' || front.runningId.toLowerCase() !== input.id.toLowerCase()))) {
            throw new AgentConversationError(409, 'agent_running', 'Exit the running agent before linking another conversation.', { runningId: front.runningId })
        }
        if (front.kind === 'codex' && !front.runningId && !startsHere(front, item) && !input.force) {
            throw new AgentConversationError(409, 'not_started_here', 'The conversation may differ from the running Codex. Confirm Connect anyway.')
        }
        const cliCommand = commandFor(session, input.agent, front)
        if (input.resume) {
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
        if (input.resume) this.deps.write(sessionId, `\x15${cliCommand} ${input.agent === 'codex' ? 'resume' : '--resume'} ${item.id}\r`)
        return { status: 'connected', resumed: input.resume === true, cliCommand }
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

/** Read a bounded head only. Index files, sidecars, symlinks and empty conversations are excluded. */
async function readCandidate(file: string, agent: ConversationAgent): Promise<Candidate | null> {
    try {
        const stat = await lstat(file)
        if (!stat.isFile()) return null
        const handle = await open(file, 'r')
        let text: string
        try {
            const buffer = Buffer.alloc(agent === 'codex' ? CODEX_HEAD : CLAUDE_HEAD)
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
            const head = buffer.subarray(0, bytesRead).toString('utf8')
            text = head.slice(0, head.lastIndexOf('\n') + 1)
        } finally { await handle.close() }
        const records = text.split('\n').flatMap((line) => { try { return [object(JSON.parse(line))] } catch { return [] } })
        let id: string
        let cwd: string
        let startedAt: number
        if (agent === 'codex') {
            const header = records[0]
            if (header?.type !== 'session_meta') return null
            const meta = object(header.payload)
            if (meta.source !== undefined && meta.source !== 'cli' && meta.source !== 'vscode') return null
            if (meta.originator !== undefined && meta.originator !== 'codex-tui') return null
            id = typeof meta.id === 'string' ? meta.id : ''
            cwd = typeof meta.cwd === 'string' ? meta.cwd : ''
            startedAt = Date.parse(String(meta.timestamp ?? header.timestamp))
        } else {
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

/** Saved commands and process argv are trusted local input; transcript text never enters a command. */
function commandFor(session: TerminalSession, agent: ConversationAgent, front: AgentConversationFront): string {
    const command = session.cliToolName === agent && session.cliCommand ? session.cliCommand
        : session.initialCommand && initialCommandAgent(session.initialCommand) === agent ? session.initialCommand
            : front.kind === agent ? safeProcessCommand(front.argv, agent) : agent
    return command.replace(/\s+(?:resume|--resume|-r|--session-id)\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\s|$)/gi, '').trim()
}

/** Recognize the executable after setup commands, keeping quoted arguments out of that decision. */
function initialCommandAgent(command: string): string | undefined {
    let tokens: string[] = []
    let word = ''
    let quote = ''
    let escaped = false
    const flush = (): void => { if (word) tokens.push(word); word = '' }
    for (let i = 0; i < command.length; i++) {
        const character = command[i]
        if (escaped) { word += character; escaped = false }
        else if (character === '\\' && quote !== "'") escaped = true
        else if (quote) { if (character === quote) quote = ''; else word += character }
        else if (character === '"' || character === "'") quote = character
        else if (character === ';' || character === '&' && command[i + 1] === '&') {
            tokens = []; word = ''; if (character === '&') i++
        } else if (/\s/.test(character)) flush()
        else word += character
    }
    if (quote || escaped) return undefined
    flush()
    if (tokens[0] === 'env') tokens.shift()
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift()
    return tokens[0]?.split('/').pop()
}

/** ps does not preserve shell quoting. Keep safe options only, never the agent's opening prompt. */
function safeProcessCommand(argv: string | undefined, agent: ConversationAgent): string {
    const tokens = (argv ?? '').split(/\s+/)
    const start = tokens.findIndex((token) => token.split('/').pop() === agent)
    if (start < 0) return agent
    const safe = /^[A-Za-z0-9_./:=,+@%~-]+$/
    if (!safe.test(tokens[start])) return agent
    const result = [tokens[start]]
    const withValue = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--enable', '--disable', '--add-dir', '--permission-mode', '--effort'])
    for (let i = start + 1; i < tokens.length; i++) {
        const token = tokens[i]
        if (token === 'resume' && UUID.test(tokens[i + 1] ?? '')) { i++; continue }
        if (['--resume', '-r', '--session-id'].includes(token) && UUID.test(tokens[i + 1] ?? '')) { i++; continue }
        if (token === '--' || !token.startsWith('-')) break
        if (!safe.test(token)) return agent
        result.push(token)
        if (withValue.has(token)) {
            const value = tokens[++i]
            if (!value || !safe.test(value)) return agent
            result.push(value)
        }
    }
    return result.join(' ')
}
