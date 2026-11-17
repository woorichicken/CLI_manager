import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Which ends of the row have chips scrolled out of sight — the CSS fades that end. */
type Hidden = 'none' | 'start' | 'end' | 'both'

function hiddenEnds(row: HTMLElement): Hidden {
    // 1px of slack: a fractional scrollLeft never quite reaches the end on a zoomed screen
    const start = row.scrollLeft > 1
    const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1
    return start && end ? 'both' : start ? 'start' : end ? 'end' : 'none'
}

/**
 * The quick-reply chips on one line (29993485): a list that wrapped took a second row over the box. The row
 * scrolls sideways instead — no scrollbar, a faded edge says more chips are there, and a mouse wheel's
 * up/down moves it sideways (a Mac mouse has no sideways wheel). A trackpad or a finger swipes it as usual.
 */
export function QuickReplyRow({ busy, children }: { busy: boolean; children: ReactNode }) {
    const rowRef = useRef<HTMLDivElement>(null)
    const [hidden, setHidden] = useState<Hidden>('none')

    useEffect(() => {
        const row = rowRef.current
        if (!row) return
        const update = (): void => setHidden(hiddenEnds(row))
        update()
        // React's onWheel is passive: preventDefault needs a listener of our own
        const onWheel = (event: WheelEvent): void => {
            if (row.scrollWidth <= row.clientWidth) return
            if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
            const before = row.scrollLeft
            row.scrollLeft += event.deltaY
            // at an end the wheel is left alone, for whatever scrolls around the row
            if (row.scrollLeft !== before) event.preventDefault()
        }
        const resize = new ResizeObserver(update)
        resize.observe(row)
        row.addEventListener('scroll', update, { passive: true })
        row.addEventListener('wheel', onWheel, { passive: false })
        return () => {
            resize.disconnect()
            row.removeEventListener('scroll', update)
            row.removeEventListener('wheel', onWheel)
        }
    }, [])

    // the chips change (a reply sending, a list edited in Settings): what overflows may change with them
    useEffect(() => {
        if (rowRef.current) setHidden(hiddenEnds(rowRef.current))
    })

    return (
        <div ref={rowRef} className="chat-quick" role="group" aria-label="Quick replies" data-testid="chat-quick-replies" data-hidden={hidden} aria-busy={busy}>
            {children}
        </div>
    )
}
