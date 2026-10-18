import type { FeedbackTerminalContext, SessionStatus } from '../shared/types'
import type { TerminalManager } from './TerminalManager'
import type { TerminalMirror } from './TerminalMirror'
import type { TerminalEventLog } from './TerminalEventLog'
import { maskSecretLines, type MaskOptions } from './maskSecrets'

/**
 * What a feedback report carries about the terminal it is about.
 *
 * Collected when the report is submitted, not when the widget opens: the point
 * is the state the person was looking at. Every report carries it (no opt-in) —
 * the widget only exists on machines that unlocked it with the tester password,
 * and its reports go to the team's own Lasso Run project.
 */

/** Logical lines (wrapped rows joined): about four screens, enough to see an error that scrolled away (~40KB at 200 columns). */
const RECENT_LINES = 200

/** Terminal ids are UUIDs; anything longer is not one of ours. */
const MAX_SESSION_ID_LENGTH = 128

export interface FeedbackTerminalSources {
    terminals: Pick<TerminalManager, 'hasTerminal'>
    mirror: Pick<TerminalMirror,
        'has' | 'flush' | 'logicalTail' | 'lineCount' | 'size' | 'lastOutputAt' | 'hasExited' | 'showsBusy' | 'showsAwaitingInput'>
    log: Pick<TerminalEventLog, 'events' | 'appEvents'>
    agentStatus: (id: string) => SessionStatus | null
    mask: MaskOptions
}

export async function buildFeedbackTerminalContext(
    sessionId: unknown,
    sources: FeedbackTerminalSources
): Promise<FeedbackTerminalContext> {
    const appEvents = sources.log.appEvents()
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) {
        return { appEvents, terminal: null }
    }
    const { terminals, mirror, log } = sources
    const events = log.events(sessionId)
    if (!mirror.has(sessionId) && !terminals.hasTerminal(sessionId) && events.length === 0) {
        return { appEvents, terminal: null }
    }

    // Output that just arrived may still be unparsed; the report should include it.
    await mirror.flush(sessionId)
    const { lines, masked } = maskSecretLines(mirror.logicalTail(sessionId, RECENT_LINES), sources.mask)
    const lastOutputAt = mirror.lastOutputAt(sessionId)
    return {
        appEvents,
        terminal: {
            sessionId,
            running: terminals.hasTerminal(sessionId) && !mirror.hasExited(sessionId),
            size: mirror.size(sessionId),
            historyLines: mirror.lineCount(sessionId),
            lastOutputAt: lastOutputAt > 0 ? new Date(lastOutputAt).toISOString() : null,
            screen: mirror.showsAwaitingInput(sessionId) ? 'awaiting-input' : mirror.showsBusy(sessionId) ? 'busy' : 'idle',
            agentStatus: sources.agentStatus(sessionId),
            events,
            recentLines: lines,
            maskedCount: masked
        }
    }
}
