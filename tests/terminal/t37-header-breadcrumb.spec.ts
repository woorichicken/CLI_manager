import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'
import { buildSessionBreadcrumb } from '../../src/renderer/src/utils/sessionBreadcrumb'
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
