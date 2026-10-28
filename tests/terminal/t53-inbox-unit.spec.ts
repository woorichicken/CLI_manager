import { test, expect } from '@playwright/test'
import {
    checkInboxInput,
    InboxStore,
    INBOX_KEY,
    INBOX_MAX_REQUESTS,
    INBOX_READ_RETENTION_MS,
    INBOX_TEXT_MAX
} from '../../src/main/InboxStore'
import type { InboxRequest } from '../../src/shared/types'

/**
 * T53 — InboxStore rules, without Electron: input checks, the repeat rule,
 * the 200 cap, read retention, and what goes when a session goes.
 */

function fakeStore(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial }
    return { get: (key: string) => data[key], set: (key: string, value: unknown) => void (data[key] = value), data }
}

const base = { sessionId: 's1', kind: 'login' as const, text: 'Sign in', client: 'test' }

test.describe('T53 inbox store', () => {
    test('input: kind defaults to other, text folds to one line and is cut at 200, links are checked', () => {
        expect(checkInboxInput({ text: 'a\n\tb  c ' })).toEqual({ ok: true, kind: 'other', text: 'a b c' })
        const long = checkInboxInput({ kind: 'review', text: 'x'.repeat(250) })
        expect(long.ok && long.text.length).toBe(INBOX_TEXT_MAX)
        expect(checkInboxInput({ kind: 'nope', text: 'x' }).ok).toBe(false)
        expect(checkInboxInput({ text: '   ' }).ok).toBe(false)
        expect(checkInboxInput({}).ok).toBe(false)
        expect(checkInboxInput({ text: 'x', url: '' })).toEqual({ ok: true, kind: 'other', text: 'x' })
        expect(checkInboxInput({ text: 'x', url: 'https://example.com/a' })).toMatchObject({ ok: true, url: 'https://example.com/a' })
        expect(checkInboxInput({ text: 'x', url: 'obsidian://open?vault=v' })).toMatchObject({ ok: true })
        for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'vbscript:x', 'blob:https://a/b', 'about:blank', 'relative/path', 42]) {
            expect(checkInboxInput({ text: 'x', url: bad }).ok, String(bad)).toBe(false)
        }
        expect(checkInboxInput({ text: 'x', url: `https://e.com/${'a'.repeat(2000)}` }).ok).toBe(false)
    })

    test('the same unread request is kept once and moves to the top; after it is read a repeat is new', () => {
        const store = fakeStore()
        const changes: number[] = []
        const inbox = new InboxStore(store, (all) => changes.push(all.length))
        const first = inbox.add(base, 1000)
        inbox.add({ ...base, sessionId: 's2', text: 'Other' }, 2000)
        const repeat = inbox.add({ ...base, url: 'https://e.com/new' }, 3000)
        expect(repeat.created).toBe(false)
        expect(repeat.request.id).toBe(first.request.id)
        expect(inbox.list().map((r) => [r.sessionId, r.at, r.url])).toEqual([['s1', 3000, 'https://e.com/new'], ['s2', 2000, undefined]])
        expect(inbox.list()[0].createdAt).toBe(1000)
        // Another kind or another session is another request.
        expect(inbox.add({ ...base, kind: 'question' }, 3500).created).toBe(true)
        inbox.markRead(first.request.id, 4000)
        expect(inbox.add(base, 5000).created).toBe(true)
        expect(inbox.unreadCount()).toBe(3)
        expect(changes.length).toBeGreaterThan(0)
    })

    test('reading: one, all; unknown id is null', () => {
        const inbox = new InboxStore(fakeStore())
        const a = inbox.add(base, 1).request
        inbox.add({ ...base, text: 'two' }, 2)
        inbox.add({ ...base, sessionId: 's2' }, 3)
        expect(inbox.markRead('nope')).toBeNull()
        expect(inbox.markRead(a.id, 10)?.readAt).toBe(10)
        expect(inbox.markRead(a.id, 20)?.readAt).toBe(10)
        // Reading one leaves the others — even the same session's (report b165acc4).
        expect(inbox.list({ unreadOnly: true }).map((r) => `${r.sessionId}:${r.text}`)).toEqual(['s2:Sign in', 's1:two'])
        expect(inbox.markAllRead(40)).toBe(2)
        expect(inbox.unreadCount()).toBe(0)
    })

    test('over 200, the oldest read requests go first, then the oldest unread', () => {
        const inbox = new InboxStore(fakeStore())
        for (let i = 0; i < INBOX_MAX_REQUESTS; i++) inbox.add({ ...base, text: `r${i}` }, i)
        inbox.markRead(inbox.list().find((r) => r.text === 'r150')!.id)
        inbox.add({ ...base, text: 'new1' }, 1000)
        expect(inbox.list()).toHaveLength(INBOX_MAX_REQUESTS)
        expect(inbox.list().some((r) => r.text === 'r150')).toBe(false)
        expect(inbox.list().some((r) => r.text === 'r0')).toBe(true)
        inbox.add({ ...base, text: 'new2' }, 1001)
        expect(inbox.list()).toHaveLength(INBOX_MAX_REQUESTS)
        expect(inbox.list().some((r) => r.text === 'r0')).toBe(false)
    })

    test('a closed session takes its requests; startup drops missing sessions and old read ones', () => {
        const now = 100 * INBOX_READ_RETENTION_MS
        const seeded: InboxRequest[] = [
            { id: 'old-read', sessionId: 's1', kind: 'login', text: 'a', at: 1, createdAt: 1, readAt: now - INBOX_READ_RETENTION_MS - 1, client: 't' },
            { id: 'fresh-read', sessionId: 's1', kind: 'login', text: 'b', at: 2, createdAt: 2, readAt: now - 1000, client: 't' },
            { id: 'old-unread', sessionId: 's1', kind: 'login', text: 'c', at: 3, createdAt: 3, client: 't' },
            { id: 'gone', sessionId: 'gone', kind: 'login', text: 'd', at: 4, createdAt: 4, client: 't' },
            { id: 's2-req', sessionId: 's2', kind: 'login', text: 'e', at: 5, createdAt: 5, client: 't' }
        ]
        const store = fakeStore({ [INBOX_KEY]: seeded })
        const inbox = new InboxStore(store)
        inbox.prune(new Set(['s1', 's2']), now)
        expect(inbox.list().map((r) => r.id).sort()).toEqual(['fresh-read', 'old-unread', 's2-req'])
        inbox.forget('s1')
        expect(inbox.list().map((r) => r.id)).toEqual(['s2-req'])
        expect((store.data[INBOX_KEY] as InboxRequest[]).map((r) => r.id)).toEqual(['s2-req'])
    })
})
