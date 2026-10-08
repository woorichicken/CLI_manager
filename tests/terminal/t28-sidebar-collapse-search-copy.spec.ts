import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'

/**
 * T28 — sidebar collapse-all, project search, and copy-to-clipboard.
 *
 * All three are judged at the user's end: rows on screen (DOM), folder state on
 * disk (config.json), and the system clipboard read back from the main process.
 * A store-level or state-level check would pass while the button did nothing.
 */

const readConfig = (userDataDir: string) =>
    JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))

const folderExpandedOnDisk = (userDataDir: string, folderId: string): boolean | undefined =>
    readConfig(userDataDir).folders.find((f: { id: string }) => f.id === folderId)?.isExpanded

/** Seeded session rows the user can see in the sidebar (the home workspace adds its own). */
const visibleSessionRows = (page: Page, wanted: string[]): Promise<string[]> => page.evaluate((ids) =>
    Array.from(document.querySelectorAll('[data-session-item]'))
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => el.getAttribute('data-session-item') ?? '')
        .filter((id) => ids.includes(id)), wanted)

/** Id of the single visible terminal — what the user is looking at. */
const visibleTerminal = (page: Page): Promise<string> => page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-session-id]'))
        .filter((el) => getComputedStyle(el).visibility === 'visible')
        .map((el) => el.getAttribute('data-session-id'))
        .join(',') || 'none')

