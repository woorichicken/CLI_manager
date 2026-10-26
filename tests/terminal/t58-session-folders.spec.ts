import { test, expect, Page, Locator } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult, SeedWorkspace } from './helpers'

/**
 * T58 — session folders in the sidebar's All sessions view (report 078ee766).
 *
 * A session keeps its workspace and may also sit in one session folder. Made
 * from the All view's "…" menu, filled by dragging a session row onto the
 * folder heading (a real mouse drag, not synthetic events), emptied by dropping
 * on "No folder". Judged in the DOM and in config.json.
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
        await page.getByTestId('sidebar-view-toggle').click()
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
        await page.getByTestId('sidebar-view-toggle').click()
        await expect(page.locator('[data-session-item="s-b1"]')).toBeVisible()
        await expect(page.locator(`[data-session-folder-body="${folderId}"]`)).toHaveCount(0)
        await page.getByTestId('sidebar-view-toggle').click()

        // Dropped on "No folder", it comes back out.
        await dragRowOver(page, 's-b1', page.getByTestId('session-folder-none'))
        await expect(page.getByTestId('session-folder-none')).toHaveAttribute('data-drop-state', 'over')
        await page.mouse.up()
        await expect(body.locator('[data-session-item="s-b1"]')).toHaveCount(0)
        await expect(list.locator('[data-session-item="s-b1"]')).toBeVisible()
        await expect.poll(() => storedSession(userDataDir, 's-b1')?.sessionFolderId).toBeUndefined()

        // The heading folds the folder, and the menu's Collapse All / Expand All acts on session folders.
        await dragRowOver(page, 's-a1', heading)
        await page.mouse.up()
        await expect(body.locator('[data-session-item="s-a1"]')).toBeVisible()
        await heading.click()
        await expect(body).toHaveCount(0)
        await expect.poll(() => storedFolders(userDataDir)[0].isExpanded).toBe(false)
        await page.getByTestId('sidebar-more').click()
        await expect(page.getByTestId('sidebar-collapse-session-folders')).toHaveText('Expand All')
        await page.getByTestId('sidebar-collapse-session-folders').click()
        await expect(body.locator('[data-session-item="s-a1"]')).toBeVisible()
        await expect.poll(() => storedFolders(userDataDir)[0].isExpanded).toBe(true)
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
        await page.getByTestId('sidebar-view-toggle').click()
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
