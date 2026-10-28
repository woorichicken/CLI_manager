import { useCallback, useRef, useState } from 'react'
import { Bell } from 'lucide-react'
import clsx from 'clsx'
import { InboxRequest, Workspace } from '../../../../shared/types'
import { useInbox } from '../../hooks/useInbox'
import { InboxPopover } from './InboxPopover'
import { badgeText } from './inboxFormat'

interface InboxButtonProps {
    /** Where it sits: the sidebar header, or the main header while the sidebar is closed. */
    placement: 'sidebar' | 'header'
    workspaces: Workspace[]
    linkSchemes?: string[]
    /** Show the session a request came from (the same path as a session link). */
    onShowSession: (sessionId: string) => void
    /** Smaller, for the split-view header row. */
    compact?: boolean
}

/**
 * The inbox bell: unread count in red, and the request list below it. Opening a
 * request (or its link) only shows it; a request turns read when the user checks
 * it off or uses "Mark all read" — report b165acc4: reading on open hid what was
 * still to do.
 */
export function InboxButton({ placement, workspaces, linkSchemes, onShowSession, compact }: InboxButtonProps) {
    const requests = useInbox()
    const unread = requests.filter((r) => !r.readAt).length
    const buttonRef = useRef<HTMLButtonElement>(null)
    const [anchor, setAnchor] = useState<DOMRect | null>(null)

    const close = useCallback(() => setAnchor(null), [])
    const toggle = (): void => {
        if (anchor) return close()
        const rect = buttonRef.current?.getBoundingClientRect()
        if (rect) setAnchor(rect)
    }

    const openRequest = (request: InboxRequest): void => {
        close()
        onShowSession(request.sessionId)
    }

    const openLink = (request: InboxRequest): void => {
        if (!request.url) return
        void window.api.openExternal(request.url)
    }

    const iconSize = compact ? 13 : 14
    return (
        <>
            <button
                ref={buttonRef}
                data-testid="inbox-button"
                data-inbox-placement={placement}
                data-unread={unread}
                onClick={toggle}
                className={clsx(
                    'relative rounded transition-colors no-drag hover:bg-white/10',
                    compact ? 'p-0.5' : placement === 'header' ? 'p-1.5' : 'p-1',
                    anchor && 'bg-white/10'
                )}
                title={unread > 0 ? `Inbox — ${unread} unread request${unread === 1 ? '' : 's'}` : 'Inbox — no unread requests'}
            >
                <Bell size={iconSize} className={unread > 0 ? 'text-gray-200' : 'text-gray-500'} />
                {unread > 0 && (
                    <span
                        data-testid="inbox-count"
                        className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-[3px] rounded-full bg-red-500 text-[9px] leading-[14px] font-semibold text-white text-center"
                    >
                        {badgeText(unread)}
                    </span>
                )}
            </button>
            {anchor && (
                <InboxPopover
                    anchor={anchor}
                    requests={requests}
                    workspaces={workspaces}
                    linkSchemes={linkSchemes}
                    onOpenRequest={openRequest}
                    onOpenLink={openLink}
                    onMarkRead={(request) => void window.api.markInboxRead(request.id)}
                    onMarkAllRead={() => void window.api.markInboxAllRead()}
                    onClose={close}
                />
            )}
        </>
    )
}
