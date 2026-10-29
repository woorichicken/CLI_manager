import { test, expect, Page } from '@playwright/test'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'
import type { SessionRelation } from '../../src/shared/types'

/**
 * T69 — pick several sessions in All sessions and copy their ids (fb-1029b · 0d1e3d34).
 *
 * The check box sits where the row icon is: it shows on hover, and on every row
 * once something is picked. Ticking it picks the row without opening it; clicking
 * the row itself still opens the session. The bar under the list copies the full
 * ids one per line in pick order, opens 2–4 side by side, and Esc / ✕ clear it.
 * Same in the Tree layout.
 *
 * Fails on the code before this change: there is no check box to tick.
 */

const S = Array.from({ length: 6 }, (_, i) => `t69-s${i}-0000-4000-8000-00000000000${i}`)
const RELATIONS: SessionRelation[] = [
    { from: S[0], to: S[1], kind: 'opened', at: 1 },
    { from: S[0], to: S[2], kind: 'opened', at: 2 }
]

const row = (page: Page, id: string) => page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${id}"]`)
const box = (page: Page, id: string) => page.locator(`[data-session-select="${id}"]`)
const bar = (page: Page) => page.getByTestId('session-selection-bar')

const visibleTerminals = (page: Page) =>
    page.evaluate(() => Array.from(document.querySelectorAll('[data-session-id]'))
        .filter(el => getComputedStyle(el).visibility === 'visible' && (el as HTMLElement).offsetWidth > 0)
        .map(el => el.getAttribute('data-session-id')))

async function tick(page: Page, id: string): Promise<void> {
    await row(page, id).hover()
    await box(page, id).click()
}

test.describe('T69 All sessions select', () => {
    let ctx: LaunchResult | undefined
    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
    })

    test('pick three, copy their ids, rows still open, side by side, Esc and ✕ clear; the same in Tree', async () => {
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-t69a', name: 'T69 alpha', sessions: S.slice(0, 3).map((id, i) => ({ id, name: `T69 row ${i}` })) },
            { id: 'ws-t69b', name: 'T69 beta', sessions: S.slice(3).map((id, i) => ({ id, name: `T69 row ${i + 3}` })) }
        ], { settings: { showHomeWorkspace: false }, config: { sessionRelations: RELATIONS } })
        const { app, page } = ctx
        const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
        const readClipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())

        try {
            await page.locator(`[data-session-item="${S[0]}"]`).first().click()
            await page.getByTestId('sidebar-view-toggle').click()
            await page.getByTestId('all-sessions-layout-list').click()

            // Hidden until hovered; nothing picked yet, no bar.
            await expect(box(page, S[1])).toBeHidden()
            await expect(bar(page)).toHaveCount(0)

            await tick(page, S[4])
            await tick(page, S[1])
            await tick(page, S[5])
            await expect(page.getByTestId('session-selection-count')).toHaveText('3 selected')
            // Picking did not open anything: the first session is still the one on screen.
            await expect.poll(() => visibleTerminals(page)).toEqual([S[0]])
            // With something picked every row shows its box.
            await expect(box(page, S[2])).toBeVisible()
            await expect(box(page, S[1])).toBeChecked()

            await page.getByTestId('session-selection-copy').click()
            await expect.poll(readClipboard).toBe([S[4], S[1], S[5]].join('\n'))
            await expect(page.getByTestId('session-selection-copy')).toHaveText('Copied')

            // Clicking the row (not its box) still opens that session; the pick stays.
            await row(page, S[3]).getByText('T69 row 3', { exact: true }).click()
            await expect.poll(() => visibleTerminals(page)).toEqual([S[3]])
            await expect(page.getByTestId('session-selection-count')).toHaveText('3 selected')

            // Side by side: the three, in pick order.
            await page.getByTestId('session-selection-split').click()
            await expect.poll(async () => (await visibleTerminals(page)).sort()).toEqual([S[1], S[4], S[5]].sort())

            // Five picked: more than split view holds, so Side by side is off; Copy IDs still takes all.
            await tick(page, S[2])
            await tick(page, S[3])
            await expect(page.getByTestId('session-selection-count')).toHaveText('5 selected')
            await expect(page.getByTestId('session-selection-split')).toBeDisabled()
            await page.getByTestId('session-selection-copy').click()
            await expect.poll(readClipboard).toBe([S[4], S[1], S[5], S[2], S[3]].join('\n'))

            // The bar fits the default sidebar width: nothing spills out, ✕ stays inside.
            const fits = await bar(page).evaluate((el) => {
                const box = el.getBoundingClientRect()
                const clear = el.querySelector('[data-testid="session-selection-clear"]')!.getBoundingClientRect()
                return el.scrollWidth <= el.clientWidth && clear.right <= box.right && clear.left >= box.left
            })
            expect(fits).toBe(true)

            // Esc in a rename box cancels the rename, not the pick.
            await row(page, S[0]).click({ button: 'right' })
            await page.getByRole('button', { name: 'Rename', exact: true }).click()
            await page.keyboard.press('Escape')
            await expect(page.getByTestId('session-selection-count')).toHaveText('5 selected')

            // Unticking drops one; Esc (focus on a box) clears all.
            await box(page, S[2]).click()
            await expect(page.getByTestId('session-selection-count')).toHaveText('4 selected')
            await box(page, S[3]).focus()
            await page.keyboard.press('Escape')
            await expect(bar(page)).toHaveCount(0)
            await expect(box(page, S[1])).toBeHidden()

            // Tree: the same boxes and bar.
            await page.getByTestId('all-sessions-layout-tree').click()
            await expect(page.getByTestId('sidebar-session-tree')).toBeVisible()
            await tick(page, S[2])
            await tick(page, S[0])
            await expect(page.getByTestId('session-selection-count')).toHaveText('2 selected')
            await page.getByTestId('session-selection-copy').click()
            await expect.poll(readClipboard).toBe([S[2], S[0]].join('\n'))
            await page.getByTestId('session-selection-clear').click()
            await expect(bar(page)).toHaveCount(0)
        } finally {
            await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
        }
    })
})
