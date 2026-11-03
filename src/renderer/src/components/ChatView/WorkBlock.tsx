import { memo, useState } from 'react'
import { AlertCircle, BookOpen, Brain, ChevronDown, ChevronRight, Loader2, Wrench } from 'lucide-react'
import type { ConversationPart, ToolPart } from '../../../../shared/conversation'
import { formatWorkDuration, workFailed, workSummary } from './workBlocks'
import { Markdown } from './markdown/Markdown'
import { TaskResultCard } from './TurnParts'

/**
 * One run of an assistant turn's work — tool calls, reasoning, progress words —
 * folded under a "Worked for 12s · 2 edits · 1 command" row, the way ovis (and
 * the Codex app) draws it. Open while the turn runs; folded once it settles.
 */
export const WorkBlock = memo(function WorkBlock({
    parts,
    live,
    startsOpen,
    startTs,
    endTs
}: {
    parts: ConversationPart[]
    live: boolean
    startsOpen: boolean
    startTs: string | null
    endTs?: string
}) {
    const [open, setOpen] = useState<boolean | null>(null)
    const isOpen = open ?? startsOpen
    const failed = workFailed(parts)
    const duration = live ? null : formatWorkDuration(startTs, endTs)
    const summary = workSummary(parts)
    const head = live ? 'Working…' : duration ? `Worked for ${duration}` : 'Worked'
    const visible = parts.filter((part) => part.kind !== 'skill')
    return (
        <div className="chat-work" data-testid="chat-work-block" data-open={isOpen ? 'true' : 'false'}>
            <button type="button" className="chat-work-head" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {live && <Loader2 size={12} className="animate-spin text-blue-300" aria-hidden="true" />}
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

function WorkPart({ part }: { part: ConversationPart }) {
    switch (part.kind) {
        case 'tool':
            return <ToolRow tool={part} />
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
            <button type="button" className="chat-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
                <Brain size={12} aria-hidden="true" />
                <span className="chat-tool-name">Thinking</span>
            </button>
            {open && <pre className="chat-tool-pre">{text}</pre>}
        </div>
    )
}

const ToolRow = memo(function ToolRow({ tool }: { tool: ToolPart }) {
    const [open, setOpen] = useState(false)
    const pending = tool.state === 'pending'
    const Icon = tool.skill ? BookOpen : Wrench
    return (
        <div className="chat-tool" data-testid="chat-tool" data-tool={tool.name} data-error={tool.error ? 'true' : undefined}>
            <button type="button" className="chat-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
                {pending ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Icon size={12} aria-hidden="true" />}
                <span className="chat-tool-name">{tool.name}</span>
                {tool.summary && tool.summary !== tool.name && <span className="chat-tool-summary">{tool.summary}</span>}
                {tool.error && <AlertCircle size={12} className="text-red-400 shrink-0" aria-label="Failed" />}
            </button>
            {open && (
                <div className="chat-tool-detail">
                    {tool.input && tool.input !== '{}' && <pre className="chat-tool-pre">{tool.input}</pre>}
                    {tool.output && <pre className={`chat-tool-pre${tool.error ? ' is-error' : ''}`}>{tool.output}</pre>}
                    {tool.output_size !== undefined && (
                        <p className="chat-tool-note">Output cut — {tool.output_size.toLocaleString()} characters in all. See the terminal for the rest.</p>
                    )}
                    {tool.images && tool.images.length > 0 && (
                        <p className="chat-tool-note">{tool.images.length === 1 ? '1 image' : `${tool.images.length} images`} (not shown here)</p>
                    )}
                </div>
            )}
        </div>
    )
})
