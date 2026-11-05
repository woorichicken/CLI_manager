/**
 * Adapted from VS Code's TerminalResizeDebouncer.
 * Keeps resize work cheap while the terminal is hidden and reduces horizontal reflow churn.
 *
 * Rows and columns always go out together, as one pty resize. They used to be
 * split — rows at once, columns 100ms later — so one window drag sent two
 * SIGWINCHes and Claude Code repainted twice, each repaint able to leave a seam
 * in the scrollback (backlog 「PTY resize 를 두 번」, day-1023).
 */
export class TerminalResizeManager {
    private latestCols = 0
    private latestRows = 0
    private resizeTimer: NodeJS.Timeout | null = null
    private idleCallbackId: number | null = null

    constructor(
        private readonly isVisible: () => boolean,
        private readonly getBufferLength: () => number,
        /** The size the terminal has now; a change of rows alone needs no reflow and is not delayed. */
        private readonly getCurrentSize: () => { cols: number; rows: number } | null,
        private readonly resizeBoth: (cols: number, rows: number) => void
    ) { }

    resize(cols: number, rows: number, immediate: boolean): void {
        this.latestCols = cols
        this.latestRows = rows

        if (immediate || this.getBufferLength() < 200) {
            this.clearTimers()
            this.resizeBoth(cols, rows)
            return
        }

        if (!this.isVisible()) {
            this.scheduleIdleResize()
            return
        }

        // Only rows changed and no column change is waiting: cheap, apply now.
        const current = this.getCurrentSize()
        if (!this.resizeTimer && current && current.cols === cols) {
            this.resizeBoth(cols, rows)
            return
        }

        // A column change reflows the whole buffer: wait until the drag pauses,
        // then send rows and columns in one go.
        if (this.resizeTimer) {
            clearTimeout(this.resizeTimer)
        }
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = null
            this.resizeBoth(this.latestCols, this.latestRows)
        }, 100)
    }

    flush(): void {
        this.cancelIdleResize()

        if (this.resizeTimer) {
            this.clearTimers()
            this.resizeBoth(this.latestCols, this.latestRows)
        }
    }

    dispose(): void {
        this.clearTimers()
        this.cancelIdleResize()
    }

    private scheduleIdleResize(): void {
        if (this.idleCallbackId !== null) {
            return
        }

        const callback = () => {
            this.idleCallbackId = null
            this.resizeBoth(this.latestCols, this.latestRows)
        }

        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
            this.idleCallbackId = window.requestIdleCallback(callback)
            return
        }

        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = null
            callback()
        }, 100)
    }

    private clearTimers(): void {
        if (this.resizeTimer) {
            clearTimeout(this.resizeTimer)
            this.resizeTimer = null
        }
    }

    private cancelIdleResize(): void {
        if (typeof window !== 'undefined' && 'cancelIdleCallback' in window && this.idleCallbackId !== null) {
            window.cancelIdleCallback(this.idleCallbackId)
        }
        this.idleCallbackId = null
    }
}
