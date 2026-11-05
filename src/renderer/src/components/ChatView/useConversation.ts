import { useEffect, useRef, useState } from 'react'
import type { ChatTransport, ConversationSnapshot } from '../../../../shared/conversation'
import { CHAT_TURN_LIMIT } from '../../../../shared/conversation'

/**
 * The session's conversation through the transport: one fetch on mount, then
 * one per change notice. Notices that arrive while a fetch is in flight fold
 * into one more fetch after it, so a busy turn never queues dozens of reads.
 */
export function useConversation(transport: ChatTransport, sessionId: string, limit: number = CHAT_TURN_LIMIT): {
    snapshot: ConversationSnapshot | null
    refresh: () => void
} {
    const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null)
    const state = useRef({ inFlight: false, again: false, live: true })
    const refreshRef = useRef<() => void>(() => {})

    useEffect(() => {
        const local = { inFlight: false, again: false, live: true }
        state.current = local
        const fetchNow = (): void => {
            if (local.inFlight) {
                local.again = true
                return
            }
            local.inFlight = true
            transport
                .getConversation(sessionId, limit)
                .then((next) => {
                    if (local.live) setSnapshot(next)
                })
                .catch((error) => console.error('[chat] conversation read failed', error))
                .finally(() => {
                    local.inFlight = false
                    if (local.again && local.live) {
                        local.again = false
                        fetchNow()
                    }
                })
        }
        refreshRef.current = fetchNow
        const unsubscribe = transport.subscribe(sessionId, () => fetchNow())
        fetchNow()
        return () => {
            local.live = false
            unsubscribe()
        }
    }, [transport, sessionId, limit])

    // a different session starts empty; a longer limit keeps the turns on screen until the next read
    useEffect(() => setSnapshot(null), [transport, sessionId])

    return { snapshot, refresh: () => refreshRef.current() }
}
