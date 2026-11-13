import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'
import { buildSessionBreadcrumb } from '../../src/renderer/src/utils/sessionBreadcrumb'
import { splitAfterDrop, splitHeadersWide } from '../../src/renderer/src/utils/splitLayout'
import type { TerminalSession, Workspace, WorkspaceFolder } from '../../src/shared/types'

/**
 * T37 — header breadcrumb `folder > project > session` (report ab3ca850).
 *
 * The first block is a pure unit test of the path builder (no Electron). The second drives the
 * real header: single view, a project outside any folder, and a split pane too narrow for a long
 * folder/project name — the session name has to stay readable there.
 */

const session = (id: string, name: string): TerminalSession => ({ id, name, cwd: '/tmp', type: 'regular' })
const workspace = (id: string, name: string, extra: Partial<Workspace> = {}): Workspace =>
    ({ id, name, path: '/tmp', sessions: [], createdAt: 0, ...extra }) as Workspace
const FOLDERS: WorkspaceFolder[] = [{ id: 'f1', name: 'Company', createdAt: 0 }]

test.describe('T37 breadcrumb builder', () => {
    test('folder, project and session in that order', () => {
        const ws = workspace('w1', 'Proj', { folderId: 'f1' })
        expect(buildSessionBreadcrumb(session('s1', 'Sess'), ws, [ws], FOLDERS).map(s => s.label))
            .toEqual(['Company', 'Proj', 'Sess'])
    })

    test('a project outside any folder drops the folder segment', () => {
        const ws = workspace('w1', 'Proj')
        expect(buildSessionBreadcrumb(session('s1', 'Sess'), ws, [ws], FOLDERS).map(s => s.kind))
            .toEqual(['project', 'session'])
    })

    test('a folder id that no longer exists drops the folder segment', () => {
        const ws = workspace('w1', 'Proj', { folderId: 'gone' })
        expect(buildSessionBreadcrumb(session('s1', 'Sess'), ws, [ws], FOLDERS).map(s => s.kind))
            .toEqual(['project', 'session'])
    })

    test('Playground never shows a folder', () => {
        const ws = workspace('w1', 'Playground', { isPlayground: true, folderId: 'f1' })
        expect(buildSessionBreadcrumb(session('s1', 'Sess'), ws, [ws], FOLDERS).map(s => s.kind))
            .toEqual(['project', 'session'])
    })

    test('a worktree takes the folder of its parent project', () => {
        const parent = workspace('w1', 'Proj', { folderId: 'f1' })
        const child = workspace('w2', 'Proj-wt', { parentWorkspaceId: 'w1' })
        expect(buildSessionBreadcrumb(session('s1', 'Sess'), child, [parent, child], FOLDERS).map(s => s.label))
            .toEqual(['Company', 'Proj-wt', 'Sess'])
    })

    test('the Home workspace is flagged so the header can shorten it', () => {
        const ws = workspace('w1', 'me@host.local', { isHome: true })
        expect(buildSessionBreadcrumb(session('s1', 'Sess'), ws, [ws], FOLDERS))
            .toEqual([{ kind: 'project', label: 'me@host.local', isHome: true }, { kind: 'session', label: 'Sess' }])
    })

    test('no session yet leaves the project path only', () => {
        const ws = workspace('w1', 'Proj', { folderId: 'f1' })
        expect(buildSessionBreadcrumb(null, ws, [ws], FOLDERS).map(s => s.kind)).toEqual(['folder', 'project'])
    })
})

async function dropIntoSplit(page: Page, sessionId: string): Promise<void> {
    await page.evaluate((id) => {
        const dataTransfer = new DataTransfer()
        const row = document.querySelector(`[data-session-item="${id}"]`)!.parentElement!
        row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
        const area = document.querySelector('[data-session-id]')!.parentElement!.parentElement!
        area.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
        row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
    }, sessionId)
}

const crumbs = (page: Page, root: string) =>
    page.locator(`${root} [data-session-breadcrumb] [data-crumb]`).evaluateAll(els => els.map(el => `${el.getAttribute('data-crumb')}:${el.textContent}`))

