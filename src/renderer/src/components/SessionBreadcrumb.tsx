import { ChevronRight } from 'lucide-react'
import type { BreadcrumbSegment } from '../utils/sessionBreadcrumb'

interface SessionBreadcrumbProps {
    segments: BreadcrumbSegment[]
    /** Pixel font size; split panes pass nothing and use the compact text-xs. */
    fontSize?: number
}

/**
 * `folder > project > session` header path.
 *
 * When the row is too narrow the folder and project shrink first (ellipsis)
 * and the session name last, because the session is what tells two panes
 * apart. The session never shrinks until it alone is wider than the row
 * (max-width 100% then truncates it); a tiny flex-shrink instead still took
 * a pixel off it before the others were used up.
 */
export function SessionBreadcrumb({ segments, fontSize }: SessionBreadcrumbProps) {
    if (segments.length === 0) return null

    return (
        <nav
            aria-label="Session path"
            data-session-breadcrumb
            className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden"
            style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
        >
            {segments.map((segment, index) => {
                const isLast = index === segments.length - 1
                return (
                    <span key={segment.kind} className="flex items-center gap-1 min-w-0" style={isLast ? { flexShrink: 0, maxWidth: '100%' } : { flexShrink: 1 }}>
                        {index > 0 && <ChevronRight size={12} className="text-gray-600 shrink-0" />}
                        <span
                            data-crumb={segment.kind}
                            className={`truncate ${fontSize ? '' : 'text-xs'} ${isLast ? 'text-gray-200' : 'text-gray-500'}`}
                            title={segment.label}
                        >
                            {segment.label}
                        </span>
                    </span>
                )
            })}
        </nav>
    )
}
