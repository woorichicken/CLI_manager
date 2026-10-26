import { test, expect } from '@playwright/test'
import { SessionFolders, SESSION_FOLDERS_KEY } from '../../src/main/SessionFolders'
import type { SessionFolder, Workspace } from '../../src/shared/types'

/**
 * T57 — SessionFolders rules, without Electron: names, membership on the
 * session, one folder per session, and deleting a folder never touches a session.
 */

function fakeStore(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial }
    return { get: (key: string) => data[key], set: (key: string, value: unknown) => void (data[key] = value), data }
}

const workspace = (id: string, sessionIds: string[]): Workspace => ({
    id,
    name: id,
    path: `/tmp/${id}`,
    createdAt: 1,
    sessions: sessionIds.map(sid => ({ id: sid, name: sid, cwd: `/tmp/${id}`, type: 'regular' }))
} as Workspace)

const folderOf = (store: ReturnType<typeof fakeStore>, sessionId: string): string | undefined => {
    for (const w of store.data.workspaces as Workspace[]) {
        const found = w.sessions.find(s => s.id === sessionId)
        if (found) return found.sessionFolderId
    }
    return 'missing'
}

test.describe('T57 session folders', () => {
    test('a folder needs a name; it is stored expanded, and a stored value that is not a list reads as none', () => {
        const store = fakeStore({ [SESSION_FOLDERS_KEY]: 'garbage' })
        const folders = new SessionFolders(store)
        expect(folders.list()).toEqual([])
        expect(folders.create('   ')).toBeNull()
        const made = folders.create('  Release  ', 100)!
        expect(made).toMatchObject({ name: 'Release', isExpanded: true, createdAt: 100 })
        expect((store.data[SESSION_FOLDERS_KEY] as SessionFolder[]).map(f => f.name)).toEqual(['Release'])
        expect(folders.rename(made.id, ' ')).toBe(false)
        expect(folders.rename(made.id, 'Ship')).toBe(true)
        expect(folders.rename('nope', 'x')).toBe(false)
        expect(folders.list()[0].name).toBe('Ship')
    })

    test('a session sits in one folder at a time, kept on the session; null takes it out', () => {
        const store = fakeStore({ workspaces: [workspace('w1', ['a', 'b']), workspace('w2', ['c'])] })
        const folders = new SessionFolders(store)
        const one = folders.create('one')!
        const two = folders.create('two')!
        expect(folders.moveSession('c', one.id)).toBe(true)
        expect(folderOf(store, 'c')).toBe(one.id)
        expect(folders.moveSession('c', two.id)).toBe(true)
        expect(folderOf(store, 'c')).toBe(two.id)
        expect(folders.moveSession('c', null)).toBe(true)
        expect(folderOf(store, 'c')).toBeUndefined()
        // Unknown folder or session: nothing written.
        expect(folders.moveSession('a', 'no-such-folder')).toBe(false)
        expect(folders.moveSession('zzz', one.id)).toBe(false)
        expect(folderOf(store, 'a')).toBeUndefined()
    })

    test('deleting a folder empties it but keeps every session, and leaves other folders alone', () => {
        const store = fakeStore({ workspaces: [workspace('w1', ['a', 'b']), workspace('w2', ['c'])] })
        const folders = new SessionFolders(store)
        const gone = folders.create('gone')!
        const kept = folders.create('kept')!
        folders.moveSession('a', gone.id)
        folders.moveSession('c', gone.id)
        folders.moveSession('b', kept.id)
        expect(folders.remove(gone.id)).toBe(true)
        expect(folders.list().map(f => f.id)).toEqual([kept.id])
        expect((store.data.workspaces as Workspace[]).flatMap(w => w.sessions.map(s => s.id))).toEqual(['a', 'b', 'c'])
        expect(folderOf(store, 'a')).toBeUndefined()
        expect(folderOf(store, 'c')).toBeUndefined()
        expect(folderOf(store, 'b')).toBe(kept.id)
        expect(folders.remove(gone.id)).toBe(false)
    })

    test('expand state is set per folder in one write', () => {
        const store = fakeStore()
        const folders = new SessionFolders(store)
        const a = folders.create('a')!
        const b = folders.create('b')!
        expect(folders.setExpanded([a.id, b.id], false)).toBe(true)
        expect(folders.list().map(f => f.isExpanded)).toEqual([false, false])
        expect(folders.setExpanded([b.id], true)).toBe(true)
        expect(folders.list().map(f => f.isExpanded)).toEqual([false, true])
        expect(folders.setExpanded(['nope'], true)).toBe(false)
    })
})
