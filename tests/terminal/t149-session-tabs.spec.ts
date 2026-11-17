import { test, expect, Page, _electron as electron, ElectronApplication } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T149 — the tab row at the top of the main area (Settings › General 「Show Session Tabs」, default on).
 *
 * A session that comes on screen gets a tab right after the one the person was on. Clicking a tab shows
 * it; ⌘⇧. / ⌘⇧, (⌘> ⌘<) step through the tabs; × closes the tab and keeps the session; ⌘W ends the
 * session and lands on the tab beside it (right, else left) — not the sidebar neighbour. The tabs and
 * the one on screen come back after a restart.
 *
 * The signal is what the person sees: which terminal is visible, the tab row's DOM, the sidebar rows,
 * and config.json for what survives a restart.
 */

const visibleSession = (page: Page): Promise<string> => page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-session-id]'))
        .filter((el) => getComputedStyle(el).visibility === 'visible')
        .map((el) => el.getAttribute('data-session-id'))
        .join(',') || 'none')

const tabOrder = (page: Page): Promise<string[]> => page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-session-tab]')).map((el) => el.getAttribute('data-session-tab') ?? ''))

const activeTab = (page: Page): Promise<string | null> => page.evaluate(() =>
    document.querySelector('[data-session-tab][data-active="true"]')?.getAttribute('data-session-tab') ?? null)

const readConfig = (dir: string): Record<string, any> => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'))
const storedSessionIds = (dir: string): string[] =>
    (readConfig(dir).workspaces ?? []).flatMap((w: { sessions?: Array<{ id: string }> }) => (w.sessions ?? []).map((s) => s.id))

/** `T149_SHOTS=<dir>`: review captures (taken before the checks that follow them). */
async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T149_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(dir, `${name}.png`) })
}

const sidebarRow = (page: Page, id: string) => page.locator(`[data-session-item="${id}"]`).first()

/** Put `sessionId` into split view next to the visible terminal — the sidebar row's HTML5 drag (as T26). */
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

/** Drag tab `id` onto the right half of tab `ontoId` — synthetic events build the drop; the order is what is checked. */
async function dragTab(page: Page, id: string, ontoId: string): Promise<void> {
    await page.evaluate(([from, onto]) => {
        const dataTransfer = new DataTransfer()
        const tab = document.querySelector(`[data-session-tab="${from}"]`)!
        const target = document.querySelector(`[data-session-tab="${onto}"]`)!
        const box = target.getBoundingClientRect()
        const at = { clientX: box.right - 2, clientY: box.top + box.height / 2 }
        tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, ...at }))
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, ...at }))
        tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
    }, [id, ontoId])
}

