import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, resizeMainWindow, type LaunchResult } from './helpers'
import { InboxStore, INBOX_KEY } from '../../src/main/InboxStore'
import type { InboxRequest } from '../../src/shared/types'

/**
 * T174 — fb-1125 5b1198ba: «이거 정리도 필요할듯함» on the inbox bell. A real inbox held 33 read requests
 * (7-day retention) under the few that still need the user, and the list was long. The popover now shows
 * what is unread first and folds what was read under one «Read (n)» line; «Clear read» beside it removes
 * every read request at once (unread ones and the Dock badge stay). The pinned element is the bell's
 * second svg path (lucide Bell: body, clapper) — the app test resolves the report's selector in the DOM.
 *
 * T174_SHOTS=<dir> + T174_LABEL save the popover capture; T174_BEFORE=1 only takes it (the old code).
 */

const BEFORE = process.env.T174_BEFORE === '1'
const LABEL = process.env.T174_LABEL ?? 'run'
const A = 's-t174-a'
const B = 's-t174-b'
const C = 's-t174-c'
const PIN = '#root > div > div:nth-of-type(1) > div:nth-of-type(1) > div > button:nth-of-type(1) > svg > path:nth-of-type(2)'

function fakeStore(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial }
    return { get: (key: string) => data[key], set: (key: string, value: unknown) => void (data[key] = value), data }
}

function request(id: string, sessionId: string, kind: InboxRequest['kind'], text: string, at: number, readAt?: number): InboxRequest {
    return { id, sessionId, kind, text, at, createdAt: at, client: 't174', ...(readAt ? { readAt } : {}) }
}

test.describe('T174 inbox store: clearRead', () => {
    test('drops the read ones, keeps the unread, writes and announces once — nothing when none is read', () => {
        const NOW = Date.now()
        const store = fakeStore({
            [INBOX_KEY]: [
                request('u1', 's1', 'question', 'unread newest', NOW - 1000),
                request('r1', 's1', 'login', 'read a', NOW - 2000, NOW - 1500),
                request('r2', 's2', 'other', 'read b', NOW - 3000, NOW - 2500),
                request('u2', 's2', 'login', 'unread older', NOW - 4000)
            ]
        })
        const sets: number[] = []
        const origSet = store.set
        store.set = (key: string, value: unknown) => {
            sets.push((value as unknown[]).length)
            origSet(key, value)
        }
        const changes: number[] = []
        const inbox = new InboxStore(store, (all) => changes.push(all.length))

        expect(inbox.clearRead()).toBe(2)
        expect(inbox.list().map((r) => r.id)).toEqual(['u1', 'u2'])
        expect(inbox.unreadCount()).toBe(2)
        expect(sets).toEqual([2])
        expect(changes).toEqual([2])

        // none read: nothing is written or announced
        expect(inbox.clearRead()).toBe(0)
        expect(sets).toEqual([2])
        expect(changes).toEqual([2])

        // all read: all go
        inbox.markAllRead()
        expect(inbox.clearRead()).toBe(2)
        expect(inbox.list()).toEqual([])
        // an empty inbox is not an error
        expect(inbox.clearRead()).toBe(0)
    })
})

