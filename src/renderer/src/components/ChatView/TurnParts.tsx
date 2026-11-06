import { memo, useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight, FileText, Image as ImageIcon, Layers, OctagonX, Terminal as TerminalIcon } from 'lucide-react'
import type { ConversationPart, TaskResult } from '../../../../shared/conversation'
import { LinkedText, Markdown } from './markdown/Markdown'
import { ChatImageStrip } from './ChatImages'
import { foldUserMessage, INTERRUPTED_TEXT, splitAppAttachments, type AppAttachmentMention } from './chatLib'
import { useChatActions } from './chatContext'

/** What the person's seat holds: their words, a `!` command, a notice, a subagent's result. */
export const UserParts = memo(function UserParts({ parts }: { parts: ConversationPart[] }) {
    const skills = parts.filter((part): part is Extract<ConversationPart, { kind: 'skill' }> => part.kind === 'skill')
    const images = parts.flatMap((part) => (part.kind === 'image' ? [{ ref: part.ref, media_type: part.media_type }] : []))
    return (
        <>
            {images.length > 0 && <ChatImageStrip images={images} label="Pictures in this message" />}
            {parts.map((part, index) => {
                switch (part.kind) {
                    case 'text':
                        // Claude Code writes this where the person stopped a turn: a marker, not a message
                        if (INTERRUPTED_TEXT.test(part.text.trim())) {
                            return (
                                <div key={index} className="chat-stopped" data-testid="chat-stopped">
                                    <OctagonX size={12} aria-hidden="true" /> Stopped
                                </div>
                            )
                        }
                        return <UserText key={index} text={part.text} />
                    case 'shell':
                        return (
                            <div key={index} className="chat-shell" data-testid="chat-shell">
                                <div className="chat-shell-command">
                                    <TerminalIcon size={12} aria-hidden="true" /> {part.command}
                                </div>
                                {part.stdout && <pre className="chat-tool-pre">{part.stdout}</pre>}
                                {part.stderr && (
                                    <pre className="chat-tool-pre is-error" data-testid="chat-shell-stderr">
                                        {part.stderr}
                                    </pre>
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

/** The person's words; a long message folds to its first lines and «… +N lines», as Claude Code's (bcbbbec5). */
function UserText({ text }: { text: string }) {
    const fold = foldUserMessage(text)
    const [open, setOpen] = useState(false)
    const shown = fold && !open ? fold.head : text
    return (
        <div className="chat-user-bubble" data-testid="chat-user-text">
            {splitAppAttachments(shown).map((part, index) =>
                typeof part === 'string' ? <LinkedText key={index} text={part} /> : <AttachmentChip key={index} attachment={part} />
            )}
            {fold && (
                <button type="button" className="chat-user-fold" data-testid="chat-user-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
                    {open ? 'Show less' : fold.hiddenLines > 0 ? `… +${fold.hiddenLines} lines` : 'Show full message'}
                </button>
            )}
        </div>
    )
}

/**
 * A file the person attached (G7): a chip with what it is, not the app's temporary path. It opens the
 * file where the chat can show files (the Mac's preview); elsewhere (the phone) it only says what it was.
 */
function AttachmentChip({ attachment }: { attachment: AppAttachmentMention }) {
    const actions = useChatActions()
    const Icon = attachment.image ? ImageIcon : FileText
    const label = attachment.image ? 'Attached image' : 'Attached file'
    const content = (
        <>
            <Icon size={12} aria-hidden="true" />
            <span>{label}</span>
            {attachment.extension && <span className="chat-attachment-chip-ext">{attachment.extension}</span>}
        </>
    )
    if (actions?.canOpenPaths) {
        return (
            <button type="button" className="chat-attachment-chip" data-testid="chat-attachment-chip" title={`Open ${attachment.path}`} onClick={() => actions.openPath(attachment.path)}>
                {content}
            </button>
        )
    }
    return (
        <span className="chat-attachment-chip" data-testid="chat-attachment-chip" title={attachment.path}>
            {content}
        </span>
    )
}

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
