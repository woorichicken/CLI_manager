import { test, expect } from '@playwright/test'
import { MAX_SESSION_MENTIONS, sessionMentionText, sessionMentionsFor } from '../../src/renderer/src/utils/sessionMentions'
import type { SessionRelation, TerminalSession, Workspace } from '../../src/shared/types'

/**
 * T170 — the Chat box's `@` session list (89755e23), pure logic (no Electron).
 *
 * Order: Below (what this session opened, the Related window's tree order) → Beside → Above → Also related →
 * every other session, the most recently viewed first. Itself and answer threads are left out.
 */

const session = (id: string, name = id): TerminalSession => ({ id, name, cwd: '/tmp', type: 'regular' })
const workspace = (id: string, name: string, sessions: TerminalSession[]): Workspace => ({ id, name, path: '/tmp', sessions, createdAt: 0 }) as Workspace
const rel = (from: string, to: string, at: number, extra: Partial<SessionRelation> = {}): SessionRelation => ({ from, to, kind: 'opened', at, ...extra })

const ME = 'aaaaaaaa-0000-4000-8000-000000000001'
const KID_OLD = 'bbbbbbbb-0000-4000-8000-000000000002'
const KID_NEW = 'bbbbbbbb-0000-4000-8000-000000000003'
const GRANDKID = 'bbbbbbbb-0000-4000-8000-000000000004'
const PARENT = 'cccccccc-0000-4000-8000-000000000005'
const SIBLING = 'dddddddd-0000-4000-8000-000000000006'
const HAND = 'eeeeeeee-0000-4000-8000-000000000007'
const STRANGER_A = 'ffffffff-0000-4000-8000-000000000008'
const STRANGER_B = 'ffffffff-0000-4000-8000-000000000009'
const THREAD = '11111111-0000-4000-8000-00000000000a'

const WORKSPACES = [
    workspace('w1', 'Alpha project', [session(ME, 'Me'), session(KID_OLD, 'Kid old'), session(KID_NEW, 'Kid new'), session(GRANDKID, 'Grandkid'), session(PARENT, 'Parent'), session(SIBLING, 'Sibling')]),
    workspace('w2', 'Zeta workspace', [session(HAND, 'Hand added'), session(STRANGER_A, 'Stranger A'), session(STRANGER_B, 'Stranger B'), session(THREAD, 'Thread reply')])
]
const RELATIONS: SessionRelation[] = [
    rel(ME, KID_OLD, 1),
    rel(ME, KID_NEW, 2),
    rel(KID_NEW, GRANDKID, 3),
    rel(PARENT, ME, 4),
    rel(PARENT, SIBLING, 5),
    // a reply thread: it opened with an anchor, so the sidebar hides it and so does the menu
    rel(ME, THREAD, 6, { anchor: { turnTs: '2026-11-25T00:00:00Z' } }),
    // dropped on this session by hand, but a newer hand-added parent keeps it in the tree: «also related»
    { from: ME, to: HAND, kind: 'manual', at: 7 },
    { from: STRANGER_A, to: HAND, kind: 'manual', at: 8 }
]
const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id)

test.describe('T170 session mentions', () => {
    test('T170 order: below (tree order), beside, above, related, then the rest by recent view', () => {
        const rows = sessionMentionsFor({ relations: RELATIONS, sessionId: ME, workspaces: WORKSPACES, viewedIds: [STRANGER_B, STRANGER_A] })
        expect(ids(rows)).toEqual([KID_NEW, GRANDKID, KID_OLD, SIBLING, PARENT, HAND, STRANGER_B, STRANGER_A])
        expect(rows.map((row) => row.relation)).toEqual(['below', 'below', 'below', 'beside', 'above', 'also', undefined, undefined])
        expect(rows[0]).toMatchObject({ name: 'Kid new', workspace: 'Alpha project' })
    })

    test('T170 the session itself and its answer threads are never offered, a closed session is gone', () => {
        const rows = sessionMentionsFor({ relations: RELATIONS, sessionId: ME, workspaces: WORKSPACES })
        expect(ids(rows)).not.toContain(ME)
        expect(ids(rows)).not.toContain(THREAD)
        const closed = WORKSPACES.map((w) => ({ ...w, sessions: w.sessions.filter((s) => s.id !== KID_OLD) }))
        expect(ids(sessionMentionsFor({ relations: RELATIONS, sessionId: ME, workspaces: closed }))).not.toContain(KID_OLD)
    })

    test('T170 query: every word must be in the session or workspace name, any case', () => {
        const by = (query: string) => ids(sessionMentionsFor({ relations: RELATIONS, sessionId: ME, workspaces: WORKSPACES, query }))
        expect(by('KID')).toEqual([KID_NEW, GRANDKID, KID_OLD])
        expect(by('zeta stranger')).toEqual([STRANGER_A, STRANGER_B])
        expect(by('zeta kid')).toEqual([])
        expect(by('alpha  par')).toEqual([PARENT])
        expect(by('')).toHaveLength(8)
    })

    test('T170 the list is capped, and a session with no relations still gets the rest', () => {
        const many = workspace('w3', 'Many', Array.from({ length: 20 }, (_, i) => session(`s${String(i).padStart(2, '0')}-0000-4000-8000-0000000000${i}`, `Session ${i}`)))
        const rows = sessionMentionsFor({ relations: [], sessionId: many.sessions[0].id, workspaces: [many] })
        expect(rows).toHaveLength(MAX_SESSION_MENTIONS)
        expect(rows.every((row) => row.relation === undefined)).toBe(true)
        expect(ids(rows)).not.toContain(many.sessions[0].id)
    })

    test('T170 the text a pick leaves in the box: the name and a short session link', () => {
        expect(sessionMentionText({ id: KID_NEW, name: 'Kid new' })).toBe('Kid new (climanager://session/bbbbbbbb)')
    })
})