test.describe('T28 sidebar collapse all / search / copy', () => {
    let ctx: LaunchResult
    const tempDirs: string[] = []

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('collapse all folds folders and session lists, the next press restores them', async () => {
        ctx = await launchAppWithWorkspaces(
            [
                { id: 'ws-loose', name: 'T28LOOSE', sessions: [{ id: 's-loose', name: 'T28SESSLOOSE' }] },
                { id: 'ws-infolder', name: 'T28INFOLDER', folderId: 'f-open', sessions: [{ id: 's-infolder', name: 'T28SESSFOLDER' }] }
            ],
            {
                folders: [
                    { id: 'f-open', name: 'T28OPEN', isExpanded: true, createdAt: 1700000000000 },
                    { id: 'f-closed', name: 'T28CLOSED', isExpanded: false, createdAt: 1700000000001 }
                ],
                // The fold-by-hand step below must be able to close every visible row
                settings: { showHomeWorkspace: false }
            }
        )
        const { page, userDataDir } = ctx
        const SEEDED = ['s-infolder', 's-loose']
        const button = page.getByTestId('sidebar-collapse-all')

        await expect.poll(() => visibleSessionRows(page, SEEDED)).toEqual(['s-infolder', 's-loose'])
        await expect(button).toHaveAttribute('data-state', 'expanded')

        // Collapse: no session rows, the folder's workspace hidden, folder state saved.
        await button.click()
        await expect.poll(() => visibleSessionRows(page, SEEDED)).toEqual([])
        await expect(page.locator('[data-workspace-item="ws-infolder"]')).toHaveCount(0)
        await expect(page.locator('[data-workspace-item="ws-loose"]')).toBeVisible()
        await expect(button).toHaveAttribute('data-state', 'collapsed')
        await expect.poll(() => folderExpandedOnDisk(userDataDir, 'f-open')).toBe(false)

        // Collapsing ends no session — "close" here means fold, not terminate.
        await expect.poll(() => page.evaluate(() =>
            (window as unknown as { __termDebug: { ids: () => string[] } }).__termDebug.ids()
        )).toEqual(expect.arrayContaining(SEEDED))

        // Restore: exactly what was open comes back — the closed folder stays closed.
        await button.click()
        await expect.poll(() => visibleSessionRows(page, SEEDED)).toEqual(['s-infolder', 's-loose'])
        await expect.poll(() => folderExpandedOnDisk(userDataDir, 'f-open')).toBe(true)
        expect(folderExpandedOnDisk(userDataDir, 'f-closed')).toBe(false)

        // Folded by hand there is nothing to restore, so the button expands everything.
        await page.getByTestId('folder-header-f-open').click()
        await page.locator('[data-workspace-item="ws-loose"] > div').first().click()
        await expect.poll(() => visibleSessionRows(page, SEEDED)).toEqual([])
        await expect(button).toHaveAttribute('data-state', 'collapsed')
        await button.click()
        await expect.poll(() => visibleSessionRows(page, SEEDED)).toEqual(['s-infolder', 's-loose'])
        await expect.poll(() => folderExpandedOnDisk(userDataDir, 'f-closed')).toBe(true)
    })

    test('search finds projects by name, folder and path, and Enter opens the top one', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t28-'))
        tempDirs.push(root)
        const dir = (name: string) => {
            const p = path.join(root, name)
            fs.mkdirSync(p, { recursive: true })
            return p
        }

        ctx = await launchAppWithWorkspaces(
            [
                { id: 'ws-beta', name: 'T28BETA', path: dir('beta'), sessions: [{ id: 's-beta', name: 'T28SESSBETA' }] },
                { id: 'ws-alpha', name: 'T28ALPHA', path: dir('alpha'), folderId: 'f-client', sessions: [{ id: 's-alpha', name: 'T28SESSALPHA' }] },
                { id: 'ws-gamma', name: 'T28GAMMA', path: dir('special-dir/gamma'), sessions: [{ id: 's-gamma', name: 'T28SESSGAMMA' }] }
            ],
            // The folder is closed: a match inside it must still be found.
            { folders: [{ id: 'f-client', name: 'T28CLIENTFOLDER', isExpanded: false, createdAt: 1700000000000 }] }
        )
        const { page } = ctx
        const results = page.getByTestId('sidebar-search-results')
        const resultNames = () => results.locator('[data-workspace-item]').evaluateAll(els =>
            els.map(el => el.getAttribute('data-workspace-item')))

        await page.getByTestId('sidebar-search-toggle').click()
        const input = page.getByTestId('sidebar-search-input')
        await expect(input).toBeFocused()

        await input.fill('t28beta')
        await expect.poll(resultNames).toEqual(['ws-beta'])

        await input.fill('clientfolder')
        await expect.poll(resultNames).toEqual(['ws-alpha'])

        await input.fill('special-dir')
        await expect.poll(resultNames).toEqual(['ws-gamma'])

        await input.fill('t28')
        await expect.poll(resultNames).toEqual(['ws-beta', 'ws-alpha', 'ws-gamma'])

        await input.fill('nothing-matches-this')
        await expect(page.getByTestId('sidebar-search-empty')).toBeVisible()

        // Enter opens the first session of the top result.
        await input.fill('gamma')
        await input.press('Enter')
        await expect.poll(() => visibleTerminal(page)).toBe('s-gamma')

        // Escape clears and returns to the normal list; the folder is still closed.
        await input.press('Escape')
        await expect(input).toHaveCount(0)
        await expect(results).toHaveCount(0)
        await expect(page.getByTestId('folder-header-f-client')).toBeVisible()
        await expect(page.locator('[data-workspace-item="ws-alpha"]')).toHaveCount(0)
    })

    test('session and workspace menus copy name, path and session ID', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t28-'))
        tempDirs.push(root)
        const wsPath = path.join(root, 'copy-project')
        fs.mkdirSync(wsPath)

        ctx = await launchAppWithWorkspaces([
            { id: 'ws-copy', name: 'T28COPY', path: wsPath, sessions: [{ id: 's-copy', name: 'T28SESSCOPY' }] }
        ])
        const { app, page } = ctx

        // The clipboard is the machine's, not the test's: put back what was there.
        const savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
        const readClipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())
        const notice = page.getByTestId('sidebar-copy-notice')

        try {
            const copyFromSessionMenu = async (item: string) => {
                await page.locator('[data-session-item="s-copy"]').click({ button: 'right' })
                await page.getByRole('button', { name: item, exact: true }).click()
            }

            await copyFromSessionMenu('Copy Session ID')
            await expect.poll(readClipboard).toBe('s-copy')
            await expect(notice).toContainText('Copied session ID')
            await expect(notice).toContainText('s-copy')

            await copyFromSessionMenu('Copy Name')
            await expect.poll(readClipboard).toBe('T28SESSCOPY')

            await copyFromSessionMenu('Copy Path')
            await expect.poll(readClipboard).toBe(wsPath)

            await page.locator('[data-workspace-item="ws-copy"] > div').first().click({ button: 'right' })
            await page.getByRole('button', { name: 'Copy Name', exact: true }).click()
            await expect.poll(readClipboard).toBe('T28COPY')

            // The notice goes away on its own.
            await expect(notice).toHaveCount(0, { timeout: 5_000 })
        } finally {
            await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard)
        }
    })
})
