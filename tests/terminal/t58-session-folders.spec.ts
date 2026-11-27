import { test, expect, Page, Locator } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, resizeMainWindow, LaunchResult, SeedWorkspace, toggleSidebarView, chooseSidebarView } from './helpers'

/**
 * T58 — session folders in the sidebar's All sessions view (report 078ee766).
 *
 * A session keeps its workspace and may also sit in one session folder. Made
 * from the All view's "…" menu, filled by dragging a session row onto the
 * folder heading (a real mouse drag, not synthetic events), emptied by dropping
 * on "No folder". Judged in the DOM and in config.json.
 *
 * fb-1117 b9038a0e: a folder's right-click "New Session…" opens the New session dialog and files the
 * session in that folder; on "No folder" it stays unfiled. `T58_SHOTS=<dir>` (+ T58_LABEL) leaves the
 * menu and dialog captures. Fails on the code before it: the menu has no New Session….
 */

type StoredSession = { id: string; sessionFolderId?: string }
type StoredFolder = { id: string; name: string; isExpanded?: boolean }

const readConfig = (userDataDir: string) => JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
const storedFolders = (userDataDir: string): StoredFolder[] => readConfig(userDataDir).sessionFolders ?? []
const storedSession = (userDataDir: string, id: string): StoredSession | undefined => {
    for (const workspace of readConfig(userDataDir).workspaces) {
        const found = workspace.sessions.find((s: StoredSession) => s.id === id)
        if (found) return found
    }
    return undefined
}

/** Press on a sidebar row and move onto `target` with the mouse; the button stays down. */
async function dragRowOver(page: Page, sessionId: string, target: Locator): Promise<void> {
    const from = await page.locator(`[data-session-item="${sessionId}"]`).boundingBox()
    const to = await target.boundingBox()
    expect(from && to).toBeTruthy()
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
    await page.mouse.down()
    await page.mouse.move(from!.x + from!.width / 2 + 6, from!.y + from!.height / 2 + 6, { steps: 3 })
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 })
}

