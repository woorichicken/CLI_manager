import { memo, useEffect, useMemo, useState } from 'react'
import { AlertCircle, BookOpen, Brain, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleDot, ExternalLink, ListChecks, Loader2, Wrench } from 'lucide-react'
import type { ConversationPart, ToolPart } from '../../../../shared/conversation'
import { formatWorkDuration, workFailed, workSummary } from './workBlocks'
import { LinkedText, Markdown } from './markdown/Markdown'
import { TaskResultCard } from './TurnParts'
import { ChatImageStrip } from './ChatImages'
import { useChatActions } from './chatContext'
import { formatElapsed, isTodoTool, lineDiff, todoProgress, todoSnapshot, type DiffLine, type TodoItem } from './chatLib'

/**
 * One run of an assistant turn's work — tool calls, reasoning, progress words —
 * folded under a "Worked for 12s · 2 edits · 1 command" row, the way ovis (and
 * the Codex app) draws it. Open while the turn runs; folded once it settles.
 */
export const WorkBlock = memo(function WorkBlock({
    parts,
    live,
    waiting = false,
    startsOpen,
    startTs,
    endTs
}: {
    parts: ConversationPart[]
    live: boolean
    /** the agent stopped on a question (the card below): not "working" */
    waiting?: boolean
    startsOpen: boolean
    startTs: string | null
    endTs?: string
}) {
    const [open, setOpen] = useState<boolean | null>(null)
    const isOpen = open ?? startsOpen
    const failed = workFailed(parts)
    const duration = live ? null : formatWorkDuration(startTs, endTs)
    const summary = workSummary(parts)
    const elapsed = useElapsed(live && !waiting ? startTs : null)
    const head = waiting ? 'Waiting for your answer' : live ? `Working…${elapsed ? ` ${elapsed}` : ''}` : duration ? `Worked for ${duration}` : 'Worked'
    const visible = parts.filter((part) => part.kind !== 'skill')
    return (
        <div className="chat-work" data-testid="chat-work-block" data-open={isOpen ? 'true' : 'false'}>
            <button type="button" className="chat-work-head" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {live && !waiting && <Loader2 size={12} className="animate-spin text-blue-300" aria-hidden="true" />}
                <span className="chat-work-title">{head}</span>
                {summary && <span className="chat-work-summary">· {summary}</span>}
                {failed > 0 && (
                    <span className="chat-work-failed">
                        <AlertCircle size={11} aria-hidden="true" /> {failed} failed
                    </span>
                )}
            </button>
            {isOpen && (
                <div className="chat-work-body">
                    {visible.map((part, index) => (
                        <WorkPart key={index} part={part} />
                    ))}
                </div>
            )}
        </div>
    )
})

/** Seconds since `since` (an ISO time), ticking once a second; null when `since` is null. */
export function useElapsed(since: string | null): string | null {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!since) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [since])
    if (!since) return null
    const start = Date.parse(since)
    return Number.isFinite(start) ? formatElapsed(now - start) : null
}

function WorkPart({ part }: { part: ConversationPart }) {
    switch (part.kind) {
        case 'tool':
            return isTodoTool(part.name) ? <TodoRow tool={part} /> : <ToolRow tool={part} />
        case 'thinking':
            return <ThinkingRow text={part.text} />
        case 'text':
            return <Markdown className="chat-md-commentary">{part.text}</Markdown>
        case 'task_result':
            return <TaskResultCard tasks={part.tasks} />
        case 'notice':
            return <div className="chat-work-notice">{part.text}</div>
        default:
            return null
    }
}

function ThinkingRow({ text }: { text: string }) {
    const [open, setOpen] = useState(false)
    return (
        <div className="chat-tool">
            <div className="chat-tool-head">
                <button type="button" className="chat-tool-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
                    <Brain size={12} aria-hidden="true" />
                    <span className="chat-tool-name">Thinking</span>
                </button>
            </div>
            {open && <pre className="chat-tool-pre">{text}</pre>}
        </div>
    )
}

const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

function parseInput(tool: ToolPart): Record<string, unknown> {
    try {
        return record(JSON.parse(tool.input))
    } catch {
        return {}
    }
}

/** The file a tool call read or wrote, when it names one. */
function toolFile(tool: ToolPart, input: Record<string, unknown>): string | null {
    const path = input.file_path ?? input.notebook_path ?? (tool.name === 'view_image' ? input.path : undefined)
    return typeof path === 'string' && path.trim() ? path : null
}

