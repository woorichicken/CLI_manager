import { randomUUID } from 'crypto'
import { Checklist, ChecklistItem } from '../shared/types'
import type { RelationStore } from './SessionRelations'

export const CHECKLISTS_KEY = 'checklists'
export const CHECKLISTS_CHANNEL = 'checklists'

/** One line: a checklist title or an item. Longer text is cut, not refused — the lead's list still lands. */
export const CHECKLIST_TEXT_MAX = 200
/** Items in one checklist. A list longer than this is a plan, not a checklist. */
export const CHECKLIST_ITEMS_MAX = 100
/** Checklists kept at once. Finished ones are only removed by hand, so this is the guard against a runaway caller. */
export const CHECKLISTS_MAX = 100

const DUE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** "open": not every item is checked yet (an empty checklist is open). "done": every item is checked. */
export type ChecklistStatus = 'open' | 'done' | 'all'

/** A checked edit of a checklist. `null` clears due or the project; an absent field stays as it is. */
export interface ChecklistPatch {
    title?: string
    due?: string | null
    workspaceId?: string | null
}

export type Checked<T> = ({ ok: true } & T) | { ok: false; message: string }

/** True for a real calendar date written YYYY-MM-DD (2026-02-30 is refused). */
export function isDueDate(value: string): boolean {
    const match = DUE_PATTERN.exec(value)
    if (!match) return false
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
    const date = new Date(year, month - 1, day)
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

/** Folds to one line and cuts at 200 characters. Empty after that means nothing was sent. */
export function cleanText(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, CHECKLIST_TEXT_MAX).trim()
}

/**
 * Title and deadline of a checklist as a caller sent them. On create the title is
 * required; on edit every field is optional, but one that is sent must be valid.
 * due is YYYY-MM-DD, or null / "" to clear it.
 */
export function checkChecklistInput(
    input: { title?: unknown; due?: unknown },
    options: { requireTitle: boolean }
): Checked<{ title?: string; due?: string | null }> {
    const patch: { title?: string; due?: string | null } = {}

    if (input.title !== undefined || options.requireTitle) {
        if (typeof input.title !== 'string' || !cleanText(input.title)) return { ok: false, message: 'title is required' }
        patch.title = cleanText(input.title)
    }

    if (input.due !== undefined) {
        if (input.due === null || input.due === '') {
            patch.due = null
        } else if (typeof input.due !== 'string' || !isDueDate(input.due.trim())) {
            return { ok: false, message: 'due must be a date written YYYY-MM-DD, or null to clear it' }
        } else {
            patch.due = input.due.trim()
        }
    }

    return { ok: true, ...patch }
}

/** Items as a caller sent them: one string or a list of strings. Blank ones are skipped. */
export function checkItemTexts(value: unknown): Checked<{ texts: string[] }> {
    const list = typeof value === 'string' ? [value] : value
    if (!Array.isArray(list) || list.some((t) => typeof t !== 'string')) {
        return { ok: false, message: 'items must be a string or a list of strings' }
    }
    return { ok: true, texts: (list as string[]).map(cleanText).filter(Boolean) }
}

export function isComplete(checklist: Checklist): boolean {
    return checklist.items.length > 0 && checklist.items.every((i) => i.doneAt !== undefined)
}

function completedAt(checklist: Checklist): number {
    return Math.max(...checklist.items.map((i) => i.doneAt ?? 0))
}

/**
 * The order the header pages through (‹ ›): open checklists first, the nearest deadline
 * on top and the ones without one after them in the order they were made; finished
 * checklists last, the most recently finished first.
 */
export function compareChecklists(a: Checklist, b: Checklist): number {
    const aDone = isComplete(a)
    const bDone = isComplete(b)
    if (aDone !== bDone) return aDone ? 1 : -1
    if (aDone && bDone) return completedAt(b) - completedAt(a)
    if (a.due !== b.due) {
        if (!a.due) return 1
        if (!b.due) return -1
        return a.due < b.due ? -1 : 1
    }
    return a.createdAt - b.createdAt
}

