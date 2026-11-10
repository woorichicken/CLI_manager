// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: src/components/BackgroundTasks.tsx — the chip that opens the list of what runs now, read
// again every POLL_MS while open, what ended folded into one «N recently ended» line. Not ported: the
// plan part (our PlanChip), OmO workflows, a running agent's detail sheet, turns · tool calls · tokens.
import { useEffect, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleDot, CircleSlash, CircleX, SquareTerminal } from 'lucide-react'
import type { BackgroundTask, BackgroundTaskList, ChatTransport, ConversationMeta } from '../../../../shared/conversation'
import { formatElapsed } from './chatLib'
import { Popover } from './ComposerChips'

/** ovis POLL_MS: the list is read again this often while it is open */
const POLL_MS = 3000

const STATUS_ICONS = { running: CircleDot, completed: CircleCheck, failed: CircleX, cancelled: CircleSlash, lost: CircleAlert } as const
const STATUS_WORDS: Record<BackgroundTask['status'], string> = { running: 'running', completed: 'done', failed: 'failed', cancelled: 'stopped', lost: 'lost' }

/** «1 shell · 1 agent», the words of the count under Claude's input box. */
export function backgroundWords(background: { shells: number; agents: number }): string {
    return [
        background.shells > 0 ? `${background.shells} ${background.shells === 1 ? 'shell' : 'shells'}` : null,
        background.agents > 0 ? `${background.agents} ${background.agents === 1 ? 'agent' : 'agents'}` : null
    ]
        .filter(Boolean)
        .join(' · ')
}

/**
 * The background count under the message box (a0ba98c4). Pressed, it opens what runs: each command
 * and subagent with its kind and how long it has run, then what ended, folded (ovis BackgroundTasks).
 */
export function BackgroundChip({ meta, transport, sessionId }: { meta: ConversationMeta | null; transport: ChatTransport; sessionId: string }) {
    const [open, setOpen] = useState(false)
    const [list, setList] = useState<BackgroundTaskList | null>(null)
    const [failed, setFailed] = useState(false)
    /** the Mac's clock minus this one's: a phone's clock may differ */
    const [offset, setOffset] = useState(0)
    const [now, setNow] = useState(() => Date.now())
    const [showEnded, setShowEnded] = useState(false)
    const background = meta?.background

    // closed, the list forgets what was opened: it opens on what runs now every time (ovis)
    useEffect(() => {
        if (!open) setShowEnded(false)
    }, [open])
    // another session's list is another list
    useEffect(() => {
        setOpen(false)
        setList(null)
    }, [sessionId])
    useEffect(() => {
        if (!open) return
        let alive = true
        let timer: ReturnType<typeof setTimeout> | undefined
        const load = async (): Promise<void> => {
            try {
                const next = await transport.listBackgroundTasks(sessionId)
                if (!alive) return
                const received = Date.now()
                setList(next)
                setFailed(false)
                setOffset(Date.parse(next.serverTime) - received || 0)
                setNow(received)
            } catch {
                if (alive) setFailed(true)
            }
            if (alive) timer = setTimeout(() => void load(), POLL_MS)
        }
        void load()
        // the elapsed time moves between reads
        const tick = setInterval(() => setNow(Date.now()), 1000)
        return () => {
            alive = false
            clearTimeout(timer)
            clearInterval(tick)
        }
    }, [open, transport, sessionId])

    if (!background) return null
    const words = backgroundWords(background)
    const running = list?.tasks.filter((task) => task.status === 'running') ?? []
    const ended = list?.tasks.filter((task) => task.status !== 'running') ?? []
    const endedFailed = ended.filter((task) => task.status === 'failed' || task.status === 'lost').length

    const row = (task: BackgroundTask) => {
        const Icon = STATUS_ICONS[task.status]
        const KindIcon = task.kind === 'shell' ? SquareTerminal : Bot
        const started = task.startedAt === null ? null : Date.parse(task.startedAt)
        const until = task.endedAt === null ? (task.status === 'running' ? now + offset : null) : Date.parse(task.endedAt)
        const elapsed = started === null || until === null ? null : Math.max(0, until - started)
        const meta = [
            task.status !== 'running' && task.status !== 'completed' ? STATUS_WORDS[task.status] : null,
            task.kind === 'shell' ? 'shell' : (task.agent ?? 'agent'),
            elapsed === null ? null : formatElapsed(elapsed)
        ]
            .filter(Boolean)
            .join(' · ')
        return (
            <li key={`${task.kind}:${task.id}`} className={`chat-bg-task is-${task.status}`} data-testid="chat-background-task" data-kind={task.kind} data-status={task.status}>
                <Icon size={13} className="chat-bg-task-icon" role="img" aria-label={STATUS_WORDS[task.status]} />
                <span className="chat-bg-task-main">
                    <span className="chat-bg-task-title">
                        <KindIcon size={12} aria-hidden="true" /> {task.title}
                    </span>
                    <span className="chat-bg-task-meta">{meta}</span>
                </span>
            </li>
        )
    }

    return (
        <span className="chat-chip-anchor">
            <button
                type="button"
                className="chat-meta-chip chat-background-chip"
                data-testid="chat-background-chip"
                title={`Running in the background: ${words}`}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                {words}
            </button>
            <Popover open={open} onClose={() => setOpen(false)} testId="chat-background-panel">
                <div className="chat-bg-tasks">
                    <p className="chat-menu-caption">Background tasks</p>
                    {list === null && !failed && <p className="chat-bg-note">Loading…</p>}
                    {failed && list === null && <p className="chat-bg-note">Couldn't load the background tasks</p>}
                    {failed && list !== null && (
                        <p className="chat-bg-note" role="status">
                            Couldn't refresh: this is the list as it last read
                        </p>
                    )}
                    {list !== null && list.tasks.length === 0 && list.moreRunning === 0 && <p className="chat-bg-note">No background tasks to show yet</p>}
                    {running.length > 0 && <ul className="chat-bg-list" data-testid="chat-background-running">{running.map(row)}</ul>}
                    {list !== null && list.moreRunning > 0 && <p className="chat-bg-note">{list.moreRunning} more running — not in the transcript yet</p>}
                    {list !== null && running.length === 0 && list.moreRunning === 0 && ended.length > 0 && <p className="chat-bg-note">Nothing running right now</p>}
                    {ended.length > 0 && (
                        <>
                            <button type="button" className="chat-bg-ended-toggle" data-testid="chat-background-ended-toggle" aria-expanded={showEnded} onClick={() => setShowEnded(!showEnded)}>
                                {showEnded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                                <span>{ended.length} recently ended</span>
                                {endedFailed > 0 && <span className="chat-bg-ended-failed">{endedFailed} failed</span>}
                            </button>
                            <ul className="chat-bg-list" data-testid="chat-background-ended" hidden={!showEnded}>
                                {ended.map(row)}
                            </ul>
                        </>
                    )}
                    <p className="chat-bg-note is-hint">↓ in the terminal manages them</p>
                </div>
            </Popover>
        </span>
    )
}