// fb-1114: the split view the breadcrumbs above live in — one pane per session, panes that touch.
test.describe('T37 split drop rule (report d2e6adc7)', () => {
    test('the session already on screen is not split with itself', () => {
        expect(splitAfterDrop(null, 's-a', 's-a')).toEqual({ kind: 'ignore' })
        expect(splitAfterDrop(null, 's-a', 's-b')).toEqual({ kind: 'layout', sessionIds: ['s-a', 's-b'] })
        expect(splitAfterDrop(null, null, 's-b')).toEqual({ kind: 'layout', sessionIds: ['s-b'] })
    })

    test('a session already in a pane brings that pane forward instead of a second copy', () => {
        expect(splitAfterDrop(['s-a', 's-b', 's-c'], null, 's-b')).toEqual({ kind: 'focus', index: 1 })
        expect(splitAfterDrop(['s-a', 's-b'], null, 's-c')).toEqual({ kind: 'layout', sessionIds: ['s-a', 's-b', 's-c'] })
        expect(splitAfterDrop(['s-a', 's-b', 's-c', 's-d'], null, 's-e')).toEqual({ kind: 'ignore' })
    })
})

test.describe('T37 split panes (fb-1114)', () => {
    let ctx: LaunchResult
    let dir = ''

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        if (dir) fs.rmSync(dir, { recursive: true, force: true })
    })

    async function launchSplit(ids: string[]) {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t37s-'))
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-a', name: 'T37SPLIT', path: dir, sessions: ids.map(id => ({ id, name: `T37-${id}` })) }
        ])
        await ctx.page.setViewportSize({ width: 1500, height: 950 })
        return ctx.page
    }

    // The positioned box App.tsx places each terminal in (the pane minus nothing — header room is padding).
    const paneBox = (page: Page, id: string) => page.evaluate((sid) => {
        const r = document.querySelector(`[data-session-id="${sid}"]`)!.parentElement!.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
    }, id)

    test('dropping the session on screen onto its own terminal leaves one full view (report d2e6adc7)', async () => {
        const page = await launchSplit(['s-a', 's-b'])
        await page.locator('[data-session-item="s-a"]').click()
        await expect(page.locator('[data-session-id="s-a"]')).toBeVisible()
        await dropIntoSplit(page, 's-a')
        await page.waitForTimeout(300)
        // Before the fix: two pane headers for s-a, and the second pane empty (one xterm, one place).
        await expect(page.locator('.pane-header')).toHaveCount(0)
        await expect(page.locator('[data-session-id="s-a"]')).toBeVisible()

        // In a real split, the same session dropped again adds no second pane.
        await dropIntoSplit(page, 's-b')
        await expect(page.locator('.pane-header')).toHaveCount(2)
        await dropIntoSplit(page, 's-a')
        await page.waitForTimeout(300)
        const slots = await page.locator('[data-terminal-slot]').evaluateAll(els => els.map(el => el.getAttribute('data-terminal-slot')))
        expect(slots).toEqual(['s-a', 's-b'])
    })

    test('panes touch: one 1px line between them and no space below (report a81cd0ce)', async () => {
        const page = await launchSplit(['s-a', 's-b', 's-c'])
        await page.locator('[data-session-item="s-a"]').click()
        await dropIntoSplit(page, 's-b')
        await expect(page.locator('.pane-header')).toHaveCount(2)

        const area = await page.evaluate(() => {
            const r = document.querySelector('[data-session-id]')!.parentElement!.parentElement!.getBoundingClientRect()
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
        })
        let a = await paneBox(page, 's-a')
        let b = await paneBox(page, 's-b')
        expect(b.left - a.right, 'space between side-by-side panes').toBeLessThanOrEqual(1.01)
        expect(b.left - a.right).toBeGreaterThan(0)
        expect(area.bottom - a.bottom, 'space under the panes').toBeLessThanOrEqual(0.5)
        expect(a.left - area.left).toBeLessThanOrEqual(0.5)
        expect(area.right - b.right).toBeLessThanOrEqual(0.5)
        // The line itself is drawn in that strip.
        const line = await page.locator('[data-split-divider="vertical"]').boundingBox()
        expect(line!.width).toBeLessThanOrEqual(1.01)
        expect(line!.x).toBeGreaterThanOrEqual(a.right - 0.5)
        expect(line!.x + line!.width).toBeLessThanOrEqual(b.left + 0.5)
        // Header cells sit exactly over their terminals.
        const cells = await page.locator('[data-terminal-slot]').evaluateAll(els => els.map(el => {
            const r = el.parentElement!.getBoundingClientRect()
            return { left: r.left, right: r.right }
        }))
        expect(Math.abs(cells[0].right - a.right)).toBeLessThanOrEqual(0.5)
        expect(Math.abs(cells[1].left - b.left)).toBeLessThanOrEqual(0.5)

        // Three panes: the same 1px between the top row and the full-width bottom pane.
        await dropIntoSplit(page, 's-c')
        await expect(page.locator('.pane-header')).toHaveCount(3)
        a = await paneBox(page, 's-a')
        const c = await paneBox(page, 's-c')
        expect(c.top - a.bottom, 'space between rows').toBeLessThanOrEqual(1.01)
        expect(c.top - a.bottom).toBeGreaterThan(0)
        expect(area.bottom - c.bottom).toBeLessThanOrEqual(0.5)
        await expect(page.locator('[data-split-divider="horizontal"]')).toHaveCount(1)
    })

    test('a wide pane gets the single-view header row, a narrow one keeps the compact row (report 08343040)', async () => {
        const page = await launchSplit(['s-a', 's-b', 's-c'])
        await page.setViewportSize({ width: 1800, height: 950 })
        await page.locator('[data-session-item="s-a"]').click()
        const single = page.locator('div.flex-1.glass-panel > div.draggable')
        const singleHeight = (await single.boundingBox())!.height
        const singleSearch = (await single.locator('button[title^="Search Files"]').boundingBox())!

        await dropIntoSplit(page, 's-b')
        const headerA = page.locator('[data-pane-header="s-a"]')
        const headerB = page.locator('[data-pane-header="s-b"]')
        await expect(headerA).toHaveAttribute('data-pane-wide', 'true')
        await expect(headerB).toHaveAttribute('data-pane-wide', 'true')
        // Same height and the same button size as the header over a single terminal.
        expect(Math.abs((await headerA.boundingBox())!.height - singleHeight)).toBeLessThanOrEqual(1)
        const paneSearch = (await headerA.locator('button[title="Search Files"]').boundingBox())!
        expect(Math.abs(paneSearch.width - singleSearch.width)).toBeLessThanOrEqual(1)
        expect(Math.abs(paneSearch.height - singleSearch.height)).toBeLessThanOrEqual(1)
        // Related with its label, and ‹ › on the active pane only — one history for the window.
        await expect(headerA.locator('[data-related-button]')).toContainText('Related')
        await expect(headerA.locator('[data-session-history]')).toHaveCount(1)
        await expect(headerB.locator('[data-session-history]')).toHaveCount(0)
        // The terminal starts right under its header: nothing hidden behind it, no gap.
        const termTop = await page.evaluate(() => document.querySelector('[data-session-id="s-a"]')!.getBoundingClientRect().top)
        const headerBox = (await headerA.boundingBox())!
        expect(Math.abs(termTop - (headerBox.y + headerBox.height))).toBeLessThanOrEqual(1)

        // Narrow window: half-width panes go back to the compact row.
        await page.setViewportSize({ width: 1280, height: 950 })
        await expect(headerA).toHaveAttribute('data-pane-wide', 'false')
        expect(Math.round((await headerA.boundingBox())!.height)).toBe(32)
        await expect(headerA.locator('[data-session-history]')).toHaveCount(0)

        // One shape per split (round 2): three panes at 1280 — the full-width bottom pane is wide
        // enough on its own, but the two on top are not, so every pane keeps the compact row.
        await dropIntoSplit(page, 's-c')
        const shapes = () => page.locator('[data-pane-header]').evaluateAll(els => els.map(el => el.getAttribute('data-pane-wide')))
        await expect.poll(shapes).toEqual(['false', 'false', 'false'])
        const heights = () => page.locator('[data-pane-header]').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)))
        expect(await heights()).toEqual([32, 32, 32])
        const cTop = await page.evaluate(() => document.querySelector('[data-session-id="s-c"]')!.getBoundingClientRect().top)
        const cHeader = (await page.locator('[data-pane-header="s-c"]').boundingBox())!
        expect(Math.abs(cTop - (cHeader.y + cHeader.height))).toBeLessThanOrEqual(1)

        // Three panes at 1800: every pane is wide, so every pane gets the wide row.
        await page.setViewportSize({ width: 1800, height: 950 })
        await expect.poll(shapes).toEqual(['true', 'true', 'true'])
        expect(await heights()).toEqual([40, 40, 40])
    })

    test('the header shape is decided for the whole split by its narrowest pane', () => {
        // 1001 wide: two halves of 500 — compact, even though a 3-pane bottom row would be 1001.
        expect(splitHeadersWide(1001, 3)).toBe(false)
        expect(splitHeadersWide(1001, 1)).toBe(true)
        expect(splitHeadersWide(1281, 2)).toBe(true) // halves of 640
        expect(splitHeadersWide(1279, 4)).toBe(false)
        expect(splitHeadersWide(0, 2)).toBe(false)
    })
})

