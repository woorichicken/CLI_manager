import { test, expect, Page } from '@playwright/test'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'

/**
 * T46 — sidebar search finds sessions by name.
 *
 * Project results keep their place and behavior (T28); a "Sessions" group follows
 * them. Judged on the rows on screen and the terminal that comes to the front.
 */

const visibleTerminal = (page: Page): Promise<string> => page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-session-id]'))
        .filter((el) => getComputedStyle(el).visibility === 'visible')
        .map((el) => el.getAttribute('data-session-id'))
        .join(',') || 'none')

test.describe('T46 sidebar session search', () => {
    let ctx: LaunchResult
    test.afterEach(async () => { if (ctx) await closeApp(ctx) })

    test('a session name finds the session (even in a closed folder) and Enter opens it', async () => {
        ctx = await launchAppWithWorkspaces(
            [
                // First on purpose: the harness waits for the first workspace's name, which a closed folder would hide.
                { id: 'ws-two', name: 'T46TWO', sessions: [{ id: 's-deploy2', name: 'old T46DEPLOY notes' }] },
                { id: 'ws-one', name: 'T46ONE', folderId: 'f-closed', sessions: [{ id: 's-deploy', name: 'T46DEPLOY' }, { id: 's-other', name: 'T46OTHER' }] }
            ],
            {
                folders: [{ id: 'f-closed', name: 'T46FOLDER', isExpanded: false, createdAt: 1700000000000 }],
                settings: { showHomeWorkspace: false }
            }
        )
        const { page } = ctx
        await page.getByTestId('sidebar-search-toggle').click()
        const input = page.getByTestId('sidebar-search-input')
        const sessionRows = page.getByTestId('sidebar-search-session-results').locator('[data-session-item]')
        const rowIds = () => sessionRows.evaluateAll(els => els.map(el => el.getAttribute('data-session-item')))

        // Only session names match: no project row, two session rows, name-prefix match first.
        await input.fill('t46deploy')
        await expect.poll(rowIds).toEqual(['s-deploy', 's-deploy2'])
        await expect(page.getByTestId('sidebar-search-results').locator('[data-workspace-item]')).toHaveCount(0)
        await expect(page.getByTestId('sidebar-search-sessions-heading')).toContainText('2 sessions')
        await expect(page.getByTestId('sidebar-search-empty')).toHaveCount(0)

        // Each result names its workspace.
        await expect(sessionRows.first().getByTestId('session-workspace-label')).toHaveText('T46ONE')

        // Enter opens the first result.
        await input.press('Enter')
        await expect.poll(() => visibleTerminal(page)).toBe('s-deploy')

        // Clicking another result goes there too.
        await sessionRows.nth(1).click()
        await expect.poll(() => visibleTerminal(page)).toBe('s-deploy2')

        // Nothing matches: the empty state names both kinds.
        await input.fill('zzz-nothing')
        await expect(page.getByTestId('sidebar-search-empty')).toContainText('projects or sessions')

        // Escape returns to the tree; finding a session did not open its closed folder.
        await input.press('Escape')
        await expect(page.getByTestId('folder-header-f-closed')).toBeVisible()
        await expect(page.locator('[data-workspace-item="ws-one"]')).toHaveCount(0)
    })

    test('projects stay first and Enter keeps opening the top project', async () => {
        ctx = await launchAppWithWorkspaces(
            [
                { id: 'ws-p', name: 'T46SHARED', sessions: [{ id: 's-p', name: 'plain' }] },
                { id: 'ws-q', name: 'T46OTHERWS', sessions: [{ id: 's-q', name: 'T46SHARED review' }] }
            ],
            { settings: { showHomeWorkspace: false } }
        )
        const { page } = ctx
        await page.getByTestId('sidebar-search-toggle').click()
        const input = page.getByTestId('sidebar-search-input')
        await input.fill('t46shared')

        // Project group first, session group after it.
        const results = page.getByTestId('sidebar-search-results')
        await expect(results.locator('[data-workspace-item="ws-p"]')).toBeVisible()
        await expect(page.getByTestId('sidebar-search-session-results').locator('[data-session-item="s-q"]')).toBeVisible()
        const projectBox = await results.locator('[data-workspace-item="ws-p"]').boundingBox()
        const sessionBox = await page.getByTestId('sidebar-search-session-results').boundingBox()
        expect(projectBox!.y).toBeLessThan(sessionBox!.y)

        // Enter still opens the project's first session (unchanged behavior).
        await input.press('Enter')
        await expect.poll(() => visibleTerminal(page)).toBe('s-p')
    })
})
