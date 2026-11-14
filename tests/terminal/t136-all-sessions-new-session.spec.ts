import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, resizeMainWindow, LaunchResult, termText } from './helpers'
import type { SessionRelation, Workspace } from '../../src/shared/types'

/**
 * T136 — "New session" in the sidebar's All sessions view (report c63a93c0).
 *
 * All sessions has a toolbar row (List · Tree on the left, New session on the
 * right) that opens the same small dialog the Related dialog uses: project,
 * template, name. The new session is shown, listed in All sessions, runs the
 * template and is related to nothing. The folder view has no such button; the
 * header keeps its buttons (title not cut, view toggle in place).
 *
 * Judged in the DOM, config.json and the terminal buffer.
 */

const FIRST = 't136-first-4000-8000-000000000001'
const SECOND = 't136-secnd-4000-8000-000000000002'
const OTHER = 't136-other-4000-8000-000000000003'
const NAMES: Record<string, string> = {
    [FIRST]: 'first shell',
    [SECOND]: 'second shell',
    [OTHER]: 'other shell'
}
const TEMPLATE = { id: 't136-echo', name: 'T136 echo', icon: 'terminal', description: 'prints a marker', command: 'echo T136-TEMPLATE-RAN' }

test.describe('T136 All sessions New session (c63a93c0)', () => {
    let ctx: LaunchResult | undefined
    const temps: string[] = []

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    async function launch(): Promise<LaunchResult> {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t136-ws-'))
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t136-other-'))
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t136-home-'))
        temps.push(folder, other, homeDir)
        const session = (id: string) => ({ id, name: NAMES[id] })
        return launchAppWithWorkspaces(
            [
                { id: 'ws-t136', name: 'T136 project', path: folder, sessions: [session(FIRST), session(SECOND)] },
                { id: 'ws-t136-other', name: 'T136 other project', path: other, sessions: [session(OTHER)] }
            ],
            { env: { CLIMANAGER_HOME: homeDir }, customTemplates: [TEMPLATE] }
        )
    }

    const newButton = (p: Page) => p.getByTestId('all-sessions-new-session')
    const form = (p: Page) => p.locator('[data-new-session-dialog="all-sessions"] [data-related-new-form]')
    const configOnDisk = (userDataDir: string) =>
        JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf8')) as { workspaces: Workspace[]; sessionRelations?: SessionRelation[] }
    const shotsDir = (): string | undefined => {
        const shots = process.env.T136_SHOTS
        if (shots) fs.mkdirSync(shots, { recursive: true })
        return shots
    }
    const label = (): string => process.env.T136_LABEL ?? 'after'

    test('T136 New session from All sessions: dialog, created, listed, unrelated', async () => {
        ctx = await launch()
        const { page } = ctx
        const shots = shotsDir()

        await activateSession(page, NAMES[SECOND])
        const toggle = page.getByTestId('sidebar-view-toggle')
        const toggleXInFolders = (await toggle.boundingBox())!.x
        await toggle.click()
        await expect(page.getByTestId('sidebar-all-sessions')).toBeVisible()
        if (shots) await page.screenshot({ path: path.join(shots, `all-sessions-1280-${label()}.png`) })

        // The header is untouched: same view toggle place, title not cut at the default width.
        expect((await toggle.boundingBox())!.x).toBe(toggleXInFolders)
        const titleCut = await page.evaluate(() => {
            const title = Array.from(document.querySelectorAll('span')).find(el => el.textContent === 'All sessions')
            return title ? title.scrollWidth > title.clientWidth : true
        })
        expect(titleCut).toBe(false)

        const sessionCount = () => configOnDisk(ctx!.userDataDir).workspaces.reduce((n, w) => n + w.sessions.length, 0)
        const countBefore = sessionCount()
        await expect(newButton(page)).toBeVisible()
        await newButton(page).click()
        await expect(form(page)).toBeVisible()
        // Starts in the project of the session on screen.
        await expect(form(page).locator('[data-related-new-workspace]')).toHaveValue('ws-t136')
        await expect(form(page).locator('[data-related-new-name]')).toBeFocused()

        // Esc leaves without making anything.
        await page.keyboard.press('Escape')
        await expect(form(page)).toHaveCount(0)
        expect(sessionCount()).toBe(countBefore)

        await newButton(page).click()
        await form(page).locator('[data-related-new-workspace]').selectOption('ws-t136-other')
        await form(page).locator('[data-related-new-template]').selectOption(TEMPLATE.id)
        await form(page).locator('[data-related-new-name]').fill('T136 created')
        if (shots) await page.screenshot({ path: path.join(shots, `new-session-dialog-1280-${label()}.png`) })
        await form(page).locator('[data-related-new-create]').click()
        await expect(form(page)).toHaveCount(0)

        let createdId = ''
        await expect.poll(() => {
            const otherWs = configOnDisk(ctx!.userDataDir).workspaces.find(w => w.id === 'ws-t136-other')
            createdId = otherWs?.sessions.find(s => s.name === 'T136 created')?.id ?? ''
            return createdId
        }, { timeout: 10_000 }).not.toBe('')

        // On screen, running the template, and in the All sessions list (still the All view).
        await expect(page.locator(`[data-related-button="${createdId}"]`)).toBeVisible()
        await expect.poll(() => termText(page, createdId), { timeout: 15_000 }).toContain('T136-TEMPLATE-RAN')
        await expect(page.getByTestId('sidebar-view-toggle')).toHaveAttribute('data-state', 'all')
        await expect(page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${createdId}"]`)).toBeVisible()
        if (shots) await page.screenshot({ path: path.join(shots, `all-sessions-created-1280-${label()}.png`) })

        // Started from no session, so related to none.
        await page.waitForTimeout(500)
        const relations = configOnDisk(ctx!.userDataDir).sessionRelations ?? []
        expect(relations.filter(r => r.from === createdId || r.to === createdId)).toEqual([])

        // The folder view has no such button.
        await page.getByTestId('sidebar-view-toggle').click()
        await expect(page.getByTestId('sidebar-all-sessions')).toHaveCount(0)
        await expect(newButton(page)).toHaveCount(0)
    })

    test('T136 narrow window keeps the dialog on screen', async () => {
        ctx = await launch()
        const { page } = ctx
        const shots = shotsDir()
        await resizeMainWindow(ctx.app, 390, 800)
        await activateSession(page, NAMES[FIRST])
        await page.getByTestId('sidebar-view-toggle').click()
        await expect(page.getByTestId('sidebar-all-sessions')).toBeVisible()
        if (shots) await page.screenshot({ path: path.join(shots, `all-sessions-390-${label()}.png`) })
        await expect(newButton(page)).toBeVisible()
        await newButton(page).click()
        await expect(form(page)).toBeVisible()
        const width = await page.evaluate(() => window.innerWidth)
        for (const selector of ['[data-related-new-workspace]', '[data-related-new-template]', '[data-related-new-name]', '[data-related-new-create]']) {
            const box = await form(page).locator(selector).boundingBox()
            expect(box, selector).not.toBeNull()
            expect(box!.x, selector).toBeGreaterThanOrEqual(0)
            expect(box!.x + box!.width, selector).toBeLessThanOrEqual(width)
        }
        if (shots) await page.screenshot({ path: path.join(shots, `new-session-dialog-390-${label()}.png`) })
    })
})
