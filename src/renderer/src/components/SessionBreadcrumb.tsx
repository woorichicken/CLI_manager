import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Home } from 'lucide-react'
import type { BreadcrumbSegment } from '../utils/sessionBreadcrumb'

interface SessionBreadcrumbProps {
    segments: BreadcrumbSegment[]
    /** Pixel font size; split panes pass nothing and use the compact text-xs. */
    fontSize?: number
}

const HOME_LABEL = '~'

/**
 * `folder > project > session` header path.
 *
 * When the full path does not fit, whole leading segments are dropped (folder
 * first, then project) and a single `…` stands in for them, its tooltip holding
 * the complete path. The session name is never dropped — it is what tells two
 * panes apart; only when it alone is wider than the row does it get an ellipsis.
 *
 * Fit is measured, not guessed from character counts, so a changed font size
 * setting or a long name lands on the right answer: render with `hidden`
 * segments dropped, and while the row overflows drop one more.
 */
export function SessionBreadcrumb({ segments, fontSize }: SessionBreadcrumbProps) {
    const navRef = useRef<HTMLElement>(null)
    // Bumped on every resize so the fit search restarts from the full path.
    const [resizeTick, setResizeTick] = useState(0)
    const pathKey = segments.map(s => `${s.kind}:${s.label}`).join('>')
    const searchKey = `${pathKey}|${fontSize ?? ''}|${resizeTick}`
    // The drop count belongs to one searchKey; any other key means "start over at 0".
    const [drop, setDrop] = useState({ key: searchKey, count: 0 })
    const hidden = drop.key === searchKey ? drop.count : 0

    useLayoutEffect(() => {
        const nav = navRef.current
        if (!nav) return
        if (hidden < segments.length - 1 && nav.scrollWidth > nav.clientWidth) {
            setDrop({ key: searchKey, count: hidden + 1 })
        }
    }, [hidden, segments.length, searchKey])

    const handleResize = useCallback(() => setResizeTick(t => t + 1), [])
    useLayoutEffect(() => {
        const nav = navRef.current
        if (!nav) return
        // Watch the row's own width, not its content: content changes while we search.
        let lastWidth = nav.clientWidth
        const observer = new ResizeObserver(() => {
            if (nav.clientWidth !== lastWidth) {
                lastWidth = nav.clientWidth
                handleResize()
            }
        })
        observer.observe(nav)
        return () => observer.disconnect()
    }, [handleResize, segments.length])

    if (segments.length === 0) return null

    const visible = segments.slice(Math.min(hidden, segments.length - 1))
    const dropped = segments.slice(0, segments.length - visible.length)
    const fullPath = segments.map(s => s.label).join(' > ')

    return (
        <nav
            ref={navRef}
            aria-label="Session path"
            data-session-breadcrumb
            className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden"
            style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
        >
            {dropped.length > 0 && (
                <span className="flex items-center gap-1 shrink-0">
                    <span data-crumb-more className={`text-gray-500 ${fontSize ? '' : 'text-xs'}`} title={fullPath}>…</span>
                </span>
            )}
            {visible.map((segment, index) => {
                const isLast = index === visible.length - 1
                const showChevron = index > 0 || dropped.length > 0
                return (
                    <span key={segment.kind} className="flex items-center gap-1 min-w-0" style={isLast ? { flexShrink: 1, maxWidth: '100%' } : { flexShrink: 0 }}>
                        {showChevron && <ChevronRight size={12} className="text-gray-600 shrink-0" />}
                        <span
                            data-crumb={segment.kind}
                            className={`flex items-center gap-1 min-w-0 ${fontSize ? '' : 'text-xs'} ${isLast ? 'text-gray-200' : 'text-gray-500'}`}
                            title={segment.label}
                        >
                            {segment.isHome && <Home size={12} className="shrink-0" />}
                            <span className="truncate">{segment.isHome ? HOME_LABEL : segment.label}</span>
                        </span>
                    </span>
                )
            })}
        </nav>
    )
}