/**
 * Checklists — titled lists of items with a deadline, usually for one project. They
 * belong to no session: a lead makes one, hands the work to sessions directly, and
 * whoever finishes an item checks it, from the header panel or the Control API.
 * Closing a session leaves them alone. Kept in electron-store; every change is
 * announced with `onChange`, which main broadcasts to every window.
 */
export class ChecklistStore {
    constructor(
        private readonly store: RelationStore,
        private readonly onChange: (checklists: Checklist[]) => void = () => {}
    ) {}

    list(options: { status?: ChecklistStatus; workspaceId?: string } = {}): Checklist[] {
        const status = options.status ?? 'all'
        return this.all().filter(
            (c) =>
                (!options.workspaceId || c.workspaceId === options.workspaceId) &&
                (status === 'all' || (status === 'done') === isComplete(c))
        )
    }

    get(id: string): Checklist | null {
        return this.all().find((c) => c.id === id) ?? null
    }

    /** By id, else by title (case and spacing ignored). Two checklists with that title: "ambiguous". */
    resolve(ref: string): Checklist | 'ambiguous' | null {
        const all = this.all()
        const byId = all.find((c) => c.id === ref)
        if (byId) return byId
        const needle = cleanText(ref).toLowerCase()
        const byTitle = all.filter((c) => c.title.toLowerCase() === needle)
        if (byTitle.length > 1) return 'ambiguous'
        return byTitle[0] ?? null
    }

    /**
     * Makes a checklist. An open one with the same title is reused instead — a lead that
     * repeats its call would otherwise stack copies: the items it lacks are added, and a
     * due or project sent with the repeat replaces the old one. Null when the store is
     * full or the items do not fit.
     */
    create(
        input: { title: string; due?: string; workspaceId?: string; items?: string[]; client: string; createdBy?: string },
        now = Date.now()
    ): { checklist: Checklist; created: boolean } | null {
        const all = this.all()
        const repeat = all.find((c) => !isComplete(c) && c.title.toLowerCase() === input.title.toLowerCase())
        if (repeat) {
            const items = appendItems(repeat.items, input.items ?? [], now)
            if (!items) return null
            const updated: Checklist = {
                ...repeat,
                items,
                ...(input.due ? { due: input.due } : {}),
                ...(input.workspaceId ? { workspaceId: input.workspaceId } : {})
            }
            if (JSON.stringify(updated) === JSON.stringify(repeat)) return { checklist: repeat, created: false }
            updated.updatedAt = now
            this.save(all.map((c) => (c.id === repeat.id ? updated : c)))
            return { checklist: updated, created: false }
        }

        if (all.length >= CHECKLISTS_MAX) return null
        const items = appendItems([], input.items ?? [], now)
        if (!items) return null
        const checklist: Checklist = {
            id: randomUUID(),
            title: input.title,
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            ...(input.due ? { due: input.due } : {}),
            items,
            createdAt: now,
            updatedAt: now,
            client: input.client,
            ...(input.createdBy ? { createdBy: input.createdBy } : {})
        }
        this.save([...all, checklist])
        return { checklist, created: true }
    }

    /** Null when no checklist has this id. A patch that changes nothing writes nothing. */
    update(id: string, patch: ChecklistPatch, now = Date.now()): Checklist | null {
        return this.change(id, now, (c) => {
            if (patch.title !== undefined) c.title = patch.title
            if (patch.due === null) delete c.due
            else if (patch.due !== undefined) c.due = patch.due
            if (patch.workspaceId === null) delete c.workspaceId
            else if (patch.workspaceId !== undefined) c.workspaceId = patch.workspaceId
            return true
        })
    }

    remove(id: string): boolean {
        const all = this.all()
        const next = all.filter((c) => c.id !== id)
        if (next.length === all.length) return false
        this.save(next)
        return true
    }