test.describe('T58 session folders', () => {
    let ctx: LaunchResult | undefined
    const dirs: string[] = []
    const dir = (): string => {
        const made = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t58-'))
        dirs.push(made)
        return made
    }
    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const made of dirs.splice(0)) fs.rmSync(made, { recursive: true, force: true })
    })

    const seed = (folder: string): SeedWorkspace[] => [
        { id: 'ws-one', name: 'T58WSONE', path: folder, sessions: [{ id: 's-a1', name: 'T58A1' }, { id: 's-a2', name: 'T58A2' }] },
        { id: 'ws-two', name: 'T58WSTWO', path: folder, sessions: [{ id: 's-b1', name: 'T58B1' }] }
    ]

    test('a folder made from the All view menu takes a dragged session, gives it back, and folds', async () => {
        ctx = await launchAppWithWorkspaces(seed(dir()), { settings: { showHomeWorkspace: false, showSessionCount: true } })
        const { page, userDataDir } = ctx
        await toggleSidebarView(page)
        const list = page.getByTestId('sidebar-all-sessions')
        await expect(list.locator('[data-session-item="s-b1"]')).toBeVisible()
        await expect(page.getByTestId('session-folder-none')).toHaveCount(0)

        await page.getByTestId('sidebar-more').click()
        await page.getByTestId('sidebar-new-session-folder').click()
        await expect(page.getByText('New Session Folder', { exact: true })).toBeVisible()
        await page.getByPlaceholder('Folder name').fill('T58 Release')
        await page.getByPlaceholder('Folder name').press('Enter')
        await expect.poll(() => storedFolders(userDataDir).map(f => f.name)).toEqual(['T58 Release'])
        const folderId = storedFolders(userDataDir)[0].id
        const heading = page.getByTestId(`session-folder-header-${folderId}`)
        const body = page.locator(`[data-session-folder-body="${folderId}"]`)
        await expect(heading).toContainText('T58 Release')
        await expect(page.locator(`[data-session-folder-count="${folderId}"]`)).toHaveText('(0)')
        await expect(body).toContainText('Drag sessions here')
        await expect(page.getByTestId('session-folder-none')).toBeVisible()

        // Drag T58B1 onto the folder heading: it lights up while over it, and takes the session on release.
        await dragRowOver(page, 's-b1', heading)
        await expect(heading).toHaveAttribute('data-drop-state', 'over')
        await page.mouse.up()
        await expect(body.locator('[data-session-item="s-b1"]')).toBeVisible()
        await expect(page.locator(`[data-session-folder-count="${folderId}"]`)).toHaveText('(1)')
        // The row moved to another list, so its own dragend never came: the split view's drop zone must still go.
        // Well inside App's 3-second safety timer, which would otherwise be what removes it.
        await expect.poll(() => page.evaluate(() => document.querySelectorAll('div.absolute.inset-0.z-30').length), { timeout: 1500 }).toBe(0)
        await expect.poll(() => storedSession(userDataDir, 's-b1')?.sessionFolderId).toBe(folderId)
        // It is still that workspace's session: the row keeps its workspace label, the tree keeps the row.
        await expect(body.locator('[data-session-item="s-b1"] [data-testid="session-workspace-label"]')).toHaveText('T58WSTWO')
        await toggleSidebarView(page)
        await expect(page.locator('[data-session-item="s-b1"]')).toBeVisible()
        await expect(page.locator(`[data-session-folder-body="${folderId}"]`)).toHaveCount(0)
        await toggleSidebarView(page)

        // Dropped on "No folder", it comes back out.
        await dragRowOver(page, 's-b1', page.getByTestId('session-folder-none'))
        await expect(page.getByTestId('session-folder-none')).toHaveAttribute('data-drop-state', 'over')
        await page.mouse.up()
        await expect(body.locator('[data-session-item="s-b1"]')).toHaveCount(0)
        await expect(list.locator('[data-session-item="s-b1"]')).toBeVisible()
        await expect.poll(() => storedSession(userDataDir, 's-b1')?.sessionFolderId).toBeUndefined()

        // The heading folds the folder, and the header's fold-all button acts on session folders —
        // one press, out of the … menu since 09aa3d01.
        await dragRowOver(page, 's-a1', heading)
        await page.mouse.up()
        await expect(body.locator('[data-session-item="s-a1"]')).toBeVisible()
        await heading.click()
        await expect(body).toHaveCount(0)
        await expect.poll(() => storedFolders(userDataDir)[0].isExpanded).toBe(false)
        // «No folder» folds too and counts for the fold-all button (cbc0ee48, T163): fold it as well.
        await page.getByTestId('session-folder-none').click()
        await expect(page.getByTestId('session-folder-none')).toHaveAttribute('data-state', 'collapsed')
        if (process.env.T58_SHOTS) {
            fs.mkdirSync(process.env.T58_SHOTS, { recursive: true })
            await page.waitForTimeout(300)
            const box = (await page.locator('.glass-panel').first().boundingBox())!
            await page.screenshot({ path: path.join(process.env.T58_SHOTS, `09aa-header-${process.env.T58_LABEL ?? 'run'}.png`), clip: { x: box.x, y: box.y, width: box.width, height: 260 } })
        }
        const foldAll = page.getByTestId('sidebar-collapse-session-folders')
        await expect(foldAll).toHaveAttribute('data-state', 'collapsed')
        await expect(foldAll).toHaveAttribute('title', 'Expand all session folders')
        await foldAll.click()
        await expect(body.locator('[data-session-item="s-a1"]')).toBeVisible()
        await expect.poll(() => storedFolders(userDataDir)[0].isExpanded).toBe(true)
        await expect(foldAll).toHaveAttribute('data-state', 'expanded')
        await foldAll.click()
        await expect(body).toHaveCount(0)
        await expect.poll(() => storedFolders(userDataDir)[0].isExpanded).toBe(false)
        // not in the … menu any more
        await page.getByTestId('sidebar-more').click()
        await expect(page.getByTestId('sidebar-more-menu').getByTestId('sidebar-collapse-session-folders')).toHaveCount(0)
        await page.keyboard.press('Escape')
        // at the default width the title is whole (or, on macOS, hidden for the traffic lights — 91fce7bf r2, T163)
        // and View ▾ stands where the folder view has it (it replaced the header toggle — view-filter-1127)
        const title = page.locator('.glass-panel > div').first().locator('span').first()
        expect(await title.evaluate((el) => getComputedStyle(el).visibility === 'hidden' || el.scrollWidth <= el.clientWidth), 'All sessions title not cut').toBe(true)
        const toggle = page.getByTestId('sidebar-view-menu')
        const allX = (await toggle.boundingBox())!.x
        await toggleSidebarView(page)
        await expect(page.getByTestId('sidebar-add-workspace')).toBeVisible()
        expect((await toggle.boundingBox())!.x, 'View ▾ does not move').toBe(allX)
        await toggleSidebarView(page)
    })

    test('right-click New Session… on a folder starts a session filed in it; on No folder, unfiled (fb-1117 b9038a0e)', async () => {
        ctx = await launchAppWithWorkspaces(
            seed(dir()).map(w => w.id === 'ws-one' ? { ...w, sessions: w.sessions.map(s => s.id === 's-a1' ? { ...s, sessionFolderId: 'sf-t58n' } : s) } : w),
            {
                settings: { showHomeWorkspace: false },
                config: { sessionFolders: [{ id: 'sf-t58n', name: 'T58 filed', isExpanded: true, createdAt: 1 }] }
            }
        )
        const { app, page } = ctx
        await resizeMainWindow(app, 1280, 800)
        const shots = process.env.T58_SHOTS
        const label = process.env.T58_LABEL ?? 'after'
        const shot = async (name: string): Promise<void> => {
            if (!shots) return
            fs.mkdirSync(shots, { recursive: true })
            await page.waitForTimeout(300)
            await page.screenshot({ path: path.join(shots, `${name}-1280-${label}.png`) })
        }
        const menu = page.locator('[data-sidebar-menu="folder"]')
        const form = page.locator('[data-new-session-dialog="all-sessions"] [data-related-new-form]')
        const sessionNamed = (name: string) => {
            for (const workspace of readConfig(ctx!.userDataDir).workspaces) {
                const found = workspace.sessions.find((s: { name: string }) => s.name === name)
                if (found) return found as StoredSession & { name: string }
            }
            return undefined
        }

        await page.locator('[data-session-item="s-a2"]').first().click()
        await toggleSidebarView(page)
        await chooseSidebarView(page, 'list')
        const header = page.getByTestId('session-folder-header-sf-t58n')
        await expect(header).toBeVisible()

        await header.click({ button: 'right' })
        await expect(menu).toBeVisible()
        await shot('folder-menu')
        await expect(menu.locator('button').first()).toHaveAttribute('data-testid', 'folder-menu-new-session')
        await page.getByTestId('folder-menu-new-session').click()
        await expect(menu).toHaveCount(0)
        await expect(form).toBeVisible()
        await expect(form).toContainText('filed in T58 filed')
        await expect(form.locator('[data-related-new-name]')).toBeFocused()

        // Esc makes nothing.
        await page.keyboard.press('Escape')
        await expect(form).toHaveCount(0)

        await header.click({ button: 'right' })
        await page.getByTestId('folder-menu-new-session').click()
        await form.locator('[data-related-new-workspace]').selectOption('ws-two')
        await form.locator('[data-related-new-name]').fill('T58 new filed')
        await shot('new-session-dialog-folder')
        await form.locator('[data-related-new-create]').click()
        await expect(form).toHaveCount(0)

        await expect.poll(() => sessionNamed('T58 new filed')?.sessionFolderId, { timeout: 10_000 }).toBe('sf-t58n')
        const filedId = sessionNamed('T58 new filed')!.id
        await expect(page.locator(`[data-session-folder-body="sf-t58n"] [data-session-item="${filedId}"]`)).toBeVisible()
        await expect(page.locator('[data-session-folder-body="sf-t58n"] [data-session-item]')).toHaveCount(2)
        await shot('folder-new-session-created')

        // "No folder": only New Session…, and the session stays out of every folder.
        await page.getByTestId('session-folder-none').click({ button: 'right' })
        await expect(menu).toBeVisible()
        await expect(menu.locator('button')).toHaveCount(1)
        await page.getByTestId('folder-menu-new-session').click()
        await expect(form).not.toContainText('filed in')
        await form.locator('[data-related-new-name]').fill('T58 new loose')
        await form.locator('[data-related-new-create]').click()
        await expect(form).toHaveCount(0)
        await expect.poll(() => sessionNamed('T58 new loose')?.id ?? '', { timeout: 10_000 }).not.toBe('')
        expect(sessionNamed('T58 new loose')?.sessionFolderId).toBeUndefined()
        await expect(page.locator('[data-session-folder-body="sf-t58n"] [data-session-item]')).toHaveCount(2)
    })

    test('renaming and deleting a folder; deleting keeps its sessions; a folder that is gone counts as none', async () => {
        const folder = dir()
        const workspaces = seed(folder)
        workspaces[0].sessions[0].sessionFolderId = 'sf-old'
        workspaces[0].sessions[1].sessionFolderId = 'sf-deleted-elsewhere'
        ctx = await launchAppWithWorkspaces(workspaces, {
            settings: { showHomeWorkspace: false },
            config: { sessionFolders: [{ id: 'sf-old', name: 'T58 Old', isExpanded: true, createdAt: 1 }] }
        })
        const { page, userDataDir } = ctx
        await toggleSidebarView(page)
        const body = page.locator('[data-session-folder-body="sf-old"]')
        await expect(body.locator('[data-session-item="s-a1"]')).toBeVisible()
        // s-a2 names a folder that does not exist: it is listed with the sessions in no folder.
        await expect(body.locator('[data-session-item="s-a2"]')).toHaveCount(0)
        await expect(page.getByTestId('sidebar-all-sessions').locator('[data-session-item="s-a2"]')).toBeVisible()

        const heading = page.getByTestId('session-folder-header-sf-old')
        // Esc throws the typed name away, even though leaving the box also blurs it.
        await heading.click({ button: 'right' })
        await page.getByRole('button', { name: 'Rename' }).click()
        await page.getByTestId('session-folder-rename').fill('T58 Thrown away')
        await page.getByTestId('session-folder-rename').press('Escape')
        await expect(heading).toContainText('T58 Old')
        await page.waitForTimeout(300)
        expect(storedFolders(userDataDir).map(f => f.name)).toEqual(['T58 Old'])

        await heading.click({ button: 'right' })
        await page.getByRole('button', { name: 'Rename' }).click()
        await page.getByTestId('session-folder-rename').fill('T58 New')
        await page.getByTestId('session-folder-rename').press('Enter')
        await expect(heading).toContainText('T58 New')
        await expect.poll(() => storedFolders(userDataDir).map(f => f.name)).toEqual(['T58 New'])

        await heading.click({ button: 'right' })
        await page.getByRole('button', { name: 'Delete Folder' }).click()
        await expect(heading).toHaveCount(0)
        await expect(page.getByTestId('session-folder-none')).toHaveCount(0)
        await expect(page.getByTestId('sidebar-all-sessions').locator('[data-session-item="s-a1"]')).toBeVisible()
        await expect.poll(() => storedFolders(userDataDir)).toEqual([])
        expect(storedSession(userDataDir, 's-a1')).toBeDefined()
        expect(storedSession(userDataDir, 's-a1')?.sessionFolderId).toBeUndefined()
    })
})
