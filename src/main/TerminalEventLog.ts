import type { TerminalEventKind, TerminalEventRecord } from '../shared/types'
import type { TerminalManager } from './TerminalManager'

/**
 * Recent events per terminal, plus window-wide ones, for feedback reports.
 *
 * A report says "the conversation vanished" or "the terminal froze"; what led up
 * to it — the renderer crashing, a program erasing its scrollback, a view that
 * never confirmed its snapshot — is gone by the time anyone reads the report.
 * This keeps the last few of those in memory. Nothing is written to disk, and
 * nothing leaves the app unless someone sends a report.
 */

/** Enough to cover what happened since a session last behaved; older events rarely explain a report. */
const EVENTS_PER_TERMINAL = 30
const APP_EVENTS = 20

/**
 * Terminals with events kept. Loop and other transient terminals get fresh ids
 * and are never deleted from the sidebar, so without a bound their records
 * would pile up for as long as the app runs. The least recently active go first.
 */
const MAX_TRACKED_TERMINALS = 200

/**
 * Repeats closer together than this become one record with a count. A TUI can
 * erase its scrollback on every repaint; thirty copies would push out the
 * events that explain them.
 */
const COALESCE_WINDOW_MS = 5000

/** Between the old and the new size in a `resized` record. */
const RESIZE_ARROW = '→'

interface StoredEvent {
    kind: TerminalEventKind
    at: number
    detail?: string
    count: number
}

export class TerminalEventLog {
    private readonly terminals = new Map<string, StoredEvent[]>()
    private readonly app: StoredEvent[] = []
    /** Last pty size per terminal, so a resize can say what it changed from. */
    private readonly sizes = new Map<string, string>()

    constructor(terminals?: TerminalManager, private readonly now: () => number = Date.now) {
        if (!terminals) return
        terminals.events.on('created', (id, cols, rows) => {
            this.sizes.set(id, sizeLabel(cols, rows))
            this.record(id, 'started')
        })
        terminals.events.on('resized', (id, cols, rows) => this.recordResize(id, cols, rows))
        terminals.events.on('attached', (id, existed) => {
            if (existed) this.record(id, 'reattached')
        })
        terminals.events.on('attachTimedOut', (id) => this.record(id, 'attach-timeout'))
        terminals.events.on('cleared', (id) => this.record(id, 'cleared'))
        terminals.events.on('exited', (id, exit) => {
            this.sizes.delete(id)
            if (exit.by === 'app') {
                this.record(id, 'closed')
                return
            }
            const detail = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.exitCode}`
            this.record(id, 'exited', detail)
        })
    }

    record(id: string, kind: TerminalEventKind, detail?: string): void {
        this.push(this.touch(id), EVENTS_PER_TERMINAL, kind, detail)
    }

    /**
     * A pty size change. Report f2a636b9 lost the head of a table after a long time away, and nothing in
     * the report said whether the terminal had grown in between — the one fact that splits the causes.
     * A window drag sends a run of sizes; the run stays one record, from where it started to where it
     * ended, so it cannot push out the events that explain a report.
     */
    recordResize(id: string, cols: number, rows: number): void {
        const to = sizeLabel(cols, rows)
        const from = this.sizes.get(id)
        this.sizes.set(id, to)
        if (from === to) return
        const events = this.touch(id)
        const last = events[events.length - 1]
        const at = this.now()
        // A record without a start size (the pty's first size was never seen) stays on its own:
        // joining it would present its first size as where the run started.
        if (last && last.kind === 'resized' && last.detail?.includes(RESIZE_ARROW) && at - last.at <= COALESCE_WINDOW_MS) {
            const runStart = last.detail.split(RESIZE_ARROW)[0]
            last.detail = `${runStart}${RESIZE_ARROW}${to}`
            last.count++
            last.at = at
            return
        }
        this.push(events, EVENTS_PER_TERMINAL, 'resized', from ? `${from}${RESIZE_ARROW}${to}` : to)
    }

    recordApp(kind: TerminalEventKind, detail?: string): void {
        this.push(this.app, APP_EVENTS, kind, detail)
    }

    events(id: string): TerminalEventRecord[] {
        return (this.terminals.get(id) ?? []).map(toRecord)
    }

    appEvents(): TerminalEventRecord[] {
        return this.app.map(toRecord)
    }

    /** The session was deleted; nobody will report on it. */
    forget(id: string): void {
        this.terminals.delete(id)
        this.sizes.delete(id)
    }

    /** The terminal's events, moved to the end so Map order stays least-recently-active first. */
    private touch(id: string): StoredEvent[] {
        const events = this.terminals.get(id) ?? []
        this.terminals.delete(id)
        this.terminals.set(id, events)
        if (this.terminals.size > MAX_TRACKED_TERMINALS) {
            const oldest = this.terminals.keys().next().value
            if (oldest !== undefined) {
                this.terminals.delete(oldest)
                this.sizes.delete(oldest)
            }
        }
        return events
    }

    private push(events: StoredEvent[], limit: number, kind: TerminalEventKind, detail?: string): void {
        const at = this.now()
        const last = events[events.length - 1]
        if (last && last.kind === kind && last.detail === detail && at - last.at <= COALESCE_WINDOW_MS) {
            last.count++
            last.at = at
            return
        }
        events.push({ kind, at, detail, count: 1 })
        if (events.length > limit) events.splice(0, events.length - limit)
    }
}

function sizeLabel(cols: number, rows: number): string {
    return `${cols}x${rows}`
}

function toRecord(event: StoredEvent): TerminalEventRecord {
    return {
        kind: event.kind,
        at: new Date(event.at).toISOString(),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        ...(event.count > 1 ? { count: event.count } : {})
    }
}
