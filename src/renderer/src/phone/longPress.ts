/*
 * A press held on one spot (ebf8dec6): the phone list's way to the rename the Mac sidebar offers.
 * A tap stays a tap (it opens the session); a finger that moves past the slop is scrolling the
 * list, not pressing a row; a press that went long eats the click that follows it, so the row it
 * renames does not also open.
 */

/** held this long on one spot: Android's own long-press is 400–500 ms */
export const LONG_PRESS_MS = 500
/** moved this far (CSS px) and it is a scroll, not a press */
export const LONG_PRESS_SLOP_PX = 10

export interface LongPress {
    down(x: number, y: number): void
    move(x: number, y: number): void
    /** the finger lifted or the browser took the gesture over (pointercancel) */
    up(): void
    /** the click after a press: false when that press already went long (the click is eaten) */
    takeClick(): boolean
    cancel(): void
}

export function createLongPress(onLong: () => void, schedule: (run: () => void, ms: number) => () => void = defaultSchedule): LongPress {
    let start: { x: number; y: number } | null = null
    let stop: (() => void) | null = null
    let fired = false
    const clear = (): void => {
        stop?.()
        stop = null
        start = null
    }
    return {
        down(x, y) {
            clear()
            fired = false
            start = { x, y }
            stop = schedule(() => {
                stop = null
                start = null
                fired = true
                onLong()
            }, LONG_PRESS_MS)
        },
        move(x, y) {
            if (start && Math.hypot(x - start.x, y - start.y) > LONG_PRESS_SLOP_PX) clear()
        },
        up() {
            clear()
        },
        takeClick() {
            if (!fired) return true
            fired = false
            return false
        },
        cancel() {
            clear()
            fired = false
        }
    }
}

function defaultSchedule(run: () => void, ms: number): () => void {
    const timer = window.setTimeout(run, ms)
    return () => window.clearTimeout(timer)
}
