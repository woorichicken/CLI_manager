import type { TerminalSession, Workspace } from '../../../shared/types'

/**
 * Session links: `climanager://session/<ref>[,<ref>…]`
 *
 * An agent that says "go look at that session" prints one of these; clicking it
 * in a terminal shows that session. A ref is a full session id or its first
 * 8+ characters. Claude Code breaks words wider than the screen onto an
 * indented next line, which no link detector can rejoin — so agents print the
 * short form in terminals, and the full id where the text cannot wrap (a web
 * page, a chat message).
 *
 * Terminal output is untrusted. A session link only changes what is shown;
 * nothing in it is ever typed or run.
 */

export const SESSION_LINK_PROTOCOL = 'climanager:'
const SESSION_LINK_HOST = 'session'

/** Matches the split view's limit (SplitTerminalLayout holds 4). */
export const MAX_LINKED_SESSIONS = 4

const MIN_REF_LENGTH = 8
const UUID_LENGTH = 36
const REF_PATTERN = `[0-9a-fA-F][0-9a-fA-F-]{${MIN_REF_LENGTH - 1},${UUID_LENGTH - 1}}`
const REF_REGEX = new RegExp(`^${REF_PATTERN}$`)

/**
 * Terminal text that becomes a clickable session link. The trailing guard keeps
 * a ref from being cut out of a longer word (`…/02e9e098zz` is not a link).
 */
export const SESSION_LINK_REGEX = new RegExp(
    `climanager://session/${REF_PATTERN}(?:,${REF_PATTERN})*(?![0-9a-zA-Z-])`
)

/** Session refs in a link, lowercased and deduplicated; null if `uri` is not a session link. */
export function parseSessionLink(uri: string): string[] | null {
    let url: URL
    try {
        url = new URL(uri)
    } catch {
        return null
    }
    if (url.protocol !== SESSION_LINK_PROTOCOL || url.hostname !== SESSION_LINK_HOST) return null

    const refs: string[] = []
    for (const part of url.pathname.replace(/^\//, '').split(',')) {
        const ref = part.trim().toLowerCase()
        if (REF_REGEX.test(ref) && !refs.includes(ref)) refs.push(ref)
    }
    return refs.length > 0 ? refs : null
}

export interface LinkedSession {
    workspace: Workspace
    session: TerminalSession
}

export interface SessionLinkResolution {
    /** Sessions to show, in link order, at most MAX_LINKED_SESSIONS. */
    sessions: LinkedSession[]
    /** Refs that match no session — usually one that was closed. */
    missing: string[]
    /** Short refs that match more than one session. */
    ambiguous: string[]
    /** Sessions found beyond MAX_LINKED_SESSIONS. */
    overflow: number
}

/**
 * Finds the sessions a link points to. A short ref that matches two sessions
 * opens neither: showing the wrong one is worse than showing none.
 */
export function resolveSessionLink(refs: string[], workspaces: Workspace[]): SessionLinkResolution {
    const all: LinkedSession[] = workspaces.flatMap(workspace =>
        (workspace.sessions ?? []).map(session => ({ workspace, session }))
    )

    const found: LinkedSession[] = []
    const missing: string[] = []
    const ambiguous: string[] = []

    for (const ref of refs) {
        const exact = all.find(entry => entry.session.id.toLowerCase() === ref)
        const matches = exact ? [exact] : all.filter(entry => entry.session.id.toLowerCase().startsWith(ref))

        if (matches.length === 0) {
            missing.push(ref)
        } else if (matches.length > 1) {
            ambiguous.push(ref)
        } else if (!found.some(entry => entry.session.id === matches[0].session.id)) {
            found.push(matches[0])
        }
    }

    return {
        sessions: found.slice(0, MAX_LINKED_SESSIONS),
        missing,
        ambiguous,
        overflow: Math.max(0, found.length - MAX_LINKED_SESSIONS)
    }
}

/** What went wrong with a link, for a short on-screen notice; null if nothing did. */
export function describeSessionLinkProblems(resolution: SessionLinkResolution): string | null {
    const problems: string[] = []
    if (resolution.missing.length > 0) {
        problems.push(`Session not found: ${resolution.missing.join(', ')} (it may have been closed)`)
    }
    if (resolution.ambiguous.length > 0) {
        problems.push(`Matches more than one session: ${resolution.ambiguous.join(', ')} — use a longer id`)
    }
    if (resolution.overflow > 0) {
        problems.push(`Showing the first ${MAX_LINKED_SESSIONS} sessions — split view holds ${MAX_LINKED_SESSIONS}`)
    }
    return problems.length > 0 ? problems.join(' · ') : null
}
