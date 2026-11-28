import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'
import { HEADER_BUTTONS, headerButtonShown, withHeaderButton } from '../../src/shared/types'

/**
 * T207 — the header's Terminal | Chat is icons only, and each header button can be turned off (d5efaf86).
 *
 * Unit: headerButtonShown / withHeaderButton (an older store without the key shows everything; Source Control
 * reads its own `showSourceControl`). App: the toggle shows no words — its name and shortcut are in the tooltip
 * and aria-label; Settings › Sidebar › Header buttons lists every button but Settings; Related off → gone from the
 * header, config.json `hiddenHeaderButtons`, ⌘⇧L still opens the Related window; on again → back. Checklists
 * off → no chip, ⌘⇧J still opens the panel.
 *
 * T207_SHOTS=<dir> + T207_LABEL save the header (1280) and the settings card.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const LABEL = process.env.T207_LABEL ?? 'after'
const CLAUDE_ID = '00000000-0000-4000-8000-0000000c2071'

test.describe('T207 unit', () => {
    test('headerButtonShown / withHeaderButton', () => {
        const none: { hiddenHeaderButtons?: string[]; showSourceControl?: boolean } = {}
        for (const button of HEADER_BUTTONS) expect(headerButtonShown({}, button.id), button.id).toBe(true)
        expect(HEADER_BUTTONS.map((button) => button.label)).not.toContain('Settings')
        const off = withHeaderButton(none, 'related', false)
        expect(off.hiddenHeaderButtons).toEqual(['related'])
        expect(headerButtonShown(off, 'related')).toBe(false)
        expect(headerButtonShown(off, 'loop')).toBe(true)
        expect(withHeaderButton(off, 'related', true).hiddenHeaderButtons).toEqual([])
        expect(withHeaderButton(withHeaderButton(off, 'related', false), 'related', false).hiddenHeaderButtons, 'not twice').toEqual(['related'])
        // Source Control keeps its old key
        expect(withHeaderButton(none, 'sourceControl', false)).toEqual({ showSourceControl: false })
        expect(headerButtonShown({ showSourceControl: false }, 'sourceControl')).toBe(false)
        // a broken stored value shows everything
        expect(headerButtonShown({ hiddenHeaderButtons: 'related' as unknown as string[] }, 'related')).toBe(true)
    })
})

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (!result) return
    const done = result
    result = null
    const closed = await Promise.race([closeApp(done).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000))])
    if (!closed) {
        done.app.process().kill('SIGKILL')
        fs.rmSync(done.userDataDir, { recursive: true, force: true })
    }
})

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
    const dir = process.env.T207_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`), ...(clip ? { clip } : {}) })
}

const readSettings = (dir: string): { hiddenHeaderButtons?: string[] } =>
    (JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as { settings: { hiddenHeaderButtons?: string[] } }).settings

test('T207 app: icon-only toggle; Related and Checklists turned off leave the header, their shortcuts still open them', async () => {
    test.setTimeout(180_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t207-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', 'x', `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t207',
                name: 'T207 project',
                path: project,
                sessions: [{ id: 't207-claude', name: 'T207 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript}` }]
            }
        ],
        { settings: { showHomeWorkspace: false }, env: { CLAUDE_CONFIG_DIR: claudeDir } }
    )
    const { app, page, userDataDir } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, 't207-claude', 'Claude Code (mock)', 20_000)
    await page.getByText('T207 Claude', { exact: true }).first().click()
    await page.waitForTimeout(400)
    const header = { x: 0, y: 0, width: 1280, height: 56 }

    // Terminal | Chat: icons, no words; the name and the shortcut in the tooltip
    const toggle = page.getByTestId('view-toggle')
    await expect(toggle).toBeVisible({ timeout: 15_000 })
    await shot(page, 'header', header)
    expect((await toggle.innerText()).trim(), 'no words on the toggle').toBe('')
    for (const [id, name] of [['view-toggle-terminal', 'Terminal'], ['view-toggle-chat', 'Chat']]) {
        const button = page.getByTestId(id)
        await expect(button).toHaveAttribute('aria-label', name)
        expect(await button.getAttribute('title')).toMatch(new RegExp(`^${name} \\((⌘⇧M|Ctrl\\+Shift\\+M)\\)$`))
        await expect(button.locator('svg')).toHaveCount(1)
    }

    // Settings › Sidebar › Header buttons: every button but Settings, all on
    await page.locator('button[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-sidebar').click()
    const card = page.getByTestId('settings-header-buttons')
    await card.scrollIntoViewIfNeeded()
    const switches = card.locator('[data-header-button]')
    expect(await switches.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-header-button')))).toEqual(HEADER_BUTTONS.map((button) => button.id))
    expect(await switches.evaluateAll((rows) => rows.every((row) => row.getAttribute('aria-checked') === 'true'))).toBe(true)
    await expect(card.getByText('Settings', { exact: true })).toHaveCount(0)
    if (process.env.T207_SHOTS) {
        fs.mkdirSync(process.env.T207_SHOTS, { recursive: true })
        await card.screenshot({ path: path.join(process.env.T207_SHOTS, `settings-${LABEL}.png`) })
    }

    // Related and Checklists off → Save → gone from the header and kept in config.json
    await card.locator('[data-header-button="related"]').click()
    await card.locator('[data-header-button="checklists"]').click()
    await expect(card.locator('[data-header-button="related"]')).toHaveAttribute('aria-checked', 'false')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('[data-related-button]')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByTestId('checklist-chip')).toBeHidden()
    await expect(page.locator('button[title^="Settings"]').first()).toBeVisible()
    await expect(page.locator('button[title="Review Diff"]')).toHaveCount(1)
    await shot(page, 'header-off', header)
    await expect.poll(() => readSettings(userDataDir).hiddenHeaderButtons?.slice().sort()).toEqual(['checklists', 'related'])

    // their shortcuts still work
    await page.keyboard.press('Meta+Shift+L')
    await expect(page.locator('[data-related-modal]')).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Meta+Shift+L')
    await expect(page.locator('[data-related-modal]')).toBeHidden()
    await page.keyboard.press('Meta+Shift+J')
    await expect(page.getByTestId('checklist-panel')).toBeVisible({ timeout: 10_000 })
    const panel = (await page.getByTestId('checklist-panel').boundingBox())!
    expect(panel.x + panel.width, 'the panel stays in the window').toBeLessThanOrEqual(1280)
    await page.keyboard.press('Escape')

    // on again → back
    await page.locator('button[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-sidebar').click()
    await page.getByTestId('settings-header-buttons').locator('[data-header-button="related"]').click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('[data-related-button]')).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(() => readSettings(userDataDir).hiddenHeaderButtons).toEqual(['checklists'])
})
