import { useEffect, useState } from 'react'
import type { ChatThreadEntry } from '../../../shared/conversation'

export type ThreadListMode = 'off' | 'closed' | 'open'

/**
 * What each mode reads. Closed is when the icon's badge matters most, so it is live too (one tick
 * 0.02ms at 40 sessions / 20 threads, T144) — only without the quotes, which read transcripts.
 * Off (Folders view, or the sidebar closed and unmounted) reads nothing.
 */
export function threadListReads(mode: ThreadListMode): { watch: boolean; quotes: boolean } {
    return { watch: mode !== 'off', quotes: mode === 'open' }
}

/**
 * Every parent's threads for the sidebar's Threads list. While watching, main widens its 1s thread
 * tick to every anchored parent and says when the list changed; the rows are read again then.
 */
export function useAllChatThreads(mode: ThreadListMode): ChatThreadEntry[] {
    const [threads, setThreads] = useState<ChatThreadEntry[]>([])
    const { watch, quotes } = threadListReads(mode)
    useEffect(() => {
        if (!watch) {
            setThreads([])
            return
        }
        let alive = true
        let revision = 0
        const load = (): void => {
            const requested = ++revision
            window.api.getAllChatThreads(quotes).then((next) => {
                if (alive && requested === revision) setThreads(next)
            }).catch(() => {})
        }
        const stop = window.api.onAllChatThreadsChanged(load)
        void window.api.subscribeAllChatThreads()
        load()
        return () => {
            alive = false
            stop()
            void window.api.unsubscribeAllChatThreads()
        }
    }, [watch, quotes])
    return threads
}
