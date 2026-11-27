import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, CheckCheck, ChevronDown, ChevronRight, ExternalLink, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { InboxRequest, Workspace } from '../../../../shared/types'
import { isLinkAllowed } from '../../utils/terminalLinks'
import { formatInboxAge, INBOX_KIND_META, shortLink } from './inboxFormat'
import { InboxReplyBox, InboxReplyToggle } from './InboxReply'
import { isAgentSession, useAgentPendingVersion } from '../../utils/agentSession'
import { AgentUiCard } from '../AgentUi/AgentUiCard'

const POPOVER_WIDTH = 360
const VIEWPORT_MARGIN = 8

interface InboxPopoverProps {
    anchor: DOMRect
    requests: InboxRequest[]
    workspaces: Workspace[]
    linkSchemes?: string[]
    onOpenRequest: (request: InboxRequest) => void
    onOpenLink: (request: InboxRequest) => void
    /** The row's check: the only way one request turns read (report b165acc4). */
    onMarkRead: (request: InboxRequest) => void
    onMarkAllRead: () => void
    /** «Clear read»: removes every read request, leaves the unread ones. */
    onClearRead: () => void
    onClose: () => void
}

/**
 * Session name and workspace name for a request; the session can be renamed after it asked.
 * `replyBlocked`: why a reply would reach no one (closed session, no agent), null when it can go.
 */
function locate(workspaces: Workspace[], sessionId: string): { session: string; workspace: string; replyBlocked: string | null } {
    for (const workspace of workspaces) {
        const session = workspace.sessions?.find((s) => s.id === sessionId)
        if (session) {
            return {
                session: session.name,
                workspace: workspace.name,
                replyBlocked: isAgentSession(session) ? null : 'No agent in this session to read a reply — answer in its terminal'
            }
        }
    }
    return { session: 'Closed session', workspace: '', replyBlocked: 'This session is closed' }
}

/**
 * The inbox list. Fixed to the viewport (portal) so it can spread past a narrow
 * sidebar, clamped so a 390px-wide window still shows all of it. A request's text
 * is cut at two lines and shows whole while the row is hovered or focused
 * (report 8bf5e3f9 — the title tooltip was not enough).
 */