/** What an edit tool changed, as +/− lines (Edit · MultiEdit · Write), or a patch's own lines (Codex apply_patch). */
function toolChanges(tool: ToolPart, input: Record<string, unknown>): DiffLine[] | null {
    const edits: { old_string?: unknown; new_string?: unknown }[] =
        tool.name === 'Edit' ? [input] : tool.name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits.map(record) : []
    if (edits.length > 0) {
        const lines: DiffLine[] = []
        for (const [index, edit] of edits.entries()) {
            if (typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') return null
            if (index > 0) lines.push({ kind: 'same', text: '⋯' })
            lines.push(...lineDiff(edit.old_string, edit.new_string))
        }
        return lines
    }
    if (tool.name === 'Write' && typeof input.content === 'string') return lineDiff('', input.content)
    const patch = tool.name === 'apply_patch' ? (typeof input.input === 'string' ? input.input : tool.input) : tool.input.startsWith('*** Begin Patch') ? tool.input : null
    if (patch) {
        return patch.split('\n').map((line) => ({
            kind: line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'same',
            text: line
        }))
    }
    return null
}

/** A diff past this many lines shows its start and a count. */
const DIFF_LINES_SHOWN = 400

function DiffView({ lines }: { lines: DiffLine[] }) {
    const shown = lines.slice(0, DIFF_LINES_SHOWN)
    return (
        <div className="chat-diff" data-testid="chat-diff">
            {shown.map((line, index) => (
                <div key={index} className={`chat-diff-line is-${line.kind}`}>
                    <span className="chat-diff-sign" aria-hidden="true">
                        {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                    </span>
                    <span>{line.text || ' '}</span>
                </div>
            ))}
            {lines.length > shown.length && <div className="chat-tool-note">… {lines.length - shown.length} more lines</div>}
        </div>
    )
}

const ToolRow = memo(function ToolRow({ tool }: { tool: ToolPart }) {
    const actions = useChatActions()
    const [open, setOpen] = useState(false)
    const [whole, setWhole] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const pending = tool.state === 'pending'
    const Icon = tool.skill ? BookOpen : Wrench
    const input = useMemo(() => parseInput(tool), [tool])
    const file = toolFile(tool, input)
    const changes = useMemo(() => (open ? toolChanges(tool, input) : null), [open, tool, input])
    const outputRef = tool.output_ref ?? tool.call_id
    const showWhole = async (): Promise<void> => {
        if (!actions || !outputRef) return
        setLoading(true)
        const text = await actions.transport.getToolOutput(actions.sessionId, outputRef).catch(() => null)
        setLoading(false)
        setWhole(text ?? 'The whole output could not be read from the conversation file.')
    }
    const output = whole ?? tool.output
    return (
        <div className="chat-tool" data-testid="chat-tool" data-tool={tool.name} data-error={tool.error ? 'true' : undefined}>
            <div className="chat-tool-head">
                <button type="button" className="chat-tool-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
                    {pending ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Icon size={12} aria-hidden="true" />}
                    <span className="chat-tool-name">{tool.name}</span>
                    {tool.summary && tool.summary !== tool.name && <span className="chat-tool-summary">{tool.summary}</span>}
                    {tool.error && <AlertCircle size={12} className="text-red-400 shrink-0" aria-label="Failed" />}
                </button>
                {file && actions && (
                    <button type="button" className="chat-tool-open" title={`Open ${file}`} aria-label={`Open ${file}`} data-testid="chat-tool-open" onClick={() => actions.openPath(file)}>
                        <ExternalLink size={12} aria-hidden="true" />
                    </button>
                )}
            </div>
            {open && (
                <div className="chat-tool-detail">
                    {changes ? (
                        <DiffView lines={changes} />
                    ) : (
                        tool.input && tool.input !== '{}' && <pre className="chat-tool-pre">{tool.input}</pre>
                    )}
                    {output && (
                        <pre className={`chat-tool-pre${tool.error ? ' is-error' : ''}`} data-testid="chat-tool-output">
                            <LinkedText text={output} />
                        </pre>
                    )}
                    {tool.output_size !== undefined && whole === null && (
                        <p className="chat-tool-note">
                            Output cut — {tool.output_size.toLocaleString()} characters in all.{' '}
                            {actions && outputRef && (
                                <button type="button" className="chat-link-button" data-testid="chat-tool-whole" disabled={loading} onClick={() => void showWhole()}>
                                    {loading ? 'Reading…' : 'Show all'}
                                </button>
                            )}
                        </p>
                    )}
                    {tool.images && tool.images.length > 0 && <ChatImageStrip images={tool.images} label="Pictures from this tool" />}
                </div>
            )}
        </div>
    )
})

const TODO_ICONS = { completed: CheckCircle2, in_progress: CircleDot, pending: Circle } as const

/** A todo list (TodoWrite, update_plan) as its checklist, not its JSON. */
export function TodoList({ items }: { items: TodoItem[] }) {
    return (
        <ol className="chat-todos" data-testid="chat-todos">
            {items.map((item, index) => {
                const Icon = TODO_ICONS[item.status]
                return (
                    <li key={index} className={`chat-todo is-${item.status}`} data-status={item.status}>
                        <Icon size={13} aria-hidden="true" />
                        <span>{item.status === 'in_progress' && item.active ? item.active : item.label}</span>
                    </li>
                )
            })}
        </ol>
    )
}

const TodoRow = memo(function TodoRow({ tool }: { tool: ToolPart }) {
    const [open, setOpen] = useState(false)
    const items = useMemo(() => todoSnapshot(tool), [tool])
    if (!items) return <ToolRow tool={tool} />
    const { done, total, current } = todoProgress(items)
    return (
        <div className="chat-tool" data-testid="chat-tool" data-tool={tool.name}>
            <div className="chat-tool-head">
                <button type="button" className="chat-tool-toggle" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="chat-todo-head">
                    <ListChecks size={12} aria-hidden="true" />
                    <span className="chat-tool-name">Plan</span>
                    <span className="chat-tool-summary">
                        {done}/{total} done{current ? ` · ${current.active ?? current.label}` : ''}
                    </span>
                </button>
            </div>
            {open && <TodoList items={items} />}
        </div>
    )
})
