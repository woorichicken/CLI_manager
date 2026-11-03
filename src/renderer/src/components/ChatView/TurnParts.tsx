import { memo, useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight, Image as ImageIcon, Layers, Terminal as TerminalIcon } from 'lucide-react'
import type { ConversationPart, TaskResult } from '../../../../shared/conversation'
import { Markdown } from './markdown/Markdown'

/** What the person's seat holds: their words, a `!` command, a notice, a subagent's result. */
export const UserParts = memo(function UserParts({ parts }: { parts: ConversationPart[] }) {
    const skills = parts.filter((part): part is Extract<ConversationPart, { kind: 'skill' }> => part.kind === 'skill')
    return (
        <>
            {parts.map((part, index) => {
                switch (part.kind) {
                    case 'text':
                        return (
                            <div key={index} className="chat-user-bubble" data-testid="chat-user-text">
                                {part.text}
                            </div>
                        )
                    case 'image':
                        return (
                            <div key={index} className="chat-chip">
                                <ImageIcon size={12} aria-hidden="true" /> Image
                            </div>
                        )
                    case 'shell':
                        return (
                            <div key={index} className="chat-shell">
                                <div className="chat-shell-command">
                                    <TerminalIcon size={12} aria-hidden="true" /> {part.command}
                                </div>
                                {(part.stdout || part.stderr) && (
                                    <pre className="chat-tool-pre">{[part.stdout, part.stderr].filter(Boolean).join('\n')}</pre>
                                )}
                            </div>
                        )
                    case 'notice':
                        return (
                            <div key={index} className="chat-notice" data-testid="chat-notice">
                                <span className="chat-notice-source">{noticeSource(part.source)}</span>
                                <Markdown>{part.text}</Markdown>
                            </div>
                        )
                    case 'compact':
                        return <CompactNote key={index} text={part.text} />
                    case 'task_result':
                        return <TaskResultCard key={index} tasks={part.tasks} />
                    default:
                        return null
                }
            })}
            {skills.length > 0 && (
                <div className="chat-user-skills">
                    {skills.map((part, index) => (
                        <span key={index} className="chat-chip">
                            <BookOpen size={11} aria-hidden="true" /> {part.skill.name}
                        </span>
                    ))}
                </div>
            )}
        </>
    )
})

function noticeSource(source: string | undefined): string {
    if (!source) return 'Notice'
    if (source === 'local-command') return 'Command output'
    if (source === 'informational') return 'Claude Code'
    if (source.startsWith('peer:')) return source.length > 5 ? `From ${source.slice(5)}` : 'From another session'
    return source
}

function CompactNote({ text }: { text: string }) {
    const [open, setOpen] = useState(false)
    return (
        <div className="chat-compact" data-testid="chat-compact">
            <button type="button" className="chat-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
                <Layers size={12} aria-hidden="true" />
                <span>Conversation compacted — earlier turns are summed up here</span>
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {open && <Markdown className="chat-md-small">{text}</Markdown>}
        </div>
    )
}

export function TaskResultCard({ tasks }: { tasks: TaskResult[] }) {
    return (
        <div className="chat-task-results">
            {tasks.map((task) => (
                <TaskResultRow key={task.id} task={task} />
            ))}
        </div>
    )
}

function TaskResultRow({ task }: { task: TaskResult }) {
    const [open, setOpen] = useState(false)
    const tone = task.status === 'completed' ? 'text-emerald-300' : task.status === 'failed' ? 'text-red-300' : 'text-gray-400'
    return (
        <div className="chat-task" data-testid="chat-task-result">
            <button type="button" className="chat-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="chat-tool-name">{task.title}</span>
                <span className={`text-[11px] ${tone}`}>{task.status}</span>
            </button>
            {open && task.result && <Markdown className="chat-md-small">{task.result}</Markdown>}
        </div>
    )
}
