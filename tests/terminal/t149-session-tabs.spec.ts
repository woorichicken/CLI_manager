import { test, expect, Page, _electron as electron, ElectronApplication } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T149 — the tab row under the main header (Settings › Sidebar 「Show Session Tabs」, default on).
 *
 * A session that comes on screen gets a tab right after the one the person was on. Clicking a tab shows
 * it; ⌘⇧. / ⌘⇧, (⌘> ⌘<) step through the tabs; × closes the tab and keeps the session; ⌘W ends the
 * session and lands on the tab beside it (right, else left) — not the sidebar neighbour. The tabs and
 * the one on screen come back after a restart.
 *
 * Preview tabs (Settings › Sidebar 「Open Sessions as Preview Tabs」, default on): a new tab is an
 * italic preview the next session shown takes the place of; typing in it, dragging it or Keep Open keeps
 * it. The older tests below switch previews off — that is the every-session-keeps-a-tab row they describe.
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

const previewTabs = (page: Page): Promise<string[]> => page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-session-tab][data-preview="true"]')).map((el) => el.getAttribute('data-session-tab') ?? ''))

/** Preview tabs off: every session shown keeps a tab (the row before preview tabs). */
const KEEP_EVERY_TAB = { previewSessionTabs: false }

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

const MANY_TAB_NAMES = [
    'api server', 'web dev', 'deploy', 'feedback batch 1117', 'night shift', 'release 1.36',
    'docs', 'chief', 'team lead: phone', 'team lead: chat view', 'worker 1', 'worker 2: session tabs'
]

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

    const launchThree = async (settings: Record<string, unknown> = KEEP_EVERY_TAB): Promise<Page> => {
        ctx = await launchAppWithWorkspaces([
            {
                id: 'ws-a', name: 'T149WSA', path: tempDir(), sessions: [
                    { id: 's-1', name: 'T149ONE' },
                    { id: 's-2', name: 'T149TWO' },
                    { id: 's-3', name: 'T149THREE' }
                ]
            },
            { id: 'ws-b', name: 'T149WSB', path: tempDir(), sessions: [{ id: 's-b', name: 'T149BEE' }] }
        ], { settings })
        const { page } = ctx
        await page.setViewportSize({ width: 1280, height: 800 })
        await sidebarRow(page, 's-1').waitFor({ timeout: 15_000 })
        return page
    }

    test('preview tabs off: sessions opened from the sidebar become tabs; tabs switch, step, close and keep the session', async () => {
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

        // The header keeps its line with the sidebar header (T36); the tab row sits right under it (review 2026-11-17).
        const sidebarHeader = page.locator('div.glass-panel > div.draggable').filter({ hasText: 'Workspaces' }).first()
        const mainHeader = page.locator('div.flex-1.glass-panel > div.draggable').first()
        const sideBox = (await sidebarHeader.boundingBox())!
        const headBox = (await mainHeader.boundingBox())!
        const barBox = (await page.getByTestId('session-tab-bar').boundingBox())!
        expect(Math.abs((sideBox.y + sideBox.height) - (headBox.y + headBox.height))).toBeLessThanOrEqual(1)
        expect(Math.abs(barBox.y - (headBox.y + headBox.height))).toBeLessThanOrEqual(1)

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
        await expect.poll(() => readConfig(ctx!.userDataDir).sessionTabs).toEqual({ ids: ['s-1', 's-3'], activeId: 's-3', previewIds: [] })

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
        // Split view shrinks the header to h-6; the tab row follows it (compact) and stays right under it.
        const mainHeader = page.locator('div.flex-1.glass-panel > div.draggable').first()
        await expect.poll(async () => {
            const headBox = (await mainHeader.boundingBox())!
            const barBox = (await page.getByTestId('session-tab-bar').boundingBox())!
            return Math.round(barBox.height) <= 24 && Math.abs(barBox.y - (headBox.y + headBox.height)) <= 1
        }).toBe(true)
        await shot(page, 'after-split-1280')
        // Both panes are marked as on screen.
        await expect(page.locator('[data-session-tab="s-1"][data-visible="true"]')).toHaveCount(1)
        await expect(page.locator('[data-session-tab="s-2"][data-visible="true"]')).toHaveCount(1)

        // Closing a pane's tab takes the pane away; one pane left ends split view.
        await page.locator('[data-session-tab-close="s-2"]').click({ force: true })
        await expect.poll(() => visibleSession(page)).toBe('s-1')
        await expect(sidebarRow(page, 's-2')).toBeVisible()

        // Settings › Sidebar 「Show Session Tabs」 off: no row; on again: the tabs are still there.
        await page.locator('button[title^="Settings"]').click()
        await page.getByTestId('settings-category-sidebar').click()
        await page.getByTestId('settings-show-session-tabs').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page.getByTestId('session-tab-bar')).toHaveCount(0, { timeout: 10_000 })
        // Off: opening sessions records nothing.
        await sidebarRow(page, 's-3').click()
        await expect.poll(() => visibleSession(page)).toBe('s-3')
        await shot(page, 'before-no-tabs-1280')
        await page.locator('button[title^="Settings"]').click()
        await page.getByTestId('settings-category-sidebar').click()
        await page.getByTestId('settings-show-session-tabs').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect.poll(() => tabOrder(page), { timeout: 10_000 }).toEqual(['s-1', 's-3'])
    })

    // talk-session-tabs-1125: opening a session no longer leaves a tab behind for good
    test('preview tabs (default): walking through sessions leaves one italic tab; Keep Open, typing and a drag keep it; previews survive a restart', async () => {
        const page = await launchThree({})
        const italic = (id: string): Promise<boolean> => page.evaluate((tab) =>
            getComputedStyle(document.querySelector(`[data-session-tab="${tab}"] [data-session-tab-name]`)!).fontStyle === 'italic', id)

        // Three sidebar clicks: one tab, in the same place, the latest session in it.
        await sidebarRow(page, 's-1').click()
        await expect.poll(() => tabOrder(page)).toEqual(['s-1'])
        await shot(page, 'preview-first-1280')
        for (const id of ['s-2', 's-3']) {
            await sidebarRow(page, id).click()
            await expect.poll(() => visibleSession(page)).toBe(id)
        }
        await expect.poll(() => tabOrder(page)).toEqual(['s-3'])
        expect(await previewTabs(page)).toEqual(['s-3'])
        expect(await italic('s-3')).toBe(true)
        await page.locator('[data-session-tab="s-3"]').hover()
        await shot(page, 'preview-walk-1280')

        // Right-click › Keep Open: the tab stays (upright) when the next session shows.
        await page.locator('[data-session-tab="s-3"]').click({ button: 'right' })
        await shot(page, 'preview-menu-1280')
        await page.locator('[data-tab-menu-item="keep-open"]').click()
        await expect.poll(() => previewTabs(page)).toEqual([])
        expect(await italic('s-3')).toBe(false)
        await sidebarRow(page, 's-1').click()
        await expect.poll(() => tabOrder(page)).toEqual(['s-3', 's-1'])
        expect(await previewTabs(page)).toEqual(['s-1'])
        // a kept tab has no Keep Open item
        await page.locator('[data-session-tab="s-3"]').click({ button: 'right' })
        await expect(page.locator('[data-session-tab-menu="s-3"]')).toBeVisible()
        await expect(page.locator('[data-tab-menu-item="keep-open"]')).toHaveCount(0)
        await page.keyboard.press('Escape')

        // ⌘] (next session in sidebar order) three times: still one preview tab beside the kept one.
        for (let i = 0; i < 3; i++) {
            const before = await visibleSession(page)
            await page.keyboard.press('Meta+BracketRight')
            await expect.poll(() => visibleSession(page)).not.toBe(before)
        }
        const afterSteps = await tabOrder(page)
        expect(afterSteps.length).toBeLessThanOrEqual(2)
        expect(afterSteps).toContain('s-3')
        expect((await previewTabs(page)).length).toBeLessThanOrEqual(1)

        // Back to the kept tab: the preview, off screen now, closes.
        await page.locator('[data-session-tab="s-3"]').click()
        await expect.poll(() => tabOrder(page)).toEqual(['s-3'])

        // Typing in the session keeps its tab.
        await sidebarRow(page, 's-2').click()
        await expect.poll(() => previewTabs(page)).toEqual(['s-2'])
        await page.locator('[data-session-id="s-2"] .xterm').click()
        await page.keyboard.type('x')
        await expect.poll(() => previewTabs(page)).toEqual([])
        expect(await tabOrder(page)).toEqual(['s-3', 's-2'])

        // A drag keeps it too.
        await sidebarRow(page, 's-b').click()
        await expect.poll(() => previewTabs(page)).toEqual(['s-b'])
        await dragTab(page, 's-b', 's-3')
        await expect.poll(() => tabOrder(page)).toEqual(['s-3', 's-b', 's-2'])
        expect(await previewTabs(page)).toEqual([])

        // A preview on screen at quit comes back as a preview.
        await sidebarRow(page, 's-1').click()
        await expect.poll(() => previewTabs(page)).toEqual(['s-1'])
        await expect.poll(() => readConfig(ctx!.userDataDir).sessionTabs?.previewIds).toEqual(['s-1'])
        const keptDir = ctx!.userDataDir
        const tabsAtQuit = await tabOrder(page)
        await ctx!.app.close()
        tempDirs.push(keptDir)
        ctx = null
        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: { ...process.env, CLIMANGER_TEST_USERDATA: keptDir, CLIMANGER_TERM_DEBUG: '1', CLIMANGER_TEST_HEADLESS: '1' } as Record<string, string>
        })
        const page2 = await relaunched.firstWindow()
        await page2.setViewportSize({ width: 1280, height: 800 })
        await expect.poll(() => tabOrder(page2), { timeout: 30_000 }).toEqual(tabsAtQuit)
        await expect.poll(() => visibleSession(page2), { timeout: 15_000 }).toBe('s-1')
        expect(await previewTabs(page2)).toEqual(['s-1'])
    })

    test('preview tabs: the setting switches them off (previews become kept tabs)', async () => {
        const page = await launchThree({})
        await sidebarRow(page, 's-1').click()
        await expect.poll(() => previewTabs(page)).toEqual(['s-1'])
        await page.locator('button[title^="Settings"]').click()
        await page.getByTestId('settings-category-sidebar').click()
        await expect(page.getByTestId('settings-preview-session-tabs')).toHaveAttribute('aria-pressed', 'true')
        await page.getByTestId('settings-preview-session-tabs').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect.poll(() => previewTabs(page), { timeout: 10_000 }).toEqual([])
        await sidebarRow(page, 's-2').click()
        await expect.poll(() => tabOrder(page)).toEqual(['s-1', 's-2'])
        expect(readConfig(ctx!.userDataDir).settings.previewSessionTabs).toBe(false)
    })

    // fb-1120b 8cc1128f: tabs keep their names' width (no shrinking to 80px) and the row scrolls sideways
    test('many tabs keep their names and the row scrolls sideways; the one on screen stays in view', async () => {
        const ids = Array.from({ length: 12 }, (_, i) => `m-${String(i + 1).padStart(2, '0')}`)
        ctx = await launchAppWithWorkspaces([{
            id: 'ws-m', name: 'T149MANY', path: tempDir(),
            // Names of different lengths, as real sessions have: long ones give way more than short ones.
            sessions: ids.map((id, i) => ({ id, name: MANY_TAB_NAMES[i] }))
        }], { config: { sessionTabs: { ids, activeId: 'm-12' } } })
        const page = ctx.page
        await page.setViewportSize({ width: 1280, height: 800 })
        await expect.poll(() => tabOrder(page), { timeout: 15_000 }).toEqual(ids)
        await expect.poll(() => visibleSession(page)).toBe('m-12')

        const measure = (): Promise<{ widths: number[]; cut: string[]; overflow: boolean; activeInView: boolean }> => page.evaluate(() => {
            const row = document.querySelector('[data-testid="session-tab-bar"]') as HTMLElement
            const rowBox = row.getBoundingClientRect()
            const tabs = Array.from(row.querySelectorAll('[data-session-tab]')) as HTMLElement[]
            const active = row.querySelector('[data-session-tab][data-active="true"]')!.getBoundingClientRect()
            return {
                widths: tabs.map((tab) => Math.round(tab.getBoundingClientRect().width)),
                cut: tabs.map((tab) => tab.querySelector('[data-session-tab-name]') as HTMLElement).filter((name) => name.scrollWidth > name.clientWidth + 1).map((name) => name.textContent ?? ''),
                overflow: row.scrollWidth > row.clientWidth + 1,
                // in view: whole, or — a tab wider than a narrow row — its start
                activeInView: active.left >= rowBox.left - 1 && (active.right <= rowBox.right + 1 || active.width > rowBox.width)
            }
        })
        // 1280: every name whole (before: twelve tabs shrank and cut their names)
        await expect.poll(async () => (await measure()).cut).toEqual([])
        const wide = await measure()
        expect(wide.cut).toEqual([])
        expect(wide.activeInView).toBe(true)
        expect(Math.min(...wide.widths)).toBeGreaterThanOrEqual(80)
        expect(Math.max(...wide.widths)).toBeLessThanOrEqual(200)
        await shot(page, 'after-many-1280')

        // 390: the same — whole names, the row scrolls to the one on screen
        await page.setViewportSize({ width: 390, height: 800 })
        await expect.poll(async () => {
            const narrow = await measure()
            return narrow.overflow && narrow.activeInView && narrow.cut.length === 0
        }).toBe(true)
        await shot(page, 'after-many-390')
    })

    test('right-click menu: close others / to the right / all, side by side, end session', async () => {
        const page = await launchThree()
        for (const id of ['s-1', 's-2', 's-3', 's-b']) {
            await sidebarRow(page, id).click()
            await expect.poll(() => visibleSession(page)).toBe(id)
        }
        await page.locator('[data-session-tab="s-2"]').click()
        await expect.poll(() => tabOrder(page)).toEqual(['s-1', 's-2', 's-3', 's-b'])

        const openMenu = async (id: string): Promise<void> => {
            await page.locator(`[data-session-tab="${id}"]`).click({ button: 'right' })
            await expect(page.locator(`[data-session-tab-menu="${id}"]`)).toBeVisible()
        }
        const item = (name: string) => page.locator(`[data-tab-menu-item="${name}"]`)

        // Esc and a press outside close the menu without doing anything.
        await openMenu('s-1')
        await shot(page, 'after-menu-1280')
        await page.keyboard.press('Escape')
        await expect(page.locator('[data-session-tab-menu]')).toHaveCount(0)
        await openMenu('s-1')
        await page.mouse.click(700, 400)
        await expect(page.locator('[data-session-tab-menu]')).toHaveCount(0)
        expect(await tabOrder(page)).toEqual(['s-1', 's-2', 's-3', 's-b'])

        // The last tab has nothing to its right.
        await openMenu('s-b')
        await expect(item('close-right')).toBeDisabled()
        await page.keyboard.press('Escape')

        // Close Tabs to the Right of s-3: s-b goes; the screen (s-2) stays.
        await openMenu('s-3')
        await item('close-right').click()
        await expect.poll(() => tabOrder(page)).toEqual(['s-1', 's-2', 's-3'])
        expect(await visibleSession(page)).toBe('s-2')
        await expect(sidebarRow(page, 's-b')).toBeVisible()

        // Open Side by Side: s-3 joins the session on screen in split view; the one on screen cannot pair with itself.
        await openMenu('s-2')
        await expect(item('side-by-side')).toBeDisabled()
        await page.keyboard.press('Escape')
        await openMenu('s-3')
        await item('side-by-side').click()
        await expect.poll(() => visibleSession(page)).toBe('s-2,s-3')
        await openMenu('s-3')
        await expect(item('side-by-side')).toBeDisabled()
        await page.keyboard.press('Escape')

        // Close Other Tabs from s-1: s-2 and s-3 leave the row and split view; s-1 comes on screen.
        await openMenu('s-1')
        await item('close-others').click()
        await expect.poll(() => tabOrder(page)).toEqual(['s-1'])
        await expect.poll(() => visibleSession(page)).toBe('s-1')
        for (const id of ['s-2', 's-3']) await expect(sidebarRow(page, id)).toBeVisible()

        // End Session: the session itself goes (sidebar and config), as ⌘W would.
        await sidebarRow(page, 's-2').click()
        await expect.poll(() => tabOrder(page)).toEqual(['s-1', 's-2'])
        await openMenu('s-2')
        await item('end-session').click()
        await expect(page.locator('[data-session-item="s-2"]')).toHaveCount(0, { timeout: 10_000 })
        await expect.poll(() => storedSessionIds(ctx!.userDataDir)).not.toContain('s-2')
        await expect.poll(() => tabOrder(page)).toEqual(['s-1'])
        await expect.poll(() => visibleSession(page)).toBe('s-1')

        // Close All Tabs: no row, nothing on screen, sessions still in the sidebar.
        await openMenu('s-1')
        await item('close-all').click()
        await expect(page.getByTestId('session-tab-bar')).toHaveCount(0)
        await expect(sidebarRow(page, 's-1')).toBeVisible()
    })
})
