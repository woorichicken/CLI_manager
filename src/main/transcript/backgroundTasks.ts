// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/claude-subagents.ts — what tells a background command and a subagent started and
// ended (`scanCommands`, `commandEnds`, `scanStop`, `acknowledgement`, `readMeta`, the end resolution
// of `claudeSubagentState`). Not ported: the command-history scan past the read window, the turn and
// rest tracking, an agent's detail view, teammates' shutdown answers and the process-start check
// (`since`) — here the count Claude itself shows under its input box decides what still runs
// (ConversationService.backgroundTasks).
//
// What runs in the background of one Claude Code session, read from its transcript: a `Bash` call
// whose answer carries a `backgroundTaskId` (`run_in_background`, Ctrl+B, a call moved there past its
// timeout) ends with the `<task-notification>` of its task id or with the answer of the `TaskStop`
// (`KillShell` in older Claude Code) that stopped it. A subagent has a pair beside the transcript,
// `<session>/subagents/agent-<id>.meta.json` (description, agent type, the call that started it) and
// `agent-<id>.jsonl`; it ends with its notification, the answer to its synchronous call (the «Async
// agent launched» acknowledgement is no answer) or a TaskStop, and runs again when its own file has
// entries newer than that end (it was resumed).

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs'
import { join } from 'path'
import type { BackgroundTask } from '../../shared/conversation'
import { taskNotification, type TaskNotification } from './subagents'

/** how much of a transcript the first read covers: older launches are not found (ovis PARENT_WINDOW) */
export const BACKGROUND_WINDOW = 16 * 1024 * 1024
const MAX_META_BYTES = 64 * 1024
const TAIL_BYTES = 64 * 1024
const MAX_AGENTS = 200
const MAX_NAMES = 5000
/** what ended is listed for a day, the newest ten (ovis RECENT_MS · RECENT_LIMIT) */
const RECENT_MS = 24 * 60 * 60 * 1000
const RECENT_LIMIT = 10
const TITLE_LENGTH = 120
const AGENT_ID = /^[A-Za-z0-9_-]+$/

type Row = Record<string, unknown>
type Status = BackgroundTask['status']
type Ended = { at: number; status: Exclude<Status, 'running' | 'lost'> }
const row = (value: unknown): Row | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : null)
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 300) : null)
const stamp = (value: unknown): number | null => {
    const at = typeof value === 'string' ? Date.parse(value) : NaN
    return Number.isFinite(at) ? at : null
}
const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString())

/** Set `key` as the newest entry; the oldest one goes when the map is over `cap`. */
function remember<T>(map: Map<string, T>, key: string, value: T, cap: number): void {
    map.delete(key)
    map.set(key, value)
    if (map.size > cap) map.delete(map.keys().next().value!)
}

/** What the transcript said so far; read on from `offset` as it grows. */
interface Parent {
    id: string
    offset: number
    /** the part of a line written after the last read */
    carry: string
    /** the title of each `Bash` call not answered yet: its description, else its command */
    calls: Map<string, string>
    launches: Map<string, { at: number; title: string }>
    /** the newest end each command id was told of */
    ends: Map<string, Ended>
    /** `Agent`/`Task` calls, so their answers are known as an agent's */
    agentCalls: Set<string>
    /** the answer to each synchronous agent call */
    results: Map<string, Ended>
    /** each subagent's newest notification */
    notes: Map<string, Ended>
    /** TaskStop calls not answered yet, and when each task was stopped */
    stopCalls: Map<string, string>
    stops: Map<string, number>
}

/** The blocks a transcript entry carries as a notification, in whichever of the three records holds them. */
function blocksIn(entry: Row): string[] {
    if (entry.type === 'queue-operation') return entry.operation === 'enqueue' && typeof entry.content === 'string' ? [entry.content] : []
    if (entry.type === 'attachment') {
        const attachment = row(entry.attachment)
        return attachment?.commandMode === 'task-notification' && typeof attachment.prompt === 'string' ? [attachment.prompt] : []
    }
    if (entry.type !== 'user') return []
    const content = row(entry.message)?.content
    if (typeof content === 'string') return [content]
    // only what the person's side wrote as text: a tool result that quotes a block is not one
    return (Array.isArray(content) ? content : []).flatMap((value) => {
        const block = row(value)
        return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    })
}

