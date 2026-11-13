import { useEffect, type RefObject } from 'react'

/**
 * Scrolling the sidebar while a session row is dragged near its top or bottom (report
 * 0edb46cc). Native HTML5 drags do not scroll the list on their own here, so a row could not
 * reach a folder or session that was scrolled out of view.
 */

/** How close to an edge (px) the pointer must be before the list starts to scroll. */
export const DRAG_SCROLL_EDGE_PX = 48
/** Fastest scroll per frame (px), reached at — or past — the edge itself. */
export const DRAG_SCROLL_MAX_STEP_PX = 18
/** A drag that sends no dragover for this long has left the window (Chromium repeats dragover while the pointer rests). */
const DRAG_SCROLL_IDLE_MS = 500

/**
 * Pixels to scroll this frame for a pointer at `pointerY` over a list spanning `top`..`bottom`:
 * negative scrolls up, 0 stays. Past the edge (over the header above the list, or the badge
 * below it) counts as the edge itself, so dragging "up out of the list" keeps scrolling.
 */
export function dragScrollStep(
    pointerY: number,
    top: number,
    bottom: number,
    edge = DRAG_SCROLL_EDGE_PX,
    maxStep = DRAG_SCROLL_MAX_STEP_PX
): number {
    if (bottom - top <= edge * 2) return 0
    const speed = (depth: number): number => Math.ceil(maxStep * Math.min(1, Math.max(0, depth) / edge))
    if (pointerY < top + edge) return -speed(top + edge - pointerY)
    if (pointerY > bottom - edge) return speed(pointerY - (bottom - edge))
    return 0
}

/**
 * While `active` (a session row is being dragged), scrolls `listRef` when the drag hovers near
 * its top or bottom edge. Listens on the window in the capture phase: the rows handle dragover
 * themselves, and the pointer may already be above or below the list.
 */
export function useDragAutoScroll(active: boolean, listRef: RefObject<HTMLElement | null>): void {
    useEffect(() => {
        if (!active) return
        let step = 0
        let lastDragOver = 0
        let frame = 0

        const tick = (): void => {
            frame = 0
            const list = listRef.current
            if (!list || step === 0 || performance.now() - lastDragOver > DRAG_SCROLL_IDLE_MS) {
                step = 0
                return
            }
            const before = list.scrollTop
            list.scrollTop = before + step
            // At the end of the list there is nothing left to scroll: stop until the pointer moves.
            if (list.scrollTop === before) {
                step = 0
                return
            }
            frame = requestAnimationFrame(tick)
        }

        const onDragOver = (event: DragEvent): void => {
            const list = listRef.current
            if (!list) return
            const rect = list.getBoundingClientRect()
            // Only a drag in the sidebar's column scrolls it; the terminal area is a drop target too.
            const inColumn = event.clientX >= rect.left && event.clientX <= rect.right
            step = inColumn ? dragScrollStep(event.clientY, rect.top, rect.bottom) : 0
            lastDragOver = performance.now()
            if (step !== 0 && frame === 0) frame = requestAnimationFrame(tick)
        }

        window.addEventListener('dragover', onDragOver, true)
        return () => {
            window.removeEventListener('dragover', onDragOver, true)
            if (frame !== 0) cancelAnimationFrame(frame)
        }
    }, [active, listRef])
}