export function InboxPopover({
    anchor,
    requests,
    workspaces,
    linkSchemes,
    onOpenRequest,
    onOpenLink,
    onMarkRead,
    onMarkAllRead,
    onClearRead,
    onClose
}: InboxPopoverProps) {
    const ref = useRef<HTMLDivElement>(null)
    // One reply box at a time (report 5f9002d5).
    const [replyingId, setReplyingId] = useState<string | null>(null)
    // A Codex session started in the terminal is an agent before its cliToolName arrives (isAgentSession).
    useAgentPendingVersion()
    const closeReply = (requestId: string): void => {
        setReplyingId(null)
        // The caret goes back to the row's Reply button, not to the page.
        requestAnimationFrame(() => {
            ref.current
                ?.querySelector<HTMLButtonElement>(`[data-inbox-request="${CSS.escape(requestId)}"] [data-testid="inbox-reply-toggle"]`)
                ?.focus()
        })
    }
    // fb-1125 5b1198ba: what is still to do first; what was read waits folded under one line (not remembered)
    const unreadRequests = requests.filter((r) => !r.readAt)
    const readRequests = requests.filter((r) => r.readAt)
    const unread = unreadRequests.length
    const [readOpen, setReadOpen] = useState(false)
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

    const renderRequest = (request: InboxRequest) => {
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
                        'group flex gap-2 px-3 py-2 cursor-pointer hover:bg-white/5 focus:outline-none focus-visible:bg-white/5',
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
                            <InboxReplyToggle
                                open={replyingId === request.id}
                                disabledReason={where.replyBlocked}
                                onToggle={() => setReplyingId((id) => (id === request.id ? null : request.id))}
                            />
                            {!request.readAt && <MarkReadButton onMark={() => onMarkRead(request)} />}
                        </div>
                        <p
                            data-inbox-text
                            className={clsx(
                                'mt-0.5 text-xs line-clamp-2 group-hover:line-clamp-none group-focus-visible:line-clamp-none break-words',
                                request.readAt ? 'text-gray-400' : 'text-gray-200'
                            )}
                        >
                            {request.text}
                        </p>
                        {request.url && (
                            <LinkButton url={request.url} allowed={linkAllowed} onOpen={() => onOpenLink(request)} />
                        )}
                    </div>
                </div>
                {/* Beside the row, not in it: the row's click and Enter open the session */}
                {request.ui && (
                    <div className="px-3 pb-2 pl-8" data-testid="inbox-ui">
                        <AgentUiCard
                            // A repeat of the same request carries a new card (new rev): start it fresh —
                            // the old surface and the "answered" state belong to the card it replaced.
                            key={`${request.id}:${request.ui.rev ?? ''}`}
                            surfaceId={request.id}
                            ui={request.ui}
                            disabledReason={request.ui.answered ? null : where.replyBlocked}
                            onAction={(componentId, context) => window.api.answerInboxUi(request.id, request.ui?.rev, componentId, context)}
                        />
                    </div>
                )}
                {replyingId === request.id && !where.replyBlocked && (
                    <InboxReplyBox sessionId={request.sessionId} onClose={() => closeReply(request.id)} />
                )}
            </li>
        )
    }

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
            <div className="overflow-y-auto py-1" data-testid="inbox-body">
                {unread > 0 && <ul>{unreadRequests.map(renderRequest)}</ul>}
                {unread === 0 && readRequests.length > 0 && <ReadFold open={readOpen} count={readRequests.length} onToggle={() => setReadOpen((o) => !o)} onClear={onClearRead} />}
                {unread === 0 && (
                    <p className="px-3 py-4 text-xs text-gray-500">
                        {requests.length === 0 ? 'No requests.' : 'No unread requests.'} When a session needs you — a sign-in, a review, a question — it shows up here.
                    </p>
                )}
                {unread > 0 && readRequests.length > 0 && <ReadFold open={readOpen} count={readRequests.length} onToggle={() => setReadOpen((o) => !o)} onClear={onClearRead} />}
                {readOpen && readRequests.length > 0 && <ul data-testid="inbox-read-list">{readRequests.map(renderRequest)}</ul>}
            </div>
        </div>,
        document.body
    )
}

/** «Read (n)»: the folded line under what is still to do, with the one-shot clear beside it. */
function ReadFold({ open, count, onToggle, onClear }: { open: boolean; count: number; onToggle: () => void; onClear: () => void }) {
    return (
        <div className="flex items-center justify-between px-3 py-1 border-t border-white/5" data-testid="inbox-read-fold" data-state={open ? 'open' : 'closed'}>
            <button
                data-testid="inbox-read-toggle"
                aria-expanded={open}
                onClick={onToggle}
                className="flex items-center gap-1 px-1 py-0.5 -ml-1 rounded text-[11px] text-gray-400 hover:bg-white/10 hover:text-gray-200"
            >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Read ({count})
            </button>
            <button
                data-testid="inbox-clear-read"
                onClick={onClear}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-gray-400 hover:bg-white/10 hover:text-gray-200"
                title="Remove every read request — unread ones stay"
            >
                <Trash2 size={11} />
                Clear read
            </button>
        </div>
    )
}

function MarkReadButton({ onMark }: { onMark: () => void }) {
    const handleClick = (e: React.MouseEvent): void => {
        // The row behind it opens the session; the check only reads.
        e.stopPropagation()
        onMark()
    }
    return (
        <button
            data-testid="inbox-mark-read"
            onClick={handleClick}
            // Enter/Space on the button click it natively; the row's own Enter handler must not also open the session.
            onKeyDown={(e) => e.stopPropagation()}
            className="shrink-0 -my-0.5 p-0.5 rounded text-gray-500 hover:bg-white/10 hover:text-green-400"
            title="Mark as read"
            aria-label="Mark as read"
        >
            <Check size={12} />
        </button>
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