/** An `Agent` call's launch is answered at once, with an acknowledgement that is no answer. */
function acknowledgement(entry: Row, block: Row): boolean {
    if (row(entry.toolUseResult)?.status === 'async_launched') return true
    const content = block.content
    const words = typeof content === 'string' ? content : (Array.isArray(content) ? content : []).map((part) => row(part)?.text).filter((part) => typeof part === 'string').join('')
    return words.startsWith('Async agent launched')
}

function endOf(map: Map<string, Ended>, id: string, end: Ended): void {
    const known = map.get(id)
    if (!known || end.at >= known.at) remember(map, id, end, MAX_NAMES)
}

/** Whether a line may say something here, before it is parsed: most lines are passed over. */
const worthParsing = (line: string): boolean =>
    line.includes('<task-notification>') ||
    line.includes('"name":"Bash"') ||
    line.includes('"backgroundTaskId"') ||
    line.includes('"task_id"') ||
    line.includes('"shell_id"') ||
    line.includes('"name":"Agent"') ||
    line.includes('"name":"Task"') ||
    line.includes('"name":"TaskStop"') ||
    line.includes('"tool_result"')

export function scanParentLine(parent: Parent, line: string): void {
    if (!worthParsing(line)) return
    let entry: Row | null
    try {
        entry = row(JSON.parse(line))
    } catch {
        return
    }
    if (entry === null || entry.isSidechain === true) return
    const at = stamp(entry.timestamp)
    if (at === null) return
    const notices: TaskNotification[] = line.includes('<task-notification>') ? blocksIn(entry).flatMap((block) => taskNotification(block) ?? []) : []
    for (const notice of notices) {
        if (notice.agent) endOf(parent.notes, notice.taskId, { at, status: notice.status })
        else endOf(parent.ends, notice.taskId, { at, status: notice.status })
    }
    const content = row(entry.message)?.content
    const blocks = (Array.isArray(content) ? content : []).flatMap((value): Row[] => {
        const block = row(value)
        return block === null ? [] : [block]
    })
    const failed = blocks.some((block) => block.type === 'tool_result' && block.is_error === true)
    const result = failed ? null : row(entry.toolUseResult)
    for (const block of blocks) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
            const input = row(block.input)
            if (block.name === 'Bash') {
                const title = text(input?.description) ?? text(input?.command)
                if (title !== null) remember(parent.calls, block.id, title.slice(0, TITLE_LENGTH), 512)
            } else if (block.name === 'Agent' || block.name === 'Task') {
                parent.agentCalls.add(block.id)
            } else if (block.name === 'TaskStop') {
                const asked = text(input?.task_id) ?? text(input?.shell_id)
                if (asked !== null) remember(parent.stopCalls, block.id, asked, MAX_NAMES)
            }
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const call = block.tool_use_id
            if (parent.agentCalls.has(call) && !acknowledgement(entry, block)) {
                remember(parent.results, call, { at, status: block.is_error === true ? 'failed' : 'completed' }, MAX_NAMES)
            }
            const asked = parent.stopCalls.get(call)
            if (asked !== undefined) {
                parent.stopCalls.delete(call)
                if (block.is_error !== true) {
                    const answered = row(entry.toolUseResult)?.task_id
                    for (const id of new Set([asked, ...(typeof answered === 'string' ? [answered] : [])])) remember(parent.stops, id, at, MAX_NAMES)
                }
            }
        }
    }
    // a command started in the background: its answer names the task
    const launched = result?.backgroundTaskId
    if (typeof launched === 'string' && AGENT_ID.test(launched)) {
        const call = blocks.find((block) => block.type === 'tool_result' && typeof block.tool_use_id === 'string')?.tool_use_id as string | undefined
        remember(parent.launches, launched, { at, title: (call === undefined ? undefined : parent.calls.get(call)) ?? 'Background command' }, MAX_NAMES)
        if (call !== undefined) parent.calls.delete(call)
    }
    // TaskStop answers with the task it stopped, KillShell with the shell
    const stopped = typeof result?.task_type === 'string' ? result.task_id : result?.shell_id
    if (typeof stopped === 'string') endOf(parent.ends, stopped, { at, status: 'cancelled' })
    if (parent.agentCalls.size > MAX_NAMES) parent.agentCalls.clear()
}

