import { useEffect, useState } from 'react'
import { ExternalLink, FileText, Pin, X } from 'lucide-react'
import type { PhoneDockItem, PhoneDockResponse } from '../../../shared/phone'
import { getDock, PhoneApiError } from './api'
import './phone-dock.css'

/**
 * The Artifact Dock, over the chat. It draws the extension's rows in the order they came: there is no sort
 * here on purpose, so it stays in the side panel's order. Reading only — pinning, closing and reloading stay
 * on the Mac. The session behind it stays mounted, so closing returns to the same scroll and the same draft.
 */

const POLL_MS = 5_000

const STATUS_TEXT: Partial<Record<PhoneDockResponse['status'], string>> = {
    outdated: 'Artifact Dock did not answer. It may be older than 0.7.0 — update and reload it.',
    error: 'Could not read the Dock list.'
}

function timeOf(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function statusText(list: PhoneDockResponse): string | null {
    if (list.status === 'chrome_off') return list.asOf === null ? 'Chrome is off' : `Chrome is off · list from ${timeOf(list.asOf)}`
    return STATUS_TEXT[list.status] ?? null
}

function DockRow({
    item,
    onOpenDoc,
    onOpenSession
}: {
    item: PhoneDockItem
    onOpenDoc?: (item: PhoneDockItem) => void
    onOpenSession: (sessionId: string) => void
}) {
    const [expanded, setExpanded] = useState(false)
    const body = (
        <>
            <FileText size={14} className="phone-dock-row-icon" aria-hidden="true" />
            <span className="phone-dock-row-text">
                <span className="phone-dock-row-title">
                    {item.pinned && <Pin size={11} className="phone-dock-row-pin" aria-label="Pinned" />}
                    <span data-testid="phone-dock-title">{item.title}</span>
                    {item.missing && <span className="phone-dock-tag">Deleted</span>}
                </span>
                <span className="phone-dock-row-sub" data-expanded={expanded ? 'true' : undefined}>
                    {item.sub}
                </span>
            </span>
        </>
    )
    return (
        <div
            className="phone-dock-row"
            data-testid="phone-dock-row"
            data-key={item.key}
            data-kind={item.kind}
            data-pinned={item.pinned ? 'true' : undefined}
            data-missing={item.missing ? 'true' : undefined}
            data-expanded={expanded ? 'true' : undefined}
        >
            {item.url && !item.missing ? (
                // only https on claude.ai / claude.site gets a url from main
                <a className="phone-dock-row-body" data-testid="phone-dock-row-body" href={item.url} target="_blank" rel="noopener noreferrer">
                    {body}
                    <ExternalLink size={12} className="phone-dock-row-external" aria-label="Opens in the browser" />
                </a>
            ) : (
                <button
                    type="button"
                    className="phone-dock-row-body"
                    data-testid="phone-dock-row-body"
                    onClick={() => {
                        if (onOpenDoc && item.kind === 'file' && !item.missing) onOpenDoc(item)
                        else setExpanded((on) => !on)
                    }}
                >
                    {body}
                </button>
            )}
            {item.session && (
                <button type="button" className="phone-dock-session" data-testid="phone-dock-session" onClick={() => onOpenSession(item.session!.id)}>
                    {item.session.name}
                </button>
            )}
            {item.sessionGone && (
                <span className="phone-dock-session-gone" data-testid="phone-dock-session-gone">
                    Session closed
                </span>
            )}
        </div>
    )
}

function DockSection({ kind, title, items, ...actions }: { kind: 'open' | 'closed'; title: string; items: PhoneDockItem[]; onOpenDoc?: (item: PhoneDockItem) => void; onOpenSession: (sessionId: string) => void }) {
    if (items.length === 0) return null
    return (
        <section data-dock-section={kind}>
            <h3 className="phone-dock-section-title" data-testid="phone-dock-section-title">
                {title}
            </h3>
            {items.map((item) => (
                <DockRow key={item.key} item={item} {...actions} />
            ))}
        </section>
    )
}

export function PhoneDockPanel({
    onClose,
    onOpenSession,
    onOpenDoc
}: {
    onClose: () => void
    onOpenSession: (sessionId: string) => void
    /** what a file row opens. Absent, a tap only shows the whole folder name. */
    onOpenDoc?: (item: PhoneDockItem) => void
}) {
    const [list, setList] = useState<PhoneDockResponse | null>(null)
    const [unreachable, setUnreachable] = useState<'offline' | 'gone' | null>(null)

    // Only while the panel is open and the page in front: each read crosses Chrome's native messaging.
    useEffect(() => {
        let stopped = false
        const load = (): void => {
            if (document.visibilityState !== 'visible') return
            getDock()
                .then((next) => {
                    if (stopped) return
                    setList(next)
                    setUnreachable(null)
                })
                .catch((error) => {
                    if (!stopped) setUnreachable(error instanceof PhoneApiError && error.status === 404 ? 'gone' : 'offline')
                })
        }
        load()
        const timer = window.setInterval(load, POLL_MS)
        document.addEventListener('visibilitychange', load)
        return () => {
            stopped = true
            window.clearInterval(timer)
            document.removeEventListener('visibilitychange', load)
        }
    }, [])

    const band = list ? statusText(list) : null
    const rows = list ? list.open.length + list.closed.length : 0

    return (
        <div className="phone-dock-panel" data-testid="phone-dock-panel" role="dialog" aria-label="Artifact Dock">
            <div className="phone-dock-head">
                <button type="button" className="phone-icon-button" aria-label="Close Dock" data-testid="phone-dock-close" onClick={onClose}>
                    <X size={18} />
                </button>
                <span className="phone-dock-title">Dock</span>
                <span className="phone-dock-order">Mac order</span>
            </div>
            {unreachable === 'offline' && <div className="phone-offline">Reconnecting to the Mac…</div>}
            {band && (
                <div className="phone-dock-status" data-testid="phone-dock-status" data-status={list!.status} role="status">
                    {band}
                </div>
            )}
            <div className="phone-dock-list" data-testid="phone-dock-list">
                {list && rows > 0 && (
                    <>
                        <DockSection kind="open" title={`Open ${list.open.length}`} items={list.open} onOpenDoc={onOpenDoc} onOpenSession={onOpenSession} />
                        <DockSection kind="closed" title="Recently closed" items={list.closed} onOpenDoc={onOpenDoc} onOpenSession={onOpenSession} />
                    </>
                )}
                {!list && !unreachable && <div className="phone-empty">Loading the Dock…</div>}
                {unreachable === 'gone' && <div className="phone-empty">Artifact Dock is not on this Mac.</div>}
                {list && rows === 0 && (
                    <div className="phone-empty">{list.status === 'chrome_off' ? 'Open Chrome on the Mac to see the list.' : list.status === 'live' ? 'Nothing in the Dock yet.' : 'No list to show yet.'}</div>
                )}
            </div>
        </div>
    )
}
