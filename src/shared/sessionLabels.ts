/**
 * A session's role and tags — what the session is for, kept beside its name instead of in it
 * (decision 0015). The name stays the work summary; the role is one of a fixed list (it drives
 * the sidebar icon, the filter and an agent's selection, so a typo must not slip through), and
 * tags are free words.
 *
 * Pure: the store write (main), the Control API and the renderer all go through these, so every
 * path stores the same normalized value.
 */

export const SESSION_WORK_ROLES = ['lead', 'work', 'talk', 'watch'] as const
export type SessionWorkRole = (typeof SESSION_WORK_ROLES)[number]

/** Shown in menus, tooltips and the filter. English like the rest of the UI. */
export const SESSION_WORK_ROLE_LABELS: Record<SessionWorkRole, string> = {
    lead: 'Lead',
    work: 'Work',
    talk: 'Talk',
    watch: 'Watch'
}

/** One line of help per role, for the menu's tooltips. */
export const SESSION_WORK_ROLE_HINTS: Record<SessionWorkRole, string> = {
    lead: 'Hands out work and collects the results',
    work: 'Does one piece of work',
    talk: 'A person talks here — keep it open',
    watch: 'Watches other sessions or a batch'
}

/** Longest tag kept, in characters, after trimming. */
export const MAX_TAG_LENGTH = 32
/** Most tags one session keeps; later ones are dropped. */
export const MAX_TAGS_PER_SESSION = 8

export function isSessionWorkRole(value: unknown): value is SessionWorkRole {
    return typeof value === 'string' && (SESSION_WORK_ROLES as readonly string[]).includes(value)
}

/**
 * Reads a role given by a person or a client: a role id or its label in any case.
 * `null`, `''` and `'none'` clear it. Anything else is `'invalid'` — the caller refuses it
 * rather than storing nothing, so a typo shows.
 */
export function parseSessionWorkRole(value: unknown): SessionWorkRole | null | 'invalid' {
    if (value === null) return null
    if (typeof value !== 'string') return 'invalid'
    const word = value.trim().toLowerCase()
    if (word === '' || word === 'none') return null
    return isSessionWorkRole(word) ? word : 'invalid'
}

/**
 * One tag as stored: one line, outer spaces and a leading `#` dropped, inner runs of spaces
 * folded, cut to {@link MAX_TAG_LENGTH}. Empty when nothing is left.
 */
export function normalizeTag(value: string): string {
    const folded = value.replace(/[\r\n\t]+/g, ' ').trim().replace(/^#+/, '').trim().replace(/\s+/g, ' ')
    return Array.from(folded).slice(0, MAX_TAG_LENGTH).join('').trim()
}

/**
 * The tag list as stored. Non-strings and empties are dropped, duplicates are removed ignoring
 * case (the first spelling wins), and at most {@link MAX_TAGS_PER_SESSION} are kept, in order.
 */
export function normalizeTags(values: unknown): string[] {
    if (!Array.isArray(values)) return []
    const seen = new Set<string>()
    const tags: string[] = []
    for (const value of values) {
        if (typeof value !== 'string') continue
        const tag = normalizeTag(value)
        const key = tag.toLowerCase()
        if (!tag || seen.has(key)) continue
        seen.add(key)
        tags.push(tag)
        if (tags.length === MAX_TAGS_PER_SESSION) break
    }
    return tags
}

/** Splits what a person typed into a tag box ("a, b c" stays two tags: `a` and `b c`). */
export function splitTagInput(text: string): string[] {
    return normalizeTags(text.split(','))
}

export interface SessionLabels {
    role?: SessionWorkRole
    tags?: string[]
}

export interface SessionLabelsChange {
    /** Omitted: keep. `null`: clear. */
    role?: SessionWorkRole | null
    /** Omitted: keep. Replaces the whole list (normalized); `[]` clears. */
    tags?: unknown
}

/**
 * Writes a change onto a stored session in place. Unset fields are deleted, not left as `null`
 * or `[]`, so a session with neither looks exactly like one from before labels existed.
 * Returns whether anything changed.
 */
export function applySessionLabels(session: SessionLabels, change: SessionLabelsChange): boolean {
    let changed = false
    if (change.role !== undefined) {
        const next = change.role ?? undefined
        if (session.role !== next) {
            if (next) session.role = next
            else delete session.role
            changed = true
        }
    }
    if (change.tags !== undefined) {
        const next = normalizeTags(change.tags)
        const before = session.tags ?? []
        if (next.length !== before.length || next.some((tag, i) => tag !== before[i])) {
            if (next.length) session.tags = next
            else delete session.tags
            changed = true
        }
    }
    return changed
}

export interface SessionLabelFilter {
    role?: SessionWorkRole | null
    /** Matched ignoring case and a leading `#`. */
    tag?: string | null
}

/** True when the session has the filter's role and tag (each one only when set). */
export function matchesSessionLabels(session: SessionLabels, filter: SessionLabelFilter): boolean {
    if (filter.role && session.role !== filter.role) return false
    if (filter.tag) {
        const want = normalizeTag(filter.tag).toLowerCase()
        if (want && !(session.tags ?? []).some((tag) => tag.toLowerCase() === want)) return false
    }
    return true
}

/** Every tag in use, the most used first, then by name — the editor's suggestions and the filter list. */
export function tagsInUse(sessions: SessionLabels[]): string[] {
    const counts = new Map<string, { tag: string; count: number }>()
    for (const session of sessions) {
        for (const tag of session.tags ?? []) {
            const key = tag.toLowerCase()
            const entry = counts.get(key)
            if (entry) entry.count++
            else counts.set(key, { tag, count: 1 })
        }
    }
    return [...counts.values()]
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
        .map((entry) => entry.tag)
}

/** Tooltip text: "Role: Work · #night-1125 #sidebar", or '' for a session with neither. */
export function describeSessionLabels(session: SessionLabels): string {
    const parts: string[] = []
    if (session.role) parts.push(`Role: ${SESSION_WORK_ROLE_LABELS[session.role]}`)
    if (session.tags?.length) parts.push(session.tags.map((tag) => `#${tag}`).join(' '))
    return parts.join(' · ')
}
