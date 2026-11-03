import type { PhoneSession, PhoneSessionState } from '../../../shared/phone'

/**
 * The phone page's in-app alert — what ovis calls a droplet (ovis src/lib/droplet.ts ·
 * src/components/Droplet.tsx, checked by scripts/droplet-demo-regression.ts): while the page
 * is open, another session that starts waiting for you, or finishes a long turn, says so in
 * a pill under the header. Web push is for a closed page (sw.js stays quiet while the page
 * is in front), so without this a question in session B is only a dot in a list hidden
 * behind the drawer.
 *
 * Read from the session list the page already polls — no new message from the Mac.
 * Same defaults as ovis (shared/notify-policy.ts DEFAULT_ALERTS = { input: true, done: "long" }):
 * every question, and a finished turn only when it worked a minute or more.
 */

export type DropletKind = 'waiting' | 'finished'

export interface Droplet {
    sessionId: string
    name: string
    kind: DropletKind
    /** the question on screen, for `waiting` */
    detail?: string
}

/** What the page last saw of a session: its state and since when (ms) — or -Infinity when it was already so at first sight. */
export interface SeenState {
    state: PhoneSessionState
    since: number
}

/** A finished turn this long or longer is told (ovis LONG_TURN_MS). */
export const LONG_TURN_MS = 60_000
/** How long a droplet stays before it leaves by itself (ovis holds 3.6 s; a phone glance needs a little more). */
export const DROPLET_HOLD_MS = 6_000

/**
 * What changed between two polls of the list, for sessions other than the one open on the
 * phone (that one is already in front of the user). `previous` is null on the first load —
 * nothing is "new" then. A question wins over a finish.
 */
export function dropletFor(previous: ReadonlyMap<string, SeenState> | null, sessions: readonly PhoneSession[], openId: string | null, now: number): Droplet | null {
    if (!previous) return null
    let finished: Droplet | null = null
    for (const session of sessions) {
        if (session.id === openId) continue
        const before = previous.get(session.id)
        if (before === undefined) continue // a session new to the list is not news
        if (session.state === 'waiting' && before.state !== 'waiting') {
            return { sessionId: session.id, name: session.name, kind: 'waiting', ...(session.question ? { detail: session.question } : {}) }
        }
        // an agent's long turn ended: working → idle (an exit is not a finished turn)
        if (!finished && session.agent && before.state === 'working' && session.state === 'idle' && now - before.since >= LONG_TURN_MS) {
            finished = { sessionId: session.id, name: session.name, kind: 'finished' }
        }
    }
    return finished
}

/** The next memory of states: a state that did not change keeps its `since`. */
export function nextSeen(previous: ReadonlyMap<string, SeenState> | null, sessions: readonly PhoneSession[], now: number): Map<string, SeenState> {
    return new Map(
        sessions.map((session) => {
            const before = previous?.get(session.id)
            if (before && before.state === session.state) return [session.id, before]
            // first sight: we do not know when it started (ovis tells a turn it did not see start)
            return [session.id, { state: session.state, since: previous ? now : -Infinity }]
        })
    )
}

/** Sessions other than the open one that wait for an answer — the ☰ button's badge. */
export function waitingElsewhere(sessions: readonly PhoneSession[], openId: string | null): number {
    return sessions.filter((session) => session.id !== openId && session.state === 'waiting').length
}
