import { test, expect } from '@playwright/test'
import { SessionRelations, SESSION_RELATIONS_KEY, RelationStore } from '../../src/main/SessionRelations'
import { lastMeaningfulLine, recapOf, screenSummary } from '../../src/main/screenLines'
import {
    addableSessions,
    isTalkSession,
    relatedCounts,
    relatedSessionsFor
} from '../../src/renderer/src/utils/relatedSessions'
import type { SessionRelation, TerminalSession, Workspace } from '../../src/shared/types'

/**
 * T34 — Related sessions, pure logic (no Electron).
 *
 * The store is a plain object standing in for electron-store; "restart" is a
 * new SessionRelations over the same object, which is what the app does when
 * it starts and reads config.json again.
 */

class MemoryStore implements RelationStore {
    readonly data: Record<string, unknown> = {}
    get(key: string): unknown {
        return this.data[key]
    }
    set(key: string, value: unknown): void {
        // A deep copy, as a JSON file would hold it.
        this.data[key] = JSON.parse(JSON.stringify(value))
    }
}

function session(id: string, name = id, memo?: string): TerminalSession {
    return { id, name, cwd: '/tmp', type: 'regular', ...(memo ? { memo } : {}) }
}

function workspace(id: string, sessions: TerminalSession[]): Workspace {
    return { id, name: id, path: '/tmp', sessions, createdAt: 0 } as Workspace
}

test.describe('SessionRelations (main)', () => {
    test('records an open, and keeps it across a restart', () => {
        const store = new MemoryStore()
        const announced: SessionRelation[][] = []
        const relations = new SessionRelations(store, visible => announced.push(visible))

        relations.recordOpened('lead', 'worker', 100)
        expect(relations.list()).toEqual([{ from: 'lead', to: 'worker', kind: 'opened', at: 100 }])
        expect(announced).toHaveLength(1)

        const afterRestart = new SessionRelations(store)
        expect(afterRestart.list()).toEqual([{ from: 'lead', to: 'worker', kind: 'opened', at: 100 }])
        expect(store.data[SESSION_RELATIONS_KEY]).toHaveLength(1)
    })

    test('a connection counts only on first contact, in either direction', () => {
        const relations = new SessionRelations(new MemoryStore())
        relations.recordConnected('lead', 'talk', 100)
        relations.recordConnected('lead', 'talk', 200)
        relations.recordConnected('talk', 'lead', 300)
        expect(relations.list()).toEqual([{ from: 'lead', to: 'talk', kind: 'connected', at: 100 }])

        // An open already recorded wins over a later connection.
        relations.recordOpened('lead', 'worker', 400)
        relations.recordConnected('lead', 'worker', 500)
        expect(relations.list().find(r => r.to === 'worker')?.kind).toBe('opened')

        relations.recordConnected('lead', 'lead', 600)
        relations.recordOpened('lead', 'lead', 600)
        expect(relations.list()).toHaveLength(2)
    })

    test('removing by hand hides it and keeps the next API call from putting it back', () => {
        const store = new MemoryStore()
        const relations = new SessionRelations(store)
        relations.recordConnected('lead', 'talk', 100)

        expect(relations.remove('talk', 'lead')).toBe(true)
        expect(relations.list()).toEqual([])
        relations.recordConnected('lead', 'talk', 200)
        expect(relations.list()).toEqual([])
        expect(new SessionRelations(store).list()).toEqual([])
        expect(relations.remove('talk', 'lead')).toBe(false)

        // Adding it by hand brings it back as a manual relation.
        expect(relations.add('talk', 'lead', 300)).toBe(true)
        expect(relations.list()).toEqual([{ from: 'talk', to: 'lead', kind: 'manual', at: 300 }])
    })

    test('adding by hand leaves a pair that is already shown alone', () => {
        const relations = new SessionRelations(new MemoryStore())
        relations.recordOpened('lead', 'worker', 100)
        expect(relations.add('worker', 'lead', 200)).toBe(false)
        expect(relations.add('lead', 'lead', 200)).toBe(false)
        expect(relations.list()).toEqual([{ from: 'lead', to: 'worker', kind: 'opened', at: 100 }])
    })

    test('a closed session takes every relation it was in with it, removed ones too', () => {
        const store = new MemoryStore()
        const relations = new SessionRelations(store)
        relations.recordOpened('lead', 'worker', 100)
        relations.recordConnected('other', 'worker', 110)
        relations.add('site', 'worker', 120)
        relations.remove('site', 'worker')
        relations.recordOpened('lead', 'second', 130)

        relations.forget('worker')
        expect(relations.list()).toEqual([{ from: 'lead', to: 'second', kind: 'opened', at: 130 }])
        expect(store.data[SESSION_RELATIONS_KEY]).toHaveLength(1)
    })

    test('startup drops relations to sessions that no longer exist', () => {
        const relations = new SessionRelations(new MemoryStore())
        relations.recordOpened('lead', 'worker', 100)
        relations.recordOpened('lead', 'gone', 110)
        relations.prune(new Set(['lead', 'worker']))
        expect(relations.list().map(r => r.to)).toEqual(['worker'])
    })

    test('a store holding something other than a list reads as empty', () => {
        const store = new MemoryStore()
        store.data[SESSION_RELATIONS_KEY] = { not: 'a list' }
        expect(new SessionRelations(store).list()).toEqual([])
    })
})

