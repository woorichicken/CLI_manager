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
})