test.describe('T37 header breadcrumb', () => {
    let ctx: LaunchResult
    const tempDirs: string[] = []

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    async function launch(workspaces: Parameters<typeof launchAppWithWorkspaces>[0], folderName = 'T37FOLDER') {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t37-'))
        tempDirs.push(dir)
        ctx = await launchAppWithWorkspaces(workspaces.map(w => ({ ...w, path: dir })), {
            folders: [{ id: 'f-a', name: folderName, isExpanded: true, createdAt: 1700000000000 }]
        })
        await ctx.page.setViewportSize({ width: 1500, height: 950 })
        return ctx.page
    }

    test('single view shows folder > project > session, and a project outside a folder shows two', async () => {
        const page = await launch([
            { id: 'ws-a', name: 'T37PROJ', folderId: 'f-a', sessions: [{ id: 's-a', name: 'T37SESS' }] },
            { id: 'ws-b', name: 'T37LOOSE', sessions: [{ id: 's-b', name: 'T37OTHER' }] }
        ])
        await page.locator('[data-session-item="s-a"]').click()
        await expect.poll(() => crumbs(page, 'div.flex-1.glass-panel > div.draggable'))
            .toEqual(['folder:T37FOLDER', 'project:T37PROJ', 'session:T37SESS'])

        await page.locator('[data-session-item="s-b"]').click()
        await expect.poll(() => crumbs(page, 'div.flex-1.glass-panel > div.draggable'))
            .toEqual(['project:T37LOOSE', 'session:T37OTHER'])
    })

    test('a split pane keeps the session name readable when folder and project are long', async () => {
        const longName = 'T37-a-very-long-name-that-cannot-fit-in-a-half-width-pane-header-'.repeat(2)
        const page = await launch([
            { id: 'ws-a', name: longName + 'PROJ', folderId: 'f-a', sessions: [{ id: 's-a', name: 'T37SESS-A' }, { id: 's-b', name: 'T37SESS-B' }] }
        ], longName + 'FOLDER')
        await page.setViewportSize({ width: 1000, height: 700 })
        await page.locator('[data-session-item="s-a"]').click()
        await dropIntoSplit(page, 's-b')
        await expect(page.locator('.pane-header')).toHaveCount(2)

        for (const name of ['T37SESS-A', 'T37SESS-B']) {
            const sessionCrumb = page.locator('.pane-header [data-crumb="session"]').filter({ hasText: name })
            await expect(sessionCrumb).toBeVisible()
            // Ellipsis would mean the scroll width is wider than what is drawn.
            const clipped = await sessionCrumb.evaluate(el => el.scrollWidth > el.clientWidth)
            expect(clipped, `${name} is cut off`).toBe(false)
        }
        // The header row itself must not overflow into the action buttons.
        const overflowing = await page.locator('.pane-header').evaluateAll(els =>
            els.map(el => el.scrollWidth > el.clientWidth))
        expect(overflowing).toEqual([false, false])
    })
    test('narrowing the window drops whole leading segments behind one ellipsis (report 9b89b9f5)', async () => {
        const pad = 'x'.repeat(34)
        const page = await launch([
            { id: 'ws-a', name: 'T37PROJ-' + pad, folderId: 'f-a', sessions: [{ id: 's-a', name: 'T37SESS' }] }
        ], 'T37FOLDER-' + pad)
        await page.locator('[data-session-item="s-a"]').click()
        const header = 'div.flex-1.glass-panel > div.draggable'
        await expect.poll(() => crumbs(page, header)).toHaveLength(3)
        await expect(page.locator(`${header} [data-crumb-more]`)).toHaveCount(0)

        const seen = new Set<string>()
        for (let width = 900; width >= 40; width -= 20) {
            // Cap the row itself: the test window does not shrink like a real one, but the
            // row's own width is what the component measures.
            await page.locator(`${header} [data-session-breadcrumb]`).evaluate((el, w) => { (el as HTMLElement).style.maxWidth = `${w}px` }, width)
            await page.waitForTimeout(150)
            const kinds = (await crumbs(page, header)).map(c => c.split(':')[0])
            const more = await page.locator(`${header} [data-crumb-more]`).count()
            seen.add(`${kinds.join('>')}${more ? ' +more' : ''}`)
            // Whole segments only: the surviving ones are always a tail of folder>project>session.
            expect(['folder>project>session', 'project>session', 'session']).toContain(kinds.join('>'))
            expect(more > 0, `${width}: ellipsis iff something was dropped`).toBe(kinds.length < 3)
            const nav = await page.locator(`${header} [data-session-breadcrumb]`).evaluate(el => el.scrollWidth > el.clientWidth)
            expect(nav, `${width}: path overflows its row`).toBe(false)
            if (more) {
                // The tooltip on the ellipsis carries the full path.
                expect(await page.locator(`${header} [data-crumb-more]`).getAttribute('title')).toContain('T37FOLDER')
            }
        }
        expect([...seen]).toEqual(expect.arrayContaining(['folder>project>session', 'project>session +more', 'session +more']))
        // Widening again brings the full path back.
        await page.locator(`${header} [data-session-breadcrumb]`).evaluate(el => { (el as HTMLElement).style.maxWidth = '' })
        await expect.poll(() => crumbs(page, header)).toHaveLength(3)
    })

    test('real layout, no width cap: long names fold and the header row still fits (report 9b89b9f5)', async () => {
        const page = await launch([
            { id: 'ws-a', name: 'Project-with-a-really-long-name-' + 'z'.repeat(60), folderId: 'f-a', sessions: [{ id: 's-a', name: 'T37REALSESS' }] }
        ], 'Long-folder-name-' + 'y'.repeat(60))
        await page.locator('[data-session-item="s-a"]').click()
        const header = 'div.flex-1.glass-panel > div.draggable'
        await expect.poll(() => page.locator(`${header} [data-crumb-more]`).count()).toBe(1)
        const kinds = (await crumbs(page, header)).map(c => c.split(':')[0])
        expect(kinds[kinds.length - 1]).toBe('session')
        // The row must not overflow: the session name and the buttons on the right stay on screen.
        const row = await page.locator(header).evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }))
        expect(row.scroll, 'header row overflows').toBeLessThanOrEqual(row.client)
        const related = await page.locator('[data-related-button]').first().boundingBox()
        const win = await page.evaluate(() => window.innerWidth)
        expect(related!.x + related!.width).toBeLessThanOrEqual(win)
        const sessionBox = await page.locator(`${header} [data-crumb="session"]`).boundingBox()
        expect(sessionBox!.x + sessionBox!.width).toBeLessThanOrEqual(related!.x)
    })

    test('the Home workspace shows a house and ~ with the full name in the tooltip (report 1fe246f5)', async () => {
        const page = await launch([
            { id: 'ws-h', name: 'someone@some-long-host-name.local', isHome: true, sessions: [{ id: 's-h', name: 'T37HOMESESS' }] }
        ])
        await page.locator('[data-session-item="s-h"]').click()
        const header = 'div.flex-1.glass-panel > div.draggable'
        await expect.poll(() => crumbs(page, header)).toEqual(['project:~', 'session:T37HOMESESS'])
        const home = page.locator(`${header} [data-crumb="project"]`)
        await expect(home.locator('svg')).toHaveCount(1)
        expect(await home.getAttribute('title')).toBe('someone@some-long-host-name.local')
    })
})
