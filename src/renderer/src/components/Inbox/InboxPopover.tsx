import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CheckCheck, ExternalLink } from 'lucide-react'
import clsx from 'clsx'
import { InboxRequest, Workspace } from '../../../../shared/types'
import { isLinkAllowed } from '../../utils/terminalLinks'
import { formatInboxAge, INBOX_KIND_META, shortLink } from './inboxFormat'

const POPOVER_WIDTH = 360
const VIEWPORT_MARGIN = 8

interface InboxPopoverProps {
    anchor: DOMRect
    requests: InboxRequest[]
    workspaces: Workspace[]
    linkSchemes?: string[]
    onOpenRequest: (request: InboxRequest) => void
    onOpenLink: (request: InboxRequest) => void
    onMarkAllRead: () => void
    onClose: () => void
}

/** Session name and workspace name for a request; the session can be renamed after it asked. */
function locate(workspaces: Workspace[], sessionId: string): { session: string; workspace: string } {
    for (const workspace of workspaces) {
        const session = workspace.sessions?.find((s) => s.id === sessionId)
        if (session) return { session: session.name, workspace: workspace.name }
    }
    return { session: 'Closed session', workspace: '' }
}

/**
 * The inbox list. Fixed to the viewport (portal) so it can spread past a narrow
 * sidebar, clamped so a 390px-wide window still shows all of it.
 */
export function InboxPopover({
    anchor,
    requests,
    workspaces,
    linkSchemes,
    onOpenRequest,
    onOpenLink,
    onMarkAllRead,
    onClose
}: InboxPopoverProps) {
    const ref = useRef<HTMLDivElement>(null)
    const unread = requests.filter((r) => !r.readAt).length
    const now = Date.now()

    useEffect(() => {
        const onPointerDown = (e: PointerEvent): void => {
            const target = e.target as HTMLElement | null
            if (ref.current?.contains(target) || target?.closest('[data-testid="inbox-button"]')) return
            onClose()
        }
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKey)
        }
    }, [onClose])

    const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)
    const left = Math.min(Math.max(anchor.left, VIEWPORT_MARGIN), window.innerWidth - width - VIEWPORT_MARGIN)
    const top = anchor.bottom + 4
    const maxHeight = Math.max(160, window.innerHeight - top - VIEWPORT_MARGIN)

    return createPortal(
        <div
            ref={ref}
            data-testid="inbox-popover"
            className="fixed z-[100] flex flex-col rounded-lg border border-white/10 bg-[#1e1e1e]/95 backdrop-blur shadow-2xl text-gray-200"
            style={{ left, top, width, maxHeight }}
        >
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                    Inbox{unread > 0 ? ` · ${unread} unread` : ''}
                </span>
                <button
                    data-testid="inbox-mark-all-read"
                    onClick={onMarkAllRead}
                    disabled={unread === 0}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                    <CheckCheck size={12} />
                    Mark all read
                </button>
            </div>
            {requests.length === 0 ? (
                <p className="px-3 py-4 text-xs text-gray-500">
                    No requests. When a session needs you — a sign-in, a review, a question — it shows up here.
                </p>
            ) : (
                <ul className="overflow-y-auto py-1">
                    {requests.map((request) => {
                        const meta = INBOX_KIND_META[request.kind] ?? INBOX_KIND_META.other
                        const Icon = meta.icon
                        const where = locate(workspaces, request.sessionId)
                        const linkAllowed = request.url ? isLinkAllowed(request.url, linkSchemes ?? []) : false
                        return (
                            <li key={request.id}>
                                <div
                                    role="button"
                                    tabIndex={0}
                                    data-inbox-request={request.id}
                                    data-read={request.readAt ? 'true' : 'false'}
                                    onClick={() => onOpenRequest(request)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') onOpenRequest(request)
                                    }}
                                    className={clsx(
                                        'flex gap-2 px-3 py-2 cursor-pointer hover:bg-white/5',
                                        request.readAt && 'opacity-60'
                                    )}
                                    title={`${meta.label} — ${request.text}\n${new Date(request.at).toLocaleString()}`}
                                >
                                    <Icon size={14} className={clsx('mt-0.5 shrink-0', meta.color)} />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 min-w-0">
                                            {!request.readAt && <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />}
                                            <span className="truncate text-xs font-medium text-gray-200">{where.session}</span>
                                            {where.workspace && (
                                                <span className="truncate min-w-0 flex-1 text-[10px] text-gray-500">{where.workspace}</span>
                                            )}
                                            <span className="ml-auto shrink-0 text-[10px] text-gray-500">{formatInboxAge(request.at, now)}</span>
                                        </div>
                                        <p className={clsx('mt-0.5 text-xs line-clamp-2 break-words', request.readAt ? 'text-gray-400' : 'text-gray-200')}>
                                            {request.text}
                                        </p>
                                        {request.url && (
                                            <LinkButton url={request.url} allowed={linkAllowed} onOpen={() => onOpenLink(request)} />
                                        )}
                                    </div>
                                </div>
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>,
        document.body
    )
}

function LinkButton({ url, allowed, onOpen }: { url: string; allowed: boolean; onOpen: () => void }) {
    const handleClick = (e: React.MouseEvent): void => {
        e.stopPropagation()
        if (allowed) onOpen()
    }
    return (
        <button
            data-inbox-link={url}
            data-allowed={allowed ? 'true' : 'false'}
            onClick={handleClick}
            className={clsx(
                'mt-1 flex items-center gap-1 max-w-full text-[11px]',
                allowed ? 'text-blue-400 hover:underline' : 'text-gray-500 cursor-default'
            )}
            title={allowed ? url : `${url}\nThis kind of link isn't allowed. Add its scheme in Settings > Terminal to open it.`}
        >
            <ExternalLink size={11} className="shrink-0" />
            <span className="truncate">{shortLink(url)}</span>
        </button>
    )
}