const newParent = (id: string): Parent => ({
    id,
    offset: 0,
    carry: '',
    calls: new Map(),
    launches: new Map(),
    ends: new Map(),
    agentCalls: new Set(),
    results: new Map(),
    notes: new Map(),
    stopCalls: new Map(),
    stops: new Map()
})

/** `id` that changes when the file is replaced, not when it grows */
const fileId = (stat: { dev: number; ino: number }): string => `${stat.dev}:${stat.ino}`

interface Meta {
    title: string | null
    agent: string | null
    toolUseId: string | null
}

function readMeta(path: string): Meta | null {
    try {
        const stat = statSync(path)
        if (!stat.isFile() || stat.size > MAX_META_BYTES) return null
        const record = row(JSON.parse(readFileSync(path, 'utf8')))
        if (record === null) return null
        return { title: text(record.description) ?? text(record.name), agent: text(record.agentType), toolUseId: text(record.toolUseId) }
    } catch {
        return null // being written
    }
}

/** The first and the last timestamp of an agent's own file, from its head and its tail. */
function agentSpan(path: string): { firstAt: number | null; lastAt: number | null } {
    let fd: number | null = null
    try {
        fd = openSync(path, 'r')
        const size = fstatSync(fd).size
        const read = (from: number, length: number): string => {
            const buffer = Buffer.alloc(length)
            const got = readSync(fd!, buffer, 0, length, from)
            return buffer.subarray(0, got).toString('utf8')
        }
        const stampsIn = (chunk: string): number[] =>
            chunk.split('\n').flatMap((line) => {
                const at = stamp(line.match(/"timestamp":"([^"]+)"/)?.[1])
                return at === null ? [] : [at]
            })
        const head = stampsIn(read(0, Math.min(size, TAIL_BYTES)))
        const tail = stampsIn(read(Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES)))
        return { firstAt: head[0] ?? null, lastAt: tail.length > 0 ? Math.max(...tail) : null }
    } catch {
        return { firstAt: null, lastAt: null }
    } finally {
        if (fd !== null) closeSync(fd)
    }
}

/**
 * One session's background tasks, read on from where the last call stopped. Running ones first
 * (oldest first), then up to ten that ended in the last day (newest first), as ovis lists them.
 */
export class BackgroundTaskReader {
    private readonly parents = new Map<string, Parent>()

    constructor(private readonly options: { window?: number } = {}) {}

    read(parentPath: string, now = Date.now()): BackgroundTask[] {
        const parent = this.scan(parentPath)
        const all: BackgroundTask[] = []
        for (const [id, launch] of parent?.launches ?? []) {
            const end = parent!.ends.get(id)
            const ended = end && end.at >= launch.at ? end : null
            all.push({ id, kind: 'shell', title: launch.title, agent: null, status: ended?.status ?? 'running', startedAt: iso(launch.at), endedAt: iso(ended?.at ?? null) })
        }
        for (const task of this.agents(parentPath, parent, now)) all.push(task)
        const time = (value: string | null): number => (value === null ? 0 : Date.parse(value) || 0)
        const running = all.filter((task) => task.status === 'running').sort((a, b) => time(a.startedAt) - time(b.startedAt))
        const ended = all
            .filter((task) => task.status !== 'running' && now - (time(task.endedAt) || time(task.startedAt)) <= RECENT_MS)
            .sort((a, b) => (time(b.endedAt) || time(b.startedAt)) - (time(a.endedAt) || time(a.startedAt)))
        return [...running, ...ended.slice(0, RECENT_LIMIT)]
    }

    forget(parentPath: string): void {
        this.parents.delete(parentPath)
    }

    /** Reads what was written since the last call; a replaced or shortened file is read again. */
    private scan(path: string): Parent | null {
        let fd: number | null = null
        try {
            fd = openSync(path, 'r')
            const stat = fstatSync(fd)
            if (!stat.isFile()) return null
            let parent = this.parents.get(path)
            if (!parent || parent.id !== fileId(stat) || stat.size < parent.offset) {
                parent = newParent(fileId(stat))
                const start = Math.max(0, stat.size - (this.options.window ?? BACKGROUND_WINDOW))
                parent.offset = start
                // started inside a line: that line is not whole
                parent.carry = start > 0 ? '\0' : ''
                remember(this.parents, path, parent, 64)
            }
            const length = stat.size - parent.offset
            if (length <= 0) return parent
            const buffer = Buffer.alloc(length)
            const got = readSync(fd, buffer, 0, length, parent.offset)
            parent.offset += got
            const lines = (parent.carry + buffer.subarray(0, got).toString('utf8')).split('\n')
            parent.carry = lines.pop() ?? ''
            if (lines[0]?.startsWith('\0')) lines.shift()
            for (const line of lines) if (line.length > 0) scanParentLine(parent, line)
            return parent
        } catch {
            return this.parents.get(path) ?? null
        } finally {
            if (fd !== null) closeSync(fd)
        }
    }