test.describe('relatedSessionsFor (renderer)', () => {
    const WORKSPACES = [
        workspace('w1', [session('lead'), session('worker'), session('talk', '대화: 설계 논의', 'ask about the API')]),
        workspace('w2', [session('site'), session('boss')])
    ]
    const RELATIONS: SessionRelation[] = [
        { from: 'lead', to: 'worker', kind: 'opened', at: 100 },
        { from: 'lead', to: 'talk', kind: 'connected', at: 300 },
        { from: 'boss', to: 'lead', kind: 'opened', at: 50 },
        { from: 'site', to: 'lead', kind: 'manual', at: 200 },
        { from: 'lead', to: 'closed-session', kind: 'opened', at: 400 },
        { from: 'lead', to: 'boss', kind: 'manual', at: 500, dismissed: true },
        { from: 'worker', to: 'talk', kind: 'opened', at: 600 }
    ]

    test('groups by direction and kind, newest first, skipping closed and removed ones', () => {
        const groups = relatedSessionsFor(RELATIONS, 'lead', WORKSPACES)
        expect(groups.fromHere.map(e => [e.session.id, e.kind])).toEqual([['talk', 'connected'], ['worker', 'opened']])
        expect(groups.toHere.map(e => e.session.id)).toEqual(['boss'])
        expect(groups.manual.map(e => [e.session.id, e.workspace.id])).toEqual([['site', 'w2']])
        expect(groups.total).toBe(4)
    })

    test('the other side sees the same relation from its end', () => {
        const groups = relatedSessionsFor(RELATIONS, 'site', WORKSPACES)
        expect(groups.manual.map(e => e.session.id)).toEqual(['lead'])
        expect(relatedSessionsFor(RELATIONS, 'worker', WORKSPACES).toHere.map(e => e.session.id)).toEqual(['lead'])
    })

    test('a session that is gone has nothing', () => {
        expect(relatedSessionsFor(RELATIONS, 'closed-session', WORKSPACES).total).toBe(0)
    })

    test('counts match what the dialog lists', () => {
        const counts = relatedCounts(RELATIONS, WORKSPACES)
        for (const id of ['lead', 'worker', 'talk', 'site', 'boss']) {
            expect(counts.get(id) ?? 0, id).toBe(relatedSessionsFor(RELATIONS, id, WORKSPACES).total)
        }
    })

    test('addable sessions leave out this one and the related ones, and filter by name', () => {
        const related = new Set(['worker', 'talk'])
        expect(addableSessions(WORKSPACES, 'lead', related, '').map(e => e.session.id)).toEqual(['site', 'boss'])
        expect(addableSessions(WORKSPACES, 'lead', related, 'W2').map(e => e.session.id)).toEqual(['site', 'boss'])
        expect(addableSessions(WORKSPACES, 'lead', new Set(), '설계').map(e => e.session.id)).toEqual(['talk'])
    })

    test('talk sessions are told by their name', () => {
        expect(isTalkSession('대화: 설계 논의')).toBe(true)
        expect(isTalkSession('  대화:x')).toBe(true)
        expect(isTalkSession('worker 대화: no')).toBe(false)
        expect(isTalkSession('대화 설계')).toBe(false)
    })
})