let result: LaunchResult | null = null
const tempDirs: string[] = []
test.afterEach(async () => {
    if (result) {
        const done = result
        result = null
        await closeApp(done)
    }
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const dockBadge = (app: LaunchResult['app']): Promise<string> =>
    app.evaluate(({ app: electronApp }) => (process.platform === 'darwin' ? electronApp.dock?.getBadge() ?? '' : 'n/a'))

test('T174 popover: unread first, read folded under «Read (n)», «Clear read» removes them (5b1198ba)', async () => {
    test.setTimeout(120_000)
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t174-ws-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t174-home-'))
    tempDirs.push(folder, home)
    const NOW = Date.now()
    // newest first, as the store sorts: two unread among the read ones, the shape of a real inbox
    const seeded: InboxRequest[] = [
        request('t174-u1', A, 'question', 'Which port should the mock use?', NOW - 60_000),
        request('t174-r1', B, 'login', 'Sign in to the staging dashboard', NOW - 120_000, NOW - 100_000),
        request('t174-r2', A, 'question', 'Keep the old layout?', NOW - 180_000, NOW - 150_000),
        request('t174-u2', C, 'login', 'Sign in to Aside', NOW - 240_000),
        request('t174-r3', C, 'other', 'FYI: build is green', NOW - 300_000, NOW - 280_000),
        request('t174-r4', B, 'question', 'Ship it?', NOW - 360_000, NOW - 340_000)
    ]
    result = await launchAppWithWorkspaces(
        [{ id: 'ws-t174', name: 'T174WS', path: folder, sessions: [{ id: A, name: 'T174A agent' }, { id: B, name: 'T174B agent' }, { id: C, name: 'T174C shell' }] }],
        { settings: { showHomeWorkspace: false }, config: { inbox: seeded }, env: { CLIMANAGER_HOME: home } }
    )
    const { app, page, userDataDir } = result
    await resizeMainWindow(app, 1280, 800)
    const bell = page.locator('[data-testid="inbox-button"][data-inbox-placement="sidebar"]')
    const popover = page.getByTestId('inbox-popover')
    const onDisk = (): InboxRequest[] => JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).inbox ?? []
    const shown = (p: Page) => popover.locator('[data-inbox-request]').evaluateAll((els) => els.map((el) => `${el.getAttribute('data-inbox-request')}:${el.getAttribute('data-read')}`))

    await expect(bell).toHaveAttribute('data-unread', '2')
    // the report's pin is this bell's icon: resolve its selector in the real DOM
    const pinned = await page.evaluate((selector) => document.querySelector(selector)?.closest('[data-testid="inbox-button"]')?.getAttribute('data-inbox-placement') ?? null, PIN)
    expect(pinned, 'the pinned svg path is the inbox bell').toBe('sidebar')

    await bell.click()
    await expect(popover).toBeVisible()
    const shotDir = process.env.T174_SHOTS
    if (shotDir) {
        fs.mkdirSync(shotDir, { recursive: true })
        await page.waitForTimeout(300)
        await page.screenshot({ path: path.join(shotDir, `popover-1280-${LABEL}.png`) })
    }
    if (BEFORE) return

    // unread first, newest first; the read ones wait folded under one line
    expect(await shown(page)).toEqual(['t174-u1:false', 't174-u2:false'])
    const toggle = page.getByTestId('inbox-read-toggle')
    await expect(toggle).toHaveText('Read (4)')
    await expect(page.getByTestId('inbox-read-fold')).toHaveAttribute('data-state', 'closed')
    await expect(page.getByTestId('inbox-clear-read')).toBeVisible()
    // the fold is under the unread rows
    const lastUnread = await popover.locator('[data-inbox-request="t174-u2"]').boundingBox()
    const fold = await page.getByTestId('inbox-read-fold').boundingBox()
    expect(fold!.y).toBeGreaterThan(lastUnread!.y)

    // opening it lists the four read requests, newest first, still dimmed as read
    await toggle.click()
    await expect(page.getByTestId('inbox-read-fold')).toHaveAttribute('data-state', 'open')
    expect(await shown(page)).toEqual(['t174-u1:false', 't174-u2:false', 't174-r1:true', 't174-r2:true', 't174-r3:true', 't174-r4:true'])
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `popover-open-1280-${LABEL}.png`) })

    // the row's check moves a request into Read: the count follows, the bell too
    await popover.locator('[data-inbox-request="t174-u2"]').getByTestId('inbox-mark-read').click()
    await expect(toggle).toHaveText('Read (5)')
    await expect(bell).toHaveAttribute('data-unread', '1')
    expect(await shown(page)).toEqual(['t174-u1:false', 't174-r1:true', 't174-r2:true', 't174-u2:true', 't174-r3:true', 't174-r4:true'])

    // Clear read: every read request goes, the unread one and the badge stay, the popover stays open
    await page.getByTestId('inbox-clear-read').click()
    await expect.poll(() => onDisk().map((r) => r.id)).toEqual(['t174-u1'])
    expect(onDisk().every((r) => !r.readAt)).toBe(true)
    expect(await shown(page)).toEqual(['t174-u1:false'])
    await expect(page.getByTestId('inbox-read-fold')).toHaveCount(0)
    await expect(popover).toBeVisible()
    await expect(bell).toHaveAttribute('data-unread', '1')
    if (process.platform === 'darwin') await expect.poll(() => dockBadge(app)).toBe('1')

    // nothing unread but something read: the fold sits above the empty-state words
    await popover.locator('[data-inbox-request="t174-u1"]').getByTestId('inbox-mark-read').click()
    await expect(bell).toHaveAttribute('data-unread', '0')
    await expect(toggle).toHaveText('Read (1)')
    await expect(popover).toContainText('No unread requests.')
    const fold2 = await page.getByTestId('inbox-read-fold').boundingBox()
    const words = await page.getByTestId('inbox-body').locator(':scope > p').boundingBox()
    expect(fold2!.y).toBeLessThan(words!.y)
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `popover-none-unread-1280-${LABEL}.png`) })
    await page.getByTestId('inbox-clear-read').click()
    await expect.poll(() => onDisk()).toEqual([])
    await expect(popover).toContainText('No requests.')
    await expect(page.getByTestId('inbox-read-fold')).toHaveCount(0)
    if (process.platform === 'darwin') await expect.poll(() => dockBadge(app)).toBe('')
})
