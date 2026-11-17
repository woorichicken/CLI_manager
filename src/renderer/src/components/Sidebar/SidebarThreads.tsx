import { useEffect, useState } from 'react'
import type { ChatThread, ChatThreadEntry } from '../../../../shared/conversation'

const TIME_REFRESH_MS = 30_000
const STATUS_WORDS: Partial<Record<ChatThread['status'], string>> = { waiting: 'Waiting for you', working: 'Working' }
const DOT_CLASSES: Record<ChatThread['status'], string> = {
    waiting: 'bg-amber-500 border-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.2)]',
    working: 'bg-blue-500 border-blue-500',
    idle: 'bg-transparent border-gray-500'
}
const STATUS_TEXT_CLASSES: Partial<Record<ChatThread['status'], string>> = { waiting: 'text-amber-400', working: 'text-blue-400' }

/** Compact for a narrow row: "now", "5m", "2h", "3d". */
function shortActivityTime(at: number, now: number): string {
    const minutes = Math.floor(Math.max(0, now - at) / 60_000)
    if (minutes < 1) return 'now'
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

interface SidebarThreadsProps {
    threads: ChatThreadEntry[]
    /** the row last opened from here; drawn selected while its parent is the session on screen */
    selectedChildId: string | null
    activeSessionId?: string
    onOpen: (thread: ChatThreadEntry) => void
}

/**
 * All sessions › Threads: every reply's thread in the app, newest activity first (the order main
 * gives — opening a row adds no output, so the rows stay put). Unread marks are not part of v1.
 */
export function SidebarThreads({ threads, selectedChildId, activeSessionId, onOpen }: SidebarThreadsProps) {
    const [now, setNow] = useState(Date.now)
    useEffect(() => {
        const tick = window.setInterval(() => setNow(Date.now()), TIME_REFRESH_MS)
        return () => window.clearInterval(tick)
    }, [])
    if (threads.length === 0) {
        return <div className="px-2 py-3 text-xs text-gray-500" data-testid="sidebar-threads-empty">No threads yet — use Reply in thread on an answer</div>
    }
    return (
        <div className="space-y-0.5" data-testid="sidebar-threads" role="list" aria-label="Threads">
            {threads.map((thread) => {
                const selected = thread.childId === selectedChildId && thread.parentId === activeSessionId
                const statusWord = STATUS_WORDS[thread.status]
                const where = thread.workspaceName ? `${thread.parentName} · ${thread.workspaceName}` : thread.parentName
                return (
                    <button
                        key={thread.childId}
                        type="button"
                        role="listitem"
                        data-testid="sidebar-thread-row"
                        data-child-id={thread.childId}
                        data-parent-id={thread.parentId}
                        data-status={thread.status}
                        data-selected={selected ? 'true' : undefined}
                        aria-current={selected ? 'true' : undefined}
                        onClick={() => onOpen(thread)}
                        className={`w-full min-w-0 text-left px-2 py-1.5 rounded-md transition-colors ${
                            selected ? 'bg-blue-500/20' : 'hover:bg-white/5'
                        }`}
                    >
                        <span className="flex items-center gap-[7px] min-w-0">
                            <span
                                data-testid="sidebar-thread-dot"
                                data-status={thread.status}
                                aria-hidden="true"
                                className={`shrink-0 w-2 h-2 rounded-full border ${DOT_CLASSES[thread.status]}`}
                            />
                            <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-gray-200" title={thread.name}>{thread.name}</span>
                            <span className="shrink-0 text-[11px] text-gray-500" data-testid="sidebar-thread-time" title={new Date(thread.lastActivityAt).toLocaleString()}>
                                {shortActivityTime(thread.lastActivityAt, now)}
                            </span>
                        </span>
                        <span className="block truncate text-[11px] text-gray-500 mt-0.5 ml-[15px]" data-testid="sidebar-thread-parent" title={where}>in {where}</span>
                        {thread.quote && (
                            <span
                                className="block ml-[15px] mt-1 pl-2 border-l-2 border-white/10 text-[11.5px] leading-snug text-gray-400 line-clamp-2 break-words"
                                data-testid="sidebar-thread-quote"
                            >
                                {thread.quote}
                            </span>
                        )}
                        {statusWord && (
                            <span className={`block ml-[15px] mt-1 text-[10.5px] ${STATUS_TEXT_CLASSES[thread.status] ?? ''}`} data-testid="sidebar-thread-status">
                                {statusWord}
                            </span>
                        )}
                    </button>
                )
            })}
        </div>
    )
}
