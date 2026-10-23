import { test, expect, Page, _electron as electron } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, REPO_ROOT, LaunchResult, SeedWorkspace } from './helpers'

/**
 * T45 — sidebar "All sessions" view.
 *
 * Judged on rows the user can see (DOM), the terminal that comes to the front,
 * and the view surviving an app restart. Folder state is closed on purpose: the
 * old tree hid those sessions, the flat list must not.
 */

/**
 * Plain directories: the startup worktree scan skips non-repos, so the seeded
 * worktree workspace survives (the repo root would be rescanned and lose it).
 */
function seedWorkspaces(parentDir: string): SeedWorkspace[] {
    return [
        // First on purpose: the harness waits for the first workspace's name, which a closed folder would hide.
        { id: 'ws-beta', name: 'T45BETA', path: parentDir, sessions: [{ id: 's-b1', name: 'T45B1' }] },
        { id: 'ws-alpha', name: 'T45ALPHA', path: parentDir, folderId: 'f-closed', sessions: [{ id: 's-a1', name: 'T45A1' }, { id: 's-a2', name: 'T45A2' }] },
        { id: 'ws-beta-wt', name: 'T45BETAWT', path: path.join(parentDir, 'wt'), parentWorkspaceId: 'ws-beta', branchName: 't45-branch', sessions: [{ id: 's-w1', name: 'T45W1' }] }
    ]
}
const options = (folderOpen: boolean) => ({
    folders: [{ id: 'f-closed', name: 'T45FOLDER', isExpanded: folderOpen, createdAt: 1700000000000 }],
    settings: { showHomeWorkspace: false }
})

const ALL_IDS = ['s-a1', 's-a2', 's-b1', 's-w1']

/** Seeded session ids in the order the flat list draws them. */
const listOrder = (page: Page): Promise<string[]> => page.evaluate((wanted) =>
    Array.from(document.querySelectorAll('[data-testid="sidebar-all-sessions"] [data-session-item]'))
        .map((el) => el.getAttribute('data-session-item') ?? '')
        .filter((id) => wanted.includes(id)), ALL_IDS)

const visibleTerminal = (page: Page): Promise<string> => page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-session-id]'))
        .filter((el) => getComputedStyle(el).visibility === 'visible')
        .map((el) => el.getAttribute('data-session-id'))
        .join(',') || 'none')

