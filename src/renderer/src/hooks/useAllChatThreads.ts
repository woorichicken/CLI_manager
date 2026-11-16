import { useEffect, useState } from 'react'
import type { ChatThreadEntry } from '../../../shared/conversation'

/**
 * Every parent's threads for the sidebar's Threads list.
 *
 * Off (another sidebar view): no reads. Open: main widens its 1s thread watch to every anchored parent and says when the list changed;
 * rows carry their parent quote. Closed: no watch at all (the spec's "no extra cost") — one read
 * without quotes (statuses only, no transcript reads) when the view shows, when `refreshKey` changes
 * and when the window comes back to the front, for the icon's waiting count. Between those reads the
 * count can lag a question asked meanwhile; opening the list makes it live.
 */
export function useAllChatThreads(mode: 'off' | 'closed' | 'open', refreshKey: unknown): ChatThreadEntry[] {
    const [threads, setThreads] = useState<ChatThreadEntry[]>([])
    const open = mode === 'open'
    const off = mode === 'off'
    useEffect(() => {
        // Not in All sessions: nothing shows the list or its badge, so nothing is read.
        if (off) {
            setThreads([])
            return
        }
        let alive = true
        let revision = 0
        const load = (): void => {
            const requested = ++revision
            window.api.getAllChatThreads(open).then((next) => {
                if (alive && requested === revision) setThreads(next)
            }).catch(() => {})
        }
        if (!open) {
            // Coming back to the window is the moment a stale count would be noticed.
            window.addEventListener('focus', load)
            load()
            return () => {
                alive = false
                window.removeEventListener('focus', load)
            }
        }
        const stop = window.api.onAllChatThreadsChanged(load)
        void window.api.subscribeAllChatThreads()
        load()
        return () => {
            alive = false
            stop()
            void window.api.unsubscribeAllChatThreads()
        }
    }, [open, off, open ? null : refreshKey])
    return threads
}
