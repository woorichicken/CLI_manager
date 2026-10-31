import { test, expect } from '@playwright/test'
import {
    CHECKLIST_ITEMS_MAX,
    CHECKLIST_TEXT_MAX,
    CHECKLISTS_KEY,
    CHECKLISTS_MAX,
    ChecklistStore,
    checkChecklistInput,
    checkItemTexts,
    isDueDate
} from '../../src/main/ChecklistStore'
import { daysBetween, describeDue } from '../../src/renderer/src/utils/dueDate'
import type { Checklist } from '../../src/shared/types'

/**
 * T70 — checklist rules, without Electron: input checks, the header order (‹ ›), the
 * repeat rules for checklists and items, item edits, references by id or title, what a
 * removed workspace does, the caps, and how a deadline reads.
 */

function fakeStore(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial }
    return { get: (key: string) => data[key], set: (key: string, value: unknown) => void (data[key] = value), data }
}

const make = (store: ChecklistStore, title: string, extra: { due?: string; workspaceId?: string; items?: string[] } = {}, now = 1000) =>
    store.create({ title, client: 'test', ...extra }, now)!.checklist

test.describe('T70 checklists', () => {
    test('input: title folds to one line and is cut at 200, due must be a real date, items are strings', () => {
        expect(checkChecklistInput({ title: ' a\n\tb  c ' }, { requireTitle: true })).toEqual({ ok: true, title: 'a b c' })
        const long = checkChecklistInput({ title: 'x'.repeat(250) }, { requireTitle: true })
        expect(long.ok && long.title?.length).toBe(CHECKLIST_TEXT_MAX)
        for (const bad of [undefined, '   ', 42]) {
            expect(checkChecklistInput({ title: bad }, { requireTitle: true }).ok, String(bad)).toBe(false)
        }
        expect(checkChecklistInput({ title: 'x', due: '2026-11-03' }, { requireTitle: true })).toEqual({ ok: true, title: 'x', due: '2026-11-03' })
        for (const bad of ['2026-02-30', '26-11-03', 'tomorrow', 20261103]) {
            expect(checkChecklistInput({ title: 'x', due: bad }, { requireTitle: true }).ok, String(bad)).toBe(false)
        }
        expect(isDueDate('2028-02-29')).toBe(true)
        expect(isDueDate('2027-02-29')).toBe(false)
        expect(checkChecklistInput({ due: null }, { requireTitle: false })).toEqual({ ok: true, due: null })
        expect(checkChecklistInput({ due: '' }, { requireTitle: false })).toEqual({ ok: true, due: null })
        expect(checkChecklistInput({}, { requireTitle: false })).toEqual({ ok: true })

        expect(checkItemTexts('one')).toEqual({ ok: true, texts: ['one'] })
        expect(checkItemTexts(['a\nb', '  ', 'c'])).toEqual({ ok: true, texts: ['a b', 'c'] })
        expect(checkItemTexts([1, 'a']).ok).toBe(false)
        expect(checkItemTexts({ text: 'a' }).ok).toBe(false)
    })

    test('order: open first by nearest deadline, undated after in the order made, finished last (latest first)', () => {
        const store = new ChecklistStore(fakeStore())
        make(store, 'undated old', {}, 1000)
        make(store, 'later', { due: '2026-12-01' }, 2000)
        make(store, 'sooner', { due: '2026-11-01' }, 3000)
        make(store, 'empty is open', {}, 4000)
        const finishedFirst = make(store, 'finished first', { items: ['x'] }, 5000)
        const finishedSecond = make(store, 'finished second', { items: ['y'], due: '2026-10-01' }, 6000)
        store.updateItem(finishedFirst.id, finishedFirst.items[0].id, { done: true }, 7000)
        store.updateItem(finishedSecond.id, finishedSecond.items[0].id, { done: true }, 8000)

        expect(store.list().map((c) => c.title)).toEqual([
            'sooner', 'later', 'undated old', 'empty is open', 'finished second', 'finished first'
        ])
        expect(store.list({ status: 'open' }).length).toBe(4)
        expect(store.list({ status: 'done' }).map((c) => c.title)).toEqual(['finished second', 'finished first'])
    })

    test('the same open title is reused: missing items are added, a new due or project replaces the old', () => {
        const changes: number[] = []
        const store = new ChecklistStore(fakeStore(), (all) => changes.push(all.length))
        const first = store.create({ title: 'v1.24 release', items: ['Build', 'Publish'], due: '2026-11-03', client: 'test' }, 1000)!
        expect(first.created).toBe(true)

        const same = store.create({ title: 'V1.24 Release', items: ['build', 'Publish'], client: 'test' }, 2000)!
        expect(same).toMatchObject({ created: false, checklist: { id: first.checklist.id, due: '2026-11-03' } })
        expect(changes).toEqual([1])   // nothing written for a plain repeat

        const more = store.create({ title: 'v1.24 release', items: ['Announce'], due: '2026-11-04', workspaceId: 'ws', client: 'test' }, 3000)!
        expect(more.created).toBe(false)
        expect(more.checklist.items.map((i) => i.text)).toEqual(['Build', 'Publish', 'Announce'])
        expect(more.checklist).toMatchObject({ due: '2026-11-04', workspaceId: 'ws' })

        // Once every item is checked, the same title starts a new checklist.
        for (const item of more.checklist.items) store.updateItem(more.checklist.id, item.id, { done: true }, 4000)
        expect(store.create({ title: 'v1.24 release', client: 'test' }, 5000)!.created).toBe(true)
        expect(store.list().length).toBe(2)
    })

    test('items: added at the end without repeats, checked in place, renamed, removed; a no-op writes nothing', () => {
        const changes: number[] = []
        const store = new ChecklistStore(fakeStore(), (all) => changes.push(all.length))
        const list = make(store, 'Docs', { items: ['One', 'Two'] })
        const added = store.addItems(list.id, ['Three', 'one', 'Four'], 2000)!
        expect(added.added).toBe(2)
        expect(added.checklist.items.map((i) => i.text)).toEqual(['One', 'Two', 'Three', 'Four'])

        const [one, two] = added.checklist.items
        const checked = store.updateItem(list.id, two.id, { done: true }, 3000)!
        expect(checked.items.map((i) => i.text)).toEqual(['One', 'Two', 'Three', 'Four'])   // order is the plan
        expect(checked.items[1].doneAt).toBe(3000)
        expect(store.updateItem(list.id, two.id, { done: true }, 4000)!.items[1].doneAt).toBe(3000)
        expect('doneAt' in store.updateItem(list.id, two.id, { done: false }, 5000)!.items[1]).toBe(false)

        expect(store.updateItem(list.id, one.id, { text: 'One, renamed' }, 6000)!.items[0].text).toBe('One, renamed')
        const before = changes.length
        store.updateItem(list.id, one.id, { text: 'One, renamed' }, 7000)
        expect(changes.length).toBe(before)
        expect(store.updateItem(list.id, 'nope', { done: true })).toBeNull()
        expect(store.updateItem('nope', one.id, { done: true })).toBeNull()

        expect(store.removeItem(list.id, one.id, 8000)!.items.map((i) => i.text)).toEqual(['Two', 'Three', 'Four'])
        expect(store.removeItem(list.id, one.id)).toBeNull()
    })

    test('update: title, due and project (null clears); resolve by id or title, two of a title is ambiguous', () => {
        const store = new ChecklistStore(fakeStore())
        const list = make(store, 'Release', { due: '2026-11-03', workspaceId: 'ws' })
        const renamed = store.update(list.id, { title: 'Release v1.24', due: null, workspaceId: null }, 2000)!
        expect(renamed.title).toBe('Release v1.24')
        expect('due' in renamed || 'workspaceId' in renamed).toBe(false)
        expect(store.update('nope', { title: 'x' })).toBeNull()

        expect(store.resolve(list.id)).toMatchObject({ id: list.id })
        expect(store.resolve('  release   V1.24 ')).toMatchObject({ id: list.id })
        expect(store.resolve('Nope')).toBeNull()
        // The repeat rule keeps open titles apart; a finished one may share its title with a new one.
        const finished = make(store, 'Twice', { items: ['a'] })
        store.updateItem(finished.id, finished.items[0].id, { done: true })
        make(store, 'Twice')
        expect(store.resolve('Twice')).toBe('ambiguous')

        expect(store.remove(list.id)).toBe(true)
        expect(store.remove(list.id)).toBe(false)
    })

    test('a removed workspace leaves its checklists without a project; startup drops links to missing ones', () => {
        const store = new ChecklistStore(fakeStore())
        const kept = make(store, 'Kept', { workspaceId: 'ws-kept' })
        const gone = make(store, 'Gone', { workspaceId: 'ws-gone' })
        const other = make(store, 'Other', { workspaceId: 'ws-other' })
        store.forgetWorkspace('ws-gone')
        expect(store.get(gone.id)!.workspaceId).toBeUndefined()
        expect(store.get(kept.id)!.workspaceId).toBe('ws-kept')

        store.prune(new Set(['ws-kept']))
        expect(store.get(other.id)!.workspaceId).toBeUndefined()
        expect(store.get(kept.id)!.workspaceId).toBe('ws-kept')
        expect(store.list().length).toBe(3)   // closing or removing never deletes a checklist
        expect(store.list({ workspaceId: 'ws-kept' }).map((c) => c.title)).toEqual(['Kept'])
    })

    test('caps: items per checklist and checklists in all are refused, not trimmed', () => {
        const store = new ChecklistStore(fakeStore())
        const full = make(store, 'Full', { items: Array.from({ length: CHECKLIST_ITEMS_MAX }, (_, i) => `item ${i}`) })
        expect(store.addItems(full.id, ['one more'])).toBeNull()
        expect(store.get(full.id)!.items.length).toBe(CHECKLIST_ITEMS_MAX)
        expect(store.create({ title: 'Too long', items: Array.from({ length: CHECKLIST_ITEMS_MAX + 1 }, (_, i) => `x${i}`), client: 'test' })).toBeNull()

        const stored: Checklist[] = Array.from({ length: CHECKLISTS_MAX }, (_, i) => ({
            id: `c${i}`, title: `list ${i}`, items: [], createdAt: i, updatedAt: i, client: 'test'
        }))
        const many = new ChecklistStore(fakeStore({ [CHECKLISTS_KEY]: stored }))
        expect(many.create({ title: 'one more', client: 'test' })).toBeNull()
        expect(many.create({ title: 'list 3', client: 'test' })!.created).toBe(false)   // a repeat still answers
    })

    test('a deadline reads as overdue, today, tomorrow, a weekday within six days, else the date', () => {
        const today = '2026-10-30'
        expect(daysBetween(today, '2026-11-02')).toBe(3)
        expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2)
        expect(describeDue('2026-10-27', today)).toEqual({ label: '3d overdue', tone: 'overdue' })
        expect(describeDue('2026-10-30', today)).toEqual({ label: 'Today', tone: 'today' })
        expect(describeDue('2026-10-31', today)).toEqual({ label: 'Tomorrow', tone: 'soon' })
        const weekday = new Date(2026, 10, 3).toLocaleDateString('en-US', { weekday: 'short' })
        expect(describeDue('2026-11-03', today)).toEqual({ label: weekday, tone: 'soon' })
        const sameYear = new Date(2026, 10, 6).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        expect(describeDue('2026-11-06', today)).toEqual({ label: sameYear, tone: 'later' })
        const nextYear = new Date(2027, 0, 5).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        expect(describeDue('2027-01-05', today)).toEqual({ label: nextYear, tone: 'later' })
    })
})
