import React, { useLayoutEffect, useRef, useState } from 'react'
import { isMac, TRAFFIC_LIGHTS_CLEAR_X } from '../../utils/platform'

/** The sidebar card starts 8px in (mx-2) and its header row has px-2: the lights' spot left in the row. */
const SIDEBAR_HEADER_LIGHTS_SPACER = Math.max(0, TRAFFIC_LIGHTS_CLEAR_X - 8 - 8)

/**
 * The left end of the sidebar header row: the macOS traffic lights' spot, then the view's title.
 * With the lights taking ~70px, the title has no room next to the buttons at the default width (256):
 * on macOS it is hidden rather than cut to a stub, and shows whole once the sidebar is wide enough
 * (91fce7bf r2 — the person chose this over a strip across both panels). The view toggle's tooltip
 * names the view meanwhile. Elsewhere it truncates as before.
 *
 * Hidden with `visibility`, so it keeps its width and the measurement does not flip back and forth.
 */
export function SidebarHeaderStart({ title }: { title: string }) {
    const ref = useRef<HTMLSpanElement>(null)
    const [hidden, setHidden] = useState(false)

    useLayoutEffect(() => {
        const el = ref.current
        if (!el || !isMac) return
        const check = (): void => setHidden(el.scrollWidth > el.clientWidth)
        check()
        const observer = new ResizeObserver(check)
        observer.observe(el)
        return () => observer.disconnect()
    }, [title])

    return (
        <>
            {/* The title gives way first; below ~200px the spot shrinks too, so the buttons are never pushed off the card */}
            {SIDEBAR_HEADER_LIGHTS_SPACER > 0 && (
                <div aria-hidden data-traffic-lights-spacer className="self-stretch min-w-0" style={{ flex: `0 1 ${SIDEBAR_HEADER_LIGHTS_SPACER}px` }} />
            )}
            {/* The label gives way first, so a narrow sidebar never clips the buttons */}
            <span
                ref={ref}
                data-testid="sidebar-title"
                data-title-hidden={hidden ? 'true' : undefined}
                className={`flex-1 text-xs font-semibold text-gray-400 uppercase tracking-wider truncate min-w-0 ${hidden ? 'invisible' : ''}`}
            >
                {title}
            </span>
        </>
    )
}