test.describe('T45 sidebar all sessions', () => {
    let ctx: LaunchResult
    let relaunched: Awaited<ReturnType<typeof electron.launch>> | null = null
    const dirs: string[] = []
    const parentDir = (): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t45-'))
        dirs.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (relaunched) await relaunched.close().catch(() => undefined)
        relaunched = null
        if (ctx) await closeApp(ctx)
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('the toggle lists every session flat, labelled with its workspace, and rows behave like tree rows', async () => {
        ctx = await launchAppWithWorkspaces(seedWorkspaces(parentDir()), options(false))
        const { page } = ctx
        const toggle = page.getByTestId('sidebar-view-toggle')

        // Folder view: the closed folder hides T45A1/T45A2.
        await expect(toggle).toHaveAttribute('data-state', 'folders')
        await expect(page.locator('[data-session-item="s-a1"]')).toHaveCount(0)

        await toggle.click()
        await expect(toggle).toHaveAttribute('data-state', 'all')
        const list = page.getByTestId('sidebar-all-sessions')
        await expect(list).toBeVisible()
        // Closed folder, worktree and loose workspace: all four are there.
        await expect.poll(() => listOrder(page).then(ids => [...ids].sort())).toEqual([...ALL_IDS].sort())

        // Each row says which workspace it belongs to; the worktree shows its own name.
        const label = (id: string) => list.locator(`[data-session-item="${id}"] [data-testid="session-workspace-label"]`)
        await expect(label('s-a1')).toHaveText('T45ALPHA')
        await expect(label('s-b1')).toHaveText('T45BETA')
        await expect(label('s-w1')).toHaveText('T45BETAWT')

        // Click = same as the tree: that session's terminal comes to the front.
        await list.locator('[data-session-item="s-a2"]').click()
        await expect.poll(() => visibleTerminal(page)).toBe('s-a2')

        // The rows do not jump under the pointer; once it leaves the list, the clicked one moves to the top.
        await page.mouse.move(900, 500)
        await expect.poll(() => listOrder(page).then(ids => ids[0])).toBe('s-a2')
        await list.locator('[data-session-item="s-w1"]').hover()

        // Right-click opens the session menu (same component as the tree).
        await list.locator('[data-session-item="s-w1"]').click({ button: 'right' })
        await expect(page.getByRole('button', { name: 'Copy Session ID', exact: true })).toBeVisible()
        await page.keyboard.press('Escape')

        // Back to the folder view: the closed folder hides its sessions again.
        await toggle.click()
        await expect(toggle).toHaveAttribute('data-state', 'folders')
        await expect(list).toHaveCount(0)
        await expect(page.locator('[data-session-item="s-a1"]')).toHaveCount(0)
    })

    test('rows are ordered by what was viewed last, then the sessions never viewed in sidebar order', async () => {
        ctx = await launchAppWithWorkspaces(seedWorkspaces(parentDir()), options(true))
        const { page } = ctx

        // View them in the tree (the folder is open here, every row can be clicked).
        await activateSession(page, 'T45A1')
        await activateSession(page, 'T45B1')
        await activateSession(page, 'T45W1')

        await page.getByTestId('sidebar-view-toggle').click()
        // Most recent first (W1, B1, A1); A2 was never viewed and follows.
        await expect.poll(() => listOrder(page)).toEqual(['s-w1', 's-b1', 's-a1', 's-a2'])
    })

    test('a list that goes away under the pointer catches up when it comes back', async () => {
        ctx = await launchAppWithWorkspaces(seedWorkspaces(parentDir()), options(true))
        const { page } = ctx
        await activateSession(page, 'T45A1')
        await activateSession(page, 'T45B1')
        await page.getByTestId('sidebar-view-toggle').click()
        const list = page.getByTestId('sidebar-all-sessions')
        await expect.poll(async () => (await listOrder(page)).slice(0, 2)).toEqual(['s-b1', 's-a1'])

        // A click inside the list holds the order back while the pointer stays on it.
        await list.locator('[data-session-item="s-w1"]').click()
        await expect.poll(() => visibleTerminal(page)).toBe('s-w1')
        expect((await listOrder(page))[0]).toBe('s-b1')

        // Search replaces the list without the pointer moving: no mouseleave ever comes.
        await page.getByTestId('sidebar-search-toggle').dispatchEvent('click')
        const input = page.getByTestId('sidebar-search-input')
        await input.fill('T45')
        await expect(list).toHaveCount(0)
        await input.fill('')
        await expect(list).toBeVisible()
        await expect.poll(() => listOrder(page)).toEqual(['s-w1', 's-b1', 's-a1', 's-a2'])
    })

    test('the choice survives an app restart', async () => {
        ctx = await launchAppWithWorkspaces(seedWorkspaces(parentDir()), options(false))
        await ctx.page.getByTestId('sidebar-view-toggle').click()
        await expect(ctx.page.getByTestId('sidebar-all-sessions')).toBeVisible()

        // closeApp deletes userData; the relaunch needs it.
        const userDataDir = ctx.userDataDir
        await ctx.app.close()
        dirs.push(userDataDir)
        ctx.userDataDir = path.join(userDataDir, '..', 'climanger-t45-unused')

        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: {
                ...process.env,
                CLIMANGER_TEST_USERDATA: userDataDir,
                CLIMANGER_TERM_DEBUG: '1',
                CLIMANGER_TEST_HEADLESS: '1'
            } as Record<string, string>
        })
        const page = await relaunched.firstWindow()
        await expect(page.getByTestId('sidebar-all-sessions')).toBeVisible({ timeout: 30_000 })
        await expect(page.getByTestId('sidebar-view-toggle')).toHaveAttribute('data-state', 'all')
        await expect.poll(() => listOrder(page).then(ids => ids.length)).toBe(ALL_IDS.length)
    })
})
