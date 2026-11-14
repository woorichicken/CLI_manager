import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { MessagesSquare } from 'lucide-react'
import type { ChatThread } from '../../../../shared/conversation'
import { threadStatus } from './threadTurns'

const TIME_REFRESH_MS = 30_000
const STATUS_WORDS: Record<ChatThread['status'], string> = { working: 'working', waiting: 'waiting for you', idle: 'idle' }

function activityTime(at: number, now: number): string {
    const seconds = Math.max(0, Math.floor((now - at) / 1000))
    if (seconds < 60) return 'just now'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** One reply's branches; a single thread opens directly, several offer a small list. */
export function ThreadChip({ threads, onOpen }: { threads: ChatThread[]; onOpen: (childId: string) => void }) {
    const [open, setOpen] = useState(false)
    const [now, setNow] = useState(Date.now)
    const anchor = useRef<HTMLDivElement>(null)
    const panel = useRef<HTMLDivElement>(null)
    const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
    const host = open ? anchor.current?.closest<HTMLElement>('.chat-view') : null
    // Answers can sit at either edge of the scroller. Portal into the view so its scroll
    // clipping cannot hide the list, while retaining that view's theme and stacking order.
    useLayoutEffect(() => {
        if (!open || !host) return
        const place = (): void => {
            const button = anchor.current?.getBoundingClientRect()
            const bounds = host.getBoundingClientRect()
            if (!button) return
            const width = Math.min(340, Math.max(0, bounds.width - 16))
            const height = Math.min(panel.current?.scrollHeight ?? 320, 320, Math.max(0, bounds.height - 16))
            const below = button.bottom - bounds.top + 6
            const preferred = below + height <= bounds.height - 8 ? below : button.top - bounds.top - height - 6
            setPosition({
                left: Math.max(8, Math.min(button.left - bounds.left, bounds.width - width - 8)),
                top: Math.max(8, Math.min(preferred, bounds.height - height - 8)),
                width,
                maxHeight: Math.min(320, Math.max(0, bounds.height - 16)),
                visibility: 'visible'
            })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
            window.removeEventListener('resize', place)
            window.removeEventListener('scroll', place, true)
        }
    }, [open, host, threads])
    useEffect(() => {
        if (!open) return
        const outside = (event: MouseEvent): void => {
            if (!anchor.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false)
        }
        const escape = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
            anchor.current?.querySelector('button')?.focus()
        }
        panel.current?.querySelector('button')?.focus()
        window.addEventListener('mousedown', outside, true)
        window.addEventListener('keydown', escape, true)
        return () => {
            window.removeEventListener('mousedown', outside, true)
            window.removeEventListener('keydown', escape, true)
        }
    }, [open])
    useEffect(() => {
        const tick = window.setInterval(() => setNow(Date.now()), TIME_REFRESH_MS)
        return () => window.clearInterval(tick)
    }, [])
    useEffect(() => {
        if (threads.length < 2) setOpen(false)
    }, [threads.length])

    const newest = Math.max(...threads.map((thread) => thread.lastActivityAt))
    const priority = threadStatus(threads)
    const active = (['waiting', 'working'] as const).filter((state) => threads.some((thread) => thread.status === state))
    const status = active.length ? active.map((state) => STATUS_WORDS[state]).join(' · ') : STATUS_WORDS.idle
    return (
        <div className="chat-chip-anchor chat-thread-anchor" ref={anchor}>
            <button
                type="button"
                className="chat-meta-chip chat-thread-chip"
                data-testid="chat-thread-chip"
                aria-label={`Open ${threads.length} ${threads.length === 1 ? 'thread' : 'threads'}`}
                aria-expanded={threads.length > 1 ? open : undefined}
                onClick={() => threads.length === 1 ? onOpen(threads[0].childId) : setOpen(!open)}
            >
                <MessagesSquare size={13} aria-hidden="true" />
                <span className="chat-thread-status-dot" data-testid="chat-thread-status-dot" data-status={priority} aria-hidden="true" />
                <span>{threads.length} {threads.length === 1 ? 'thread' : 'threads'} · {activityTime(newest, now)} · {status}</span>
            </button>
            {open && host && createPortal(<div className="chat-popover chat-thread-list" ref={panel} style={position} role="dialog" aria-label="Threads from this reply" data-testid="chat-thread-list">
                <div className="chat-menu-list" aria-label="Threads from this reply">
                    {threads.map((thread) => (
                        <button
                            key={thread.childId}
                            type="button"
                            className="chat-menu-item chat-thread-session"
                            data-testid="chat-thread-session"
                            data-child-id={thread.childId}
                            onClick={() => { setOpen(false); onOpen(thread.childId) }}
                        >
                            <span className="chat-thread-row-heading">
                                <span className="chat-thread-status-dot" data-testid="chat-thread-status-dot" data-status={thread.status} aria-hidden="true" />
                                <span className="chat-thread-name">{thread.name}</span>
                            </span>
                            <span className="chat-menu-note">{STATUS_WORDS[thread.status]} · {activityTime(thread.lastActivityAt, now)}</span>
                        </button>
                    ))}
                </div>
            </div>, host)}
        </div>
    )
}