test.describe('T149 session tabs', () => {
    let ctx: LaunchResult | null = null
    let relaunched: ElectronApplication | null = null
    const tempDirs: string[] = []

    const tempDir = (): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t149-'))
        tempDirs.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (relaunched) await relaunched.close().catch(() => undefined)
        relaunched = null
        if (ctx) await closeApp(ctx)
        ctx = null
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    const launchThree = async (): Promise<Page> => {
        ctx = await launchAppWithWorkspaces([
            {
                id: 'ws-a', name: 'T149WSA', path: tempDir(), sessions: [
                    { id: 's-1', name: 'T149ONE' },
                    { id: 's-2', name: 'T149TWO' },
                    { id: 's-3', name: 'T149THREE' }
                ]
            },
            { id: 'ws-b', name: 'T149WSB', path: tempDir(), sessions: [{ id: 's-b', name: 'T149BEE' }] }
        ])
        const { page } = ctx
        await page.setViewportSize({ width: 1280, height: 800 })
        await sidebarRow(page, 's-1').waitFor({ timeout: 15_000 })
        return page
    }

    test('sessions opened from the sidebar become tabs; tabs switch, step, close and keep the session', async () => {
        const page = await launchThree()
        // No session on screen yet: no row.
        await expect(page.getByTestId('session-tab-bar')).toHaveCount(0)

        for (const id of ['s-1', 's-2', 's-3']) {
            await sidebarRow(page, id).click()
            await expect.poll(() => visibleSession(page)).toBe(id)
        }
        await expect.poll(() => tabOrder(page)).toEqual(['s-1', 's-2', 's-3'])
        expect(await activeTab(page)).toBe('s-3')
        // An open tab stays where it is.
        await sidebarRow(page, 's-1').click()
        await expect.poll(() => activeTab(page)).toBe('s-1')
        expect(await tabOrder(page)).toEqual(['s-1', 's-2', 's-3'])
        // A new one opens right after the tab the person was on, not at the end.
        await sidebarRow(page, 's-b').click()
        await expect.poll(() => tabOrder(page)).toEqual(['s-1', 's-b', 's-2', 's-3'])
        await page.locator('[data-session-tab="s-2"]').hover()
        await shot(page, 'after-tabs-1280')
        await page.setViewportSize({ width: 390, height: 800 })
        // Narrow window: the row scrolls, and the tab on screen is scrolled into view.
        await expect.poll(() => page.evaluate(() => {
            const row = document.querySelector('[data-testid="session-tab-bar"]')!.getBoundingClientRect()
            const tab = document.querySelector('[data-session-tab][data-active="true"]')!.getBoundingClientRect()
            return tab.left >= row.left - 1 && tab.right <= row.right + 1
        })).toBe(true)
        await shot(page, 'after-tabs-390')
        await page.setViewportSize({ width: 1280, height: 800 })

        // The tab row and the sidebar header end on one line (T36 measures the first row).
        const sidebarHeader = page.locator('div.glass-panel > div.draggable').filter({ hasText: 'Workspaces' }).first()
        const sideBox = (await sidebarHeader.boundingBox())!
        const barBox = (await page.getByTestId('session-tab-bar').boundingBox())!
        expect(Math.abs((sideBox.y + sideBox.height) - (barBox.y + barBox.height))).toBeLessThanOrEqual(1)

        // Clicking a tab shows its session.
        await page.locator('[data-session-tab="s-2"]').click()
        await expect.poll(() => visibleSession(page)).toBe('s-2')
        expect(await activeTab(page)).toBe('s-2')

        // ⌘> / ⌘< — Shift+. and Shift+, — step through the tabs and wrap round.
        await page.keyboard.press('Meta+Shift+Period')
        await expect.poll(() => visibleSession(page)).toBe('s-3')
        await page.keyboard.press('Meta+Shift+Period')
        await expect.poll(() => visibleSession(page), { message: 'wraps to the first tab' }).toBe('s-1')
        await page.keyboard.press('Meta+Shift+Comma')
        await expect.poll(() => visibleSession(page)).toBe('s-3')

        // × closes the tab (the one on screen gives way to its left neighbour); the session keeps running.
        await page.locator('[data-session-tab-close="s-3"]').click()
        await expect.poll(() => tabOrder(page)).toEqual(['s-1', 's-b', 's-2'])
        await expect.poll(() => visibleSession(page)).toBe('s-2')
        await expect(sidebarRow(page, 's-3')).toBeVisible()
        expect(storedSessionIds(ctx!.userDataDir)).toContain('s-3')
        // Opening it again from the sidebar gives it a tab again, after the current one.
        await sidebarRow(page, 's-3').click()
        await expect.poll(() => tabOrder(page)).toEqual(['s-1', 's-b', 's-2', 's-3'])

        // A middle click closes a tab that is not on screen; the screen stays.
        await page.locator('[data-session-tab="s-b"]').click({ button: 'middle' })
        await expect.poll(() => tabOrder(page)).toEqual(['s-1', 's-2', 's-3'])
        expect(await visibleSession(page)).toBe('s-3')

        // Drag reorders.
        await dragTab(page, 's-1', 's-3')
        await expect.poll(() => tabOrder(page)).toEqual(['s-2', 's-3', 's-1'])
    })

    test('⌘W ends the session and lands on the tab beside it, not the sidebar neighbour; tabs survive a restart', async () => {
        const page = await launchThree()
        for (const id of ['s-1', 's-2', 's-3']) {
            await sidebarRow(page, id).click()
            await expect.poll(() => visibleSession(page)).toBe(id)
        }
        await page.locator('[data-session-tab="s-2"]').click()
        await expect.poll(() => visibleSession(page)).toBe('s-2')

        // Sidebar neighbour of s-2 is s-1 (the row above, T26); the tab to its right is s-3.
        await page.keyboard.press('Meta+w')
        await expect(page.locator('[data-session-item="s-2"]')).toHaveCount(0, { timeout: 10_000 })
        await expect.poll(() => visibleSession(page)).toBe('s-3')
        await expect.poll(() => tabOrder(page)).toEqual(['s-1', 's-3'])
        await expect.poll(() => readConfig(ctx!.userDataDir).sessionTabs).toEqual({ ids: ['s-1', 's-3'], activeId: 's-3' })

        // --- Restart: the same tabs, and s-3 on screen without a click ---------------
        const keptDir = ctx!.userDataDir
        await ctx!.app.close()
        tempDirs.push(keptDir)
        ctx = null
        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: { ...process.env, CLIMANGER_TEST_USERDATA: keptDir, CLIMANGER_TERM_DEBUG: '1', CLIMANGER_TEST_HEADLESS: '1' } as Record<string, string>
        })
        const page2 = await relaunched.firstWindow()
        await page2.setViewportSize({ width: 1280, height: 800 })
        await expect.poll(() => tabOrder(page2), { timeout: 30_000 }).toEqual(['s-1', 's-3'])
        await expect.poll(() => visibleSession(page2), { timeout: 15_000 }).toBe('s-3')
        expect(await activeTab(page2)).toBe('s-3')
    })

    test('split view: panes get tabs, closing a pane tab removes the pane; the setting hides the row', async () => {
        const page = await launchThree()
        await sidebarRow(page, 's-1').click()
        await expect.poll(() => visibleSession(page)).toBe('s-1')
        await dropIntoSplit(page, 's-2')
        await expect.poll(() => visibleSession(page)).toBe('s-1,s-2')
        await expect.poll(() => tabOrder(page)).toContain('s-2')
        // Split view shrinks the sidebar header; the tab row follows so both still end on one line.
        const sideHeader = page.locator('div.glass-panel > div.draggable').filter({ hasText: 'Workspaces' }).first()
        await expect.poll(async () => {
            const sideBox = (await sideHeader.boundingBox())!
            const barBox = (await page.getByTestId('session-tab-bar').boundingBox())!
            return Math.round(Math.abs((sideBox.y + sideBox.height) - (barBox.y + barBox.height)))
        }).toBeLessThanOrEqual(1)
        await shot(page, 'after-split-1280')
        // Both panes are marked as on screen.
        await expect(page.locator('[data-session-tab="s-1"][data-visible="true"]')).toHaveCount(1)
        await expect(page.locator('[data-session-tab="s-2"][data-visible="true"]')).toHaveCount(1)

        // Closing a pane's tab takes the pane away; one pane left ends split view.
        await page.locator('[data-session-tab-close="s-2"]').click({ force: true })
        await expect.poll(() => visibleSession(page)).toBe('s-1')
        await expect(sidebarRow(page, 's-2')).toBeVisible()

        // Settings › General 「Show Session Tabs」 off: no row; on again: the tabs are still there.
        await page.locator('button[title^="Settings"]').click()
        await page.getByTestId('settings-show-session-tabs').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page.getByTestId('session-tab-bar')).toHaveCount(0, { timeout: 10_000 })
        // Off: opening sessions records nothing.
        await sidebarRow(page, 's-3').click()
        await expect.poll(() => visibleSession(page)).toBe('s-3')
        await shot(page, 'before-no-tabs-1280')
        await page.locator('button[title^="Settings"]').click()
        await page.getByTestId('settings-show-session-tabs').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect.poll(() => tabOrder(page), { timeout: 10_000 }).toEqual(['s-1', 's-3'])
    })
})