test.describe('lastMeaningfulLine', () => {
    const RULE = '─'.repeat(40)

    test('reads above an agent input box, skipping its hints', () => {
        const rows = [
            '⏺ Wrote 3 files',
            '  ⎿  Ran 12 tests, all passed',
            '',
            RULE,
            '❯ next prompt here',
            RULE,
            '  ? for shortcuts'
        ]
        expect(lastMeaningfulLine(rows)).toBe('⎿ Ran 12 tests, all passed')
    })

    test('a shell screen gives its last non-blank row', () => {
        expect(lastMeaningfulLine(['$ npm test', 'PASS  src/a.test.ts', 'user@host repo %', '', ''])).toBe('user@host repo %')
    })

    test('blank and drawing-only screens give nothing', () => {
        expect(lastMeaningfulLine([])).toBe('')
        expect(lastMeaningfulLine(['', '   ', RULE, '╭────╮', '│    │', '╰────╯'])).toBe('')
    })

    test('a very long row is cut', () => {
        const line = lastMeaningfulLine(['x'.repeat(500)])
        expect(line.length).toBe(200)
        expect(line.endsWith('…')).toBe(true)
    })
})

// 9f4f923e: with an agent input box the dialog showed the recap's tail ("/config)") or a timer
// ("✻ Churned for 1m 13s"); now it shows the recap whole, or nothing.
test.describe('screenSummary', () => {
    const RULE = '─'.repeat(40)
    const BOX = [RULE, '❯ ', RULE, '  ? for shortcuts']
    const RECAP = [
        '✻ Brewed for 1m 24s · done 9:43 PM · 1 shell still running',
        '',
        '※ recap: 대화 세션 16개에서 정한 내용을 총괄 폴더로 정리하려고, 방법과 기준을 제안해 둔 상태입니다.',
        '  그 기준대로 정리 파일이 없는 7개부터 돌릴지 답만 주시면 바로 시작합니다. (disable recaps in /config)',
        ''
    ]
    const WHOLE = '대화 세션 16개에서 정한 내용을 총괄 폴더로 정리하려고, 방법과 기준을 제안해 둔 상태입니다. 그 기준대로 정리 파일이 없는 7개부터 돌릴지 답만 주시면 바로 시작합니다.'

    test('an agent screen gives its recap whole, without the hint', () => {
        expect(screenSummary([...RECAP, ...BOX])).toEqual({ text: WHOLE, isRecap: true })
        // The old reading took the row above the box: the recap's last fragment.
        expect(lastMeaningfulLine([...RECAP, ...BOX])).not.toBe(WHOLE)
    })

    test('an agent screen without a recap gives nothing', () => {
        expect(screenSummary(['⏺ Done.', '', '✻ Churned for 1m 13s · done 12:42 AM', '', ...BOX])).toEqual({ text: '', isRecap: false })
    })

    test('the last recap wins, and rows after it are not part of it', () => {
        const rows = ['※ recap: first turn.', '', '❯ go on', '⏺ ok', '', '※ recap: second turn,', '  still going.', '⏺ next', ...BOX]
        expect(recapOf(rows)).toBe('second turn, still going.')
    })

    test('a screen without an input box keeps the last row (a shell prompt with its path)', () => {
        expect(screenSummary(['$ ls', 'a b', 'user@host deep/path/repo %'])).toEqual({ text: 'user@host deep/path/repo %', isRecap: false })
    })

    test('a hint-only recap reads as nothing', () => {
        expect(recapOf(['※ recap: (disable recaps in /config)'])).toBe('')
    })
})