    /**
     * Adds items at the end. Text the checklist already has (checked or not) is not
     * added again. `added` counts what was new; null when the checklist is missing
     * or the items would not fit.
     */
    addItems(id: string, texts: string[], now = Date.now()): { checklist: Checklist; added: number } | null {
        const target = this.get(id)
        if (!target) return null
        const items = appendItems(target.items, texts, now)
        if (!items) return null
        const added = items.length - target.items.length
        if (added === 0) return { checklist: target, added: 0 }
        const updated = this.change(id, now, (c) => {
            c.items = items
            return true
        })
        return updated ? { checklist: updated, added } : null
    }

    /** Checks, unchecks or renames one item. Null when the checklist or the item is missing. */
    updateItem(id: string, itemId: string, patch: { text?: string; done?: boolean }, now = Date.now()): Checklist | null {
        let found = false
        const updated = this.change(id, now, (c) => {
            const item = c.items.find((i) => i.id === itemId)
            if (!item) return false
            found = true
            if (patch.text !== undefined) item.text = patch.text
            // Checking again keeps the first time: "when was it finished" should not move.
            if (patch.done === true && item.doneAt === undefined) item.doneAt = now
            if (patch.done === false) delete item.doneAt
            return true
        })
        return found ? updated : null
    }

    removeItem(id: string, itemId: string, now = Date.now()): Checklist | null {
        let found = false
        const updated = this.change(id, now, (c) => {
            const next = c.items.filter((i) => i.id !== itemId)
            found = next.length !== c.items.length
            c.items = next
            return found
        })
        return found ? updated : null
    }

    /** A workspace was removed: its checklists stay, without the project. */
    forgetWorkspace(workspaceId: string, now = Date.now()): void {
        const all = this.all()
        if (!all.some((c) => c.workspaceId === workspaceId)) return
        this.save(all.map((c) => (c.workspaceId === workspaceId ? withoutWorkspace(c, now) : c)))
    }

    /** Startup: drops project links to workspaces that no longer exist. */
    prune(existingWorkspaceIds: Set<string>, now = Date.now()): void {
        const all = this.all()
        if (!all.some((c) => c.workspaceId && !existingWorkspaceIds.has(c.workspaceId))) return
        this.save(all.map((c) => (c.workspaceId && !existingWorkspaceIds.has(c.workspaceId) ? withoutWorkspace(c, now) : c)))
    }

    /**
     * Applies `edit` to a copy of one checklist and saves it when something changed.
     * `edit` returns false when there was nothing to edit (the item is missing).
     */
    private change(id: string, now: number, edit: (copy: Checklist) => boolean): Checklist | null {
        const all = this.all()
        const target = all.find((c) => c.id === id)
        if (!target) return null
        const copy: Checklist = { ...target, items: target.items.map((i) => ({ ...i })) }
        if (!edit(copy)) return target
        if (JSON.stringify(copy) === JSON.stringify(target)) return target
        copy.updatedAt = now
        this.save(all.map((c) => (c.id === id ? copy : c)))
        return copy
    }

    private all(): Checklist[] {
        const stored = this.store.get(CHECKLISTS_KEY)
        if (!Array.isArray(stored)) return []
        return (stored as Checklist[])
            .filter((c) => c && typeof c.id === 'string' && typeof c.title === 'string' && Array.isArray(c.items))
            .sort(compareChecklists)
    }

    private save(next: Checklist[]): void {
        const sorted = [...next].sort(compareChecklists)
        this.store.set(CHECKLISTS_KEY, sorted)
        this.onChange(sorted)
    }
}

/** `items` plus the texts it does not have yet, in order. Null when the result would pass the cap. */
function appendItems(items: ChecklistItem[], texts: string[], now: number): ChecklistItem[] | null {
    const seen = new Set(items.map((i) => i.text.toLowerCase()))
    const next = [...items]
    for (const text of texts) {
        const key = text.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        next.push({ id: randomUUID(), text, createdAt: now })
    }
    return next.length > CHECKLIST_ITEMS_MAX ? null : next
}

function withoutWorkspace(checklist: Checklist, now: number): Checklist {
    const { workspaceId: _gone, ...rest } = checklist
    return { ...rest, updatedAt: now }
}
