import { useEffect, useState } from 'react'
import { SessionPeek } from '../../../shared/types'

/** Often enough that "Working" turns into "Waiting for you" while the dialog is open. */
const PEEK_INTERVAL_MS = 2000

/** State and last line of each session, refreshed while the caller is mounted. */
export function useSessionPeeks(sessionIds: string[]): Map<string, SessionPeek> {
    const [peeks, setPeeks] = useState<Map<string, SessionPeek>>(new Map())
    const key = sessionIds.join(',')

    useEffect(() => {
        if (sessionIds.length === 0) {
            setPeeks(new Map())
            return
        }
        let cancelled = false
        const load = (): void => {
            window.api.peekSessions(sessionIds)
                .then(list => {
                    if (!cancelled) setPeeks(new Map(list.map(peek => [peek.sessionId, peek])))
                })
                .catch(() => {})
        }
        load()
        const timer = setInterval(load, PEEK_INTERVAL_MS)
        return () => {
            cancelled = true
            clearInterval(timer)
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key])

    return peeks
}
