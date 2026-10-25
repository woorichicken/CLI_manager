import { useUnreadInboxFor } from '../../hooks/useInbox'

/**
 * Orange dot on a sidebar row whose session sent a request the user has not
 * seen yet, so "which session is waiting for me" shows without opening the inbox.
 */
export function InboxDot({ sessionId }: { sessionId: string }) {
    const unread = useUnreadInboxFor(sessionId)
    if (unread.length === 0) return null
    const latest = unread[0].text
    const title = unread.length === 1 ? `Waiting for you: ${latest}` : `${unread.length} requests waiting — latest: ${latest}`
    return (
        <span
            data-inbox-dot={sessionId}
            className="w-2 h-2 rounded-full bg-orange-400 ring-2 ring-orange-400/30 shrink-0"
            title={title}
        />
    )
}