    private agents(parentPath: string, parent: Parent | null, now: number): BackgroundTask[] {
        const dir = join(parentPath.replace(/\.jsonl$/, ''), 'subagents')
        if (!existsSync(dir)) return []
        let names: string[]
        try {
            names = readdirSync(dir)
        } catch {
            return []
        }
        const files = names
            .flatMap((name) => {
                const id = name.match(/^agent-(.+)\.jsonl$/)?.[1]
                if (!id || !AGENT_ID.test(id)) return []
                try {
                    const stat = statSync(join(dir, name))
                    return stat.isFile() && now - stat.mtimeMs <= RECENT_MS ? [{ id, mtimeMs: stat.mtimeMs }] : []
                } catch {
                    return []
                }
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, MAX_AGENTS)
        const tasks: BackgroundTask[] = []
        for (const { id } of files) {
            const meta = readMeta(join(dir, `agent-${id}.meta.json`))
            if (meta === null) continue
            const { firstAt, lastAt } = agentSpan(join(dir, `agent-${id}.jsonl`))
            // what ended it last: its notice, the answer to its synchronous call, or a TaskStop
            const candidates: Ended[] = [
                parent?.notes.get(id),
                meta.toolUseId !== null ? parent?.results.get(meta.toolUseId) : undefined,
                parent?.stops.has(id) ? { at: parent.stops.get(id)!, status: 'cancelled' as const } : undefined
            ].filter((end): end is Ended => end !== undefined)
            const end = candidates.reduce<Ended | null>((newest, next) => (newest === null || next.at >= newest.at ? next : newest), null)
            // an end older than the agent's last entry is from before it was resumed
            const ended = end !== null && (lastAt === null || lastAt <= end.at) ? end : null
            tasks.push({
                id,
                kind: 'agent',
                title: meta.title ?? meta.agent ?? id,
                agent: meta.agent,
                status: ended?.status ?? 'running',
                startedAt: iso(firstAt),
                endedAt: iso(ended?.at ?? null)
            })
        }
        return tasks
    }
}


/**
 * Claude's own count under its input box decides what still runs (it is what the person sees): with the
 * turn at rest, running tasks beyond that count are the oldest of their kind left by a Claude process
 * that ended (a resumed session reads the same transcript) and are `lost`. While a turn works a
 * synchronous subagent runs that the count leaves out, so the transcript stands then (`cap` false).
 * `moreRunning`: what the count holds that the transcript does not show yet.
 */
export function settleBackground(tasks: BackgroundTask[], count: { shells: number; agents: number } | null, cap: boolean): { tasks: BackgroundTask[]; moreRunning: number } {
    const counted = count ?? { shells: 0, agents: 0 }
    let moreRunning = 0
    const lost = new Set<string>()
    for (const kind of ['shell', 'agent'] as const) {
        const running = tasks.filter((task) => task.kind === kind && task.status === 'running')
        const shown = kind === 'shell' ? counted.shells : counted.agents
        moreRunning += Math.max(0, shown - running.length)
        if (cap && running.length > shown) for (const task of running.slice(0, running.length - shown)) lost.add(`${kind}:${task.id}`)
    }
    if (lost.size === 0) return { tasks, moreRunning }
    const settled = tasks.map((task) => (lost.has(`${task.kind}:${task.id}`) ? { ...task, status: 'lost' as const } : task))
    const time = (value: string | null): number => (value === null ? 0 : Date.parse(value) || 0)
    const running = settled.filter((task) => task.status === 'running')
    const ended = settled.filter((task) => task.status !== 'running').sort((a, b) => (time(b.endedAt) || time(b.startedAt)) - (time(a.endedAt) || time(a.startedAt)))
    return { tasks: [...running, ...ended.slice(0, RECENT_LIMIT)], moreRunning }
}
