import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, resizeMainWindow, type LaunchResult } from './helpers'
import type { SessionRelation } from '../../src/shared/types'

/**
 * T155 — fb-1120b tabs, renaming, Related.
 *
 *  - 13968765: a tab's right-click menu has Rename…, and a double-click renames too — in place on the tab,
 *    saved to config.json and the sidebar; Escape keeps the old name. (A mouse drag inside the tab's field does
 *    not select yet — fb-1120b found-defects; the field opens with its text selected.)
 *  - 0444a98b: while a sidebar row's name is edited, a mouse drag in the field selects its letters
 *    (before: the whole row started an HTML drag and nothing was selected).
 *  - 4c2d2e9c: the Related dialog narrows its rows by name; Escape clears the words, the next one closes.
 *
 * T155_SHOTS=<dir> (+ T155_LABEL) saves captures before the checks.
 */

const LABEL = process.env.T155_LABEL ?? 'after'
async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T155_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

let ctx: LaunchResult | undefined
const temps: string[] = []
test.afterEach(async () => {
    if (ctx) await closeApp(ctx)
    ctx = undefined
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    temps.push(dir)
    return dir
}
const storedName = (id: string): string | undefined =>
    (JSON.parse(fs.readFileSync(path.join(ctx!.userDataDir, 'config.json'), 'utf8')) as { workspaces: { sessions: { id: string; name: string }[] }[] })
        .workspaces.flatMap((w) => w.sessions).find((s) => s.id === id)?.name
const tab = (page: Page, id: string) => page.locator(`[data-session-tab="${id}"]`)

test('T155 13968765 · 0444a98b: rename a tab from its menu or a double-click; drag selects letters in the sidebar rename', async () => {
    const ids = ['t155-a', 't155-b', 't155-c']
    ctx = await launchAppWithWorkspaces(
        [{ id: 'ws-t155', name: 'T155 project', path: tempDir('climanager-t155-ws-'), sessions: [
            { id: 't155-a', name: 'alpha session' }, { id: 't155-b', name: 'beta session' }, { id: 't155-c', name: 'gamma session' }
        ] }],
        { config: { sessionTabs: { ids, activeId: 't155-a' } } }
    )
    const { page } = ctx
    await resizeMainWindow(ctx.app, 1280, 800)
    await expect(tab(page, 't155-b')).toBeVisible({ timeout: 15_000 })

    // right-click › Rename… → a field on the tab; Escape keeps the name
    await tab(page, 't155-b').click({ button: 'right' })
    await shot(page, 't155-1-tab-menu')
    await page.locator('[data-tab-menu-item="rename"]').click()
    const field = tab(page, 't155-b').locator('[data-session-tab-rename]')
    await expect(field).toBeFocused()
    await field.fill('not this')
    await field.press('Escape')
    await expect(tab(page, 't155-b').locator('[data-session-tab-name]')).toHaveText('beta session')
    // again, Enter saves: the tab, config.json and the sidebar row
    await tab(page, 't155-b').click({ button: 'right' })
    await page.locator('[data-tab-menu-item="rename"]').click()
    await field.fill('beta renamed')
    await field.press('Enter')
    await expect(tab(page, 't155-b').locator('[data-session-tab-name]')).toHaveText('beta renamed')
    await expect.poll(() => storedName('t155-b')).toBe('beta renamed')
    await expect(page.locator('[data-session-item="t155-b"]').first()).toContainText('beta renamed')

    // a double-click renames too (its first click shows the session and takes the focus — the field keeps it)
    await tab(page, 't155-c').dblclick()
    const field2 = tab(page, 't155-c').locator('[data-session-tab-rename]')
    await expect(field2).toBeFocused()
    await page.waitForTimeout(800)
    await expect(field2).toBeFocused()
    await field2.fill('gamma renamed')
    await field2.press('Enter')
    await expect.poll(() => storedName('t155-c')).toBe('gamma renamed')
    expect(await page.locator('[data-session-tab]').evaluateAll((els) => els.map((el) => el.getAttribute('data-session-tab')))).toEqual(ids)

    // 0444a98b: the sidebar rename (⌘R on the session on screen) — a drag selects letters, not the row
    await activateSession(page, 'alpha session')
    await page.locator('body').click({ position: { x: 700, y: 400 } })
    await page.keyboard.press('Meta+r')
    const sideField = page.locator('[data-session-item="t155-a"] input[type="text"]').first()
    await expect(sideField).toBeFocused({ timeout: 5000 })
    await sideField.evaluate((input: HTMLInputElement) => input.setSelectionRange(0, 0))
    const sideBox = (await sideField.boundingBox())!
    await page.mouse.move(sideBox.x + 3, sideBox.y + sideBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(sideBox.x + sideBox.width - 3, sideBox.y + sideBox.height / 2, { steps: 6 })
    await shot(page, 't155-2-sidebar-drag')
    await page.mouse.up()
    const sideSelected = await sideField.evaluate((input: HTMLInputElement) => (input.selectionEnd ?? 0) - (input.selectionStart ?? 0))
    expect(sideSelected).toBeGreaterThan(3)
    await sideField.press('Escape')
})

const LEAD = 't155-leada-4000-8000-000000000002'
const NAMES: Record<string, string> = {
    't155-chief-4000-8000-000000000001': 'AI: t155 chief',
    [LEAD]: 'AI: t155 lead A',
    't155-leadb-4000-8000-000000000003': 'AI: t155 lead B',
    't155-leadc-4000-8000-000000000004': 'AI: t155 lead C',
    't155-workr-4000-8000-000000000005': 'AI: t155 pricing worker'
}
const RELATIONS: SessionRelation[] = [
    { from: 't155-chief-4000-8000-000000000001', to: LEAD, kind: 'opened', at: 1 },
    { from: 't155-chief-4000-8000-000000000001', to: 't155-leadb-4000-8000-000000000003', kind: 'opened', at: 2 },
    { from: 't155-chief-4000-8000-000000000001', to: 't155-leadc-4000-8000-000000000004', kind: 'opened', at: 3 },
    { from: LEAD, to: 't155-workr-4000-8000-000000000005', kind: 'opened', at: 4 }
]

test('T155 4c2d2e9c: the Related dialog narrows its rows by name', async () => {
    ctx = await launchAppWithWorkspaces(
        [{ id: 'ws-t155r', name: 'T155 related', path: tempDir('climanager-t155r-ws-'), sessions: Object.keys(NAMES).map((id) => ({ id, name: NAMES[id] })) }],
        { config: { sessionRelations: RELATIONS }, env: { CLIMANAGER_HOME: tempDir('climanager-t155r-home-') } }
    )
    const { page } = ctx
    await resizeMainWindow(ctx.app, 1280, 800)
    await activateSession(page, NAMES[LEAD])
    await page.locator(`[data-related-button="${LEAD}"]`).click()
    const dialog = page.locator('[data-related-modal]')
    await expect(dialog.locator('[data-related-row]')).toHaveCount(4)
    const filter = dialog.locator('[data-related-name-filter]')
    await filter.fill('lead')
    const listed = (): Promise<string[]> => dialog.locator('[data-related-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-related-row') ?? '').sort())
    await expect.poll(listed).toEqual(['t155-leadb-4000-8000-000000000003', 't155-leadc-4000-8000-000000000004'])
    await shot(page, 't155-3-related-filter')
    // words in any order, any case
    await filter.fill('WORKER pricing')
    await expect.poll(listed).toEqual(['t155-workr-4000-8000-000000000005'])
    await filter.fill('nothing like this')
    await expect(dialog.locator('[data-related-row]')).toHaveCount(0)
    await expect(dialog.locator('[data-related-name-empty]')).toBeVisible()
    // Escape: the words first, then the dialog
    await page.keyboard.press('Escape')
    await expect(filter).toHaveValue('')
    await expect(dialog.locator('[data-related-row]')).toHaveCount(4)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
})
