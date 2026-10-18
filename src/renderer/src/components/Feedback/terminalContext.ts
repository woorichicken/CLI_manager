// What a feedback report says about terminals: which one it is about, and what main knows about it.
import type { DiagLogEntry, DiagnosticsPayload, ElementInfo } from '@solhun/feedback-kit-core'
import type { FeedbackTerminalContext, FeedbackTerminalState, TerminalEventKind, TerminalEventRecord } from '../../../../shared/types'

/** Set by App.tsx on each terminal's container. */
const SESSION_ATTRIBUTE = 'data-session-id'
/** Set by the sidebar on each session row — picking a row is pointing at that session too. */
const SIDEBAR_SESSION_ATTRIBUTE = 'data-session-item'

/** A report must not wait on main; past this it goes out with what it has. */
const CONTEXT_TIMEOUT_MS = 2000

/**
 * Log level per event in the report's app log. Errors and warnings are what a
 * reader scans for; routine lifecycle stays at `log` so it does not read as trouble.
 * An exit is an error unless the program ended with code 0 (see `levelOf`).
 */
const EVENT_LEVELS: Record<TerminalEventKind, DiagLogEntry['level']> = {
    'renderer-gone': 'error',
    'renderer-reload-stopped': 'error',
    'attach-timeout': 'error',
    exited: 'error',
    'scrollback-erased': 'warn',
    'renderer-reloaded': 'warn',
    reattached: 'warn',
    started: 'log',
    restored: 'log',
    cleared: 'log',
    closed: 'log'
}

export type TerminalTargetSource = 'picked' | 'focused' | 'visible'

export interface TerminalTarget {
    sessionId: string
    /** How the terminal was identified, so a reader knows how far to trust it. */
    source: TerminalTargetSource
}

/**
 * The terminal a report is about: the one the picked element sits in, else the
 * last terminal that had focus if it is still on screen, else the only one on
 * screen. Null rather than a guess when several are shown and none was chosen.
 */
export function resolveTerminalTarget(
    element: ElementInfo | null,
    lastFocusedSessionId: string | null,
    doc: Document = document
): TerminalTarget | null {
    const picked = element ? sessionContaining(element, doc) : null
    if (picked) return { sessionId: picked, source: 'picked' }
    const visible = visibleSessionContainers(doc).map((el) => el.getAttribute(SESSION_ATTRIBUTE) as string)
    if (lastFocusedSessionId && visible.includes(lastFocusedSessionId)) {
        return { sessionId: lastFocusedSessionId, source: 'focused' }
    }
    if (visible.length === 1) return { sessionId: visible[0], source: 'visible' }
    return null
}

/** The session of the terminal an element belongs to, read from the DOM around a focus event's target. */
export function sessionOfNode(node: EventTarget | null): string | null {
    if (!(node instanceof Element)) return null
    return node.closest(`[${SESSION_ATTRIBUTE}]`)?.getAttribute(SESSION_ATTRIBUTE) ?? null
}

/**
 * The picked element reaches us serialized (tag, a few attributes, its box), not
 * as a node, so it is found again by position: the visible terminal or sidebar
 * row whose box holds its center. The smallest such box is the most specific.
 */
function sessionContaining(element: ElementInfo, doc: Document): string | null {
    const own = element.attributes[SESSION_ATTRIBUTE] ?? element.attributes[SIDEBAR_SESSION_ATTRIBUTE]
    if (own) return own
    const box = element.boundingBox
    if (!box) return null
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    let best: { id: string; area: number } | null = null
    for (const [el, attribute] of [
        ...visibleWith(doc, SESSION_ATTRIBUTE).map((el) => [el, SESSION_ATTRIBUTE] as const),
        ...visibleWith(doc, SIDEBAR_SESSION_ATTRIBUTE).map((el) => [el, SIDEBAR_SESSION_ATTRIBUTE] as const)
    ]) {
        const rect = el.getBoundingClientRect()
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue
        const area = rect.width * rect.height
        const id = el.getAttribute(attribute)
        if (id && (!best || area < best.area)) best = { id, area }
    }
    return best?.id ?? null
}

function visibleSessionContainers(doc: Document): Element[] {
    return visibleWith(doc, SESSION_ATTRIBUTE)
}

/** Hidden terminals stay laid out at full size with `visibility: hidden` (App.tsx), so size alone says nothing. */
function visibleWith(doc: Document, attribute: string): Element[] {
    const view = doc.defaultView
    return Array.from(doc.querySelectorAll(`[${attribute}]`)).filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && view?.getComputedStyle(el).visibility === 'visible'
    })
}

/** Main's view of the terminal, or null when it could not be had in time — the report goes out regardless. */
export async function loadTerminalContext(target: TerminalTarget | null): Promise<FeedbackTerminalContext | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            window.api.feedbackTerminalContext(target?.sessionId ?? null),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), CONTEXT_TIMEOUT_MS)
            })
        ])
    } catch {
        return null
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Terminal and window events go into the report's app log, where Lasso Run lists
 * warnings and errors: "renderer crashed, then the scrollback was erased" is the
 * first thing a reader needs, and the `extra` JSON is not where anyone looks.
 */
export function withTerminalEvents(
    diagnostics: DiagnosticsPayload | null,
    context: FeedbackTerminalContext | null
): DiagnosticsPayload | null {
    if (!context) return diagnostics
    const entries = [
        ...context.appEvents.map((event) => toLogEntry(event, 'app')),
        ...(context.terminal?.events ?? []).map((event) => toLogEntry(event, 'terminal'))
    ]
    if (entries.length === 0) return diagnostics
    const base = diagnostics ?? { network: [], logs: [], routes: [] }
    const logs = [...base.logs, ...entries].sort((a, b) => a.at.localeCompare(b.at))
    return { ...base, logs }
}

/** The part that goes into `extra` — events are already in the app log. */
export function terminalExtra(target: TerminalTarget | null, context: FeedbackTerminalContext | null): Record<string, unknown> {
    if (!context?.terminal) return target ? { terminal: { sessionId: target.sessionId, source: target.source, known: false } } : {}
    const state: Partial<FeedbackTerminalState> = { ...context.terminal }
    delete state.events
    return { terminal: { ...state, source: target?.source ?? null } }
}

function toLogEntry(event: TerminalEventRecord, scope: 'app' | 'terminal'): DiagLogEntry {
    const repeated = event.count ? ` ×${event.count}` : ''
    const detail = event.detail ? ` (${event.detail})` : ''
    return { level: levelOf(event), message: `[${scope}] ${event.kind}${detail}${repeated}`, at: event.at }
}

function levelOf(event: TerminalEventRecord): DiagLogEntry['level'] {
    if (event.kind === 'exited' && event.detail === 'exit code 0') return 'log'
    return EVENT_LEVELS[event.kind]
}
