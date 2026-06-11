import { Terminal } from '@xterm/xterm'

/**
 * Terminal instrumentation for automated tests (Playwright).
 *
 * Active ONLY when the app is launched with CLIMANGER_TERM_DEBUG=1
 * (exposed via preload as window.api.termDebugEnabled). All exported
 * functions are no-ops otherwise, so production behavior is unchanged.
 *
 * Exposes window.__termDebug with:
 *  - ids(): registered terminal session ids
 *  - state(id): viewport/buffer geometry snapshot
 *  - text(id, maxLines?): scrollback buffer as plain text
 *  - scrollLines(id, n) / scrollToTop(id): simulate user scrolling
 *  - counters(): pty resize / write counters collected since last reset
 *  - resetCounters()
 */

interface TermDebugState {
    viewportY: number
    baseY: number
    length: number
    rows: number
    cols: number
    atBottom: boolean
    /** Text of the first visible row — detects content drifting under a "stable" viewport */
    topLine: string
}

const registry = new Map<string, Terminal>()
const ptyResizeCounts = new Map<string, number>()
const writeByteCounts = new Map<string, number>()
let writeErrorCount = 0

export function isTermDebugEnabled(): boolean {
    try {
        return Boolean(window.api?.termDebugEnabled)
    } catch {
        return false
    }
}

function snapshot(term: Terminal): TermDebugState {
    const buffer = term.buffer.active
    return {
        viewportY: buffer.viewportY,
        baseY: buffer.baseY,
        length: buffer.length,
        rows: term.rows,
        cols: term.cols,
        atBottom: buffer.viewportY >= buffer.baseY,
        topLine: buffer.getLine(buffer.viewportY)?.translateToString(true) ?? ''
    }
}

function bufferText(term: Terminal, maxLines?: number): string {
    const buffer = term.buffer.active
    const total = buffer.length
    const start = maxLines ? Math.max(0, total - maxLines) : 0
    const lines: string[] = []
    for (let i = start; i < total; i++) {
        lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }
    return lines.join('\n')
}

function exposeGlobal(): void {
    const target = window as unknown as Record<string, unknown>
    if (target.__termDebug) return
    target.__termDebug = {
        ids: () => [...registry.keys()],
        state: (id: string) => {
            const term = registry.get(id)
            return term ? snapshot(term) : null
        },
        text: (id: string, maxLines?: number) => {
            const term = registry.get(id)
            return term ? bufferText(term, maxLines) : null
        },
        scrollLines: (id: string, n: number) => {
            registry.get(id)?.scrollLines(n)
        },
        scrollToTop: (id: string) => {
            registry.get(id)?.scrollToTop()
        },
        counters: () => ({
            ptyResize: Object.fromEntries(ptyResizeCounts),
            ptyResizeTotal: [...ptyResizeCounts.values()].reduce((a, b) => a + b, 0),
            writeBytes: Object.fromEntries(writeByteCounts),
            writeErrors: writeErrorCount
        }),
        resetCounters: () => {
            ptyResizeCounts.clear()
            writeByteCounts.clear()
            writeErrorCount = 0
        }
    }
}

export function debugRegisterTerminal(id: string, term: Terminal): void {
    if (!isTermDebugEnabled()) return
    registry.set(id, term)
    exposeGlobal()
}

export function debugUnregisterTerminal(id: string): void {
    if (!isTermDebugEnabled()) return
    registry.delete(id)
}

export function debugCountPtyResize(id: string): void {
    if (!isTermDebugEnabled()) return
    ptyResizeCounts.set(id, (ptyResizeCounts.get(id) ?? 0) + 1)
}

export function debugCountWrite(id: string, bytes: number): void {
    if (!isTermDebugEnabled()) return
    writeByteCounts.set(id, (writeByteCounts.get(id) ?? 0) + bytes)
}

export function debugCountWriteError(): void {
    if (!isTermDebugEnabled()) return
    writeErrorCount++
}
