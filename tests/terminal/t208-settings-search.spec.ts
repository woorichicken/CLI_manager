import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, type LaunchResult } from './helpers'
import { SETTINGS_INDEX, searchSettings } from '../../src/renderer/src/components/settingsIndex'

/**
 * T208 — a search over the Settings list, like Apple's System Settings (74c893e6).
 *
 * Unit: searchSettings — every word, any case, at the start of a word («tree» is Show Session Tree, not
 * Worktrees); the tabs in the list's order. App: «dictation» leaves only Chat with its setting under it, Enter
 * opens Chat scrolled to «Keep dictation log» and lights it; «tree» → Sidebar; a word nothing has → «No
 * settings match»; Esc empties the box and the full list is back; ⌘F focuses the box. And the index stays true:
 * every title in SETTINGS_INDEX is on screen in its tab (a renamed setting fails here, not in the search).
 *
 * T208_SHOTS=<dir> + T208_LABEL save the search in use.
 */

const LABEL = process.env.T208_LABEL ?? 'after'
const ORDER = [
    { id: 'general', label: 'General' },
    { id: 'keyboard', label: 'Keyboard' },
    { id: 'sidebar', label: 'Sidebar' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'chat', label: 'Chat' },
    { id: 'templates', label: 'Templates' },
    { id: 'agents', label: 'Agents' },
    { id: 'phone', label: 'Phone' },
    { id: 'git', label: 'Git (Local)' },
    { id: 'github', label: 'GitHub' },
    { id: 'port-monitoring', label: 'Port Monitoring' },
    { id: 'loop', label: 'Loop' },
    { id: 'editor', label: 'Editor' }
] as const

test.describe('T208 unit', () => {
    test('searchSettings: all words, any case, word starts; tabs in order', () => {
        const order = ORDER.map((item) => ({ ...item }))
        const tabs = (query: string): string[] | null => searchSettings(query, order)?.map((group) => group.category) ?? null
        expect(tabs('')).toBeNull()
        expect(tabs('   ')).toBeNull()
        expect(tabs('dictation')).toEqual(['chat'])
        expect(searchSettings('DICTATION', order)![0].matches.map((entry) => entry.title)).toEqual(['Keep dictation log', 'Also keep audio'])
        expect(tabs('tree')).toEqual(['sidebar'])
        expect(searchSettings('tree', order)![0].matches.map((entry) => entry.title)).toEqual(['Show Session Tree'])
        expect(tabs('worktree')).toEqual(['sidebar', 'git'])
        expect(tabs('session tree')).toEqual(['sidebar'])
        expect(tabs('tree dictation')).toEqual([])
        expect(tabs('zzzz')).toEqual([])
        // a tab's own name finds its settings
        expect(tabs('loop')).toContain('loop')
    })
})

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (!result) return
    const done = result
    result = null
    await closeApp(done)
})

async function shot(page: Page, modal: Locator, name: string): Promise<void> {
    const dir = process.env.T208_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(300)
    await modal.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

test('T208 app: dictation → Chat, scrolled and lit; tree → Sidebar; no match; Esc; ⌘F; every indexed title is drawn', async () => {
    test.setTimeout(180_000)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t208-'))
    result = await launchAppWithWorkspaces([{ id: 'ws-a', name: 'T208WS', path: dir, sessions: [{ id: 's-a', name: 'T208SESS' }] }])
    const { page } = result
    await page.setViewportSize({ width: 1500, height: 950 })
    await expect(page.getByText('T208WS', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await page.locator('button[title^="Settings"]').first().click()
    const modal = page.locator('.w-\\[800px\\]')
    await expect(modal).toBeVisible()
    const search = modal.getByTestId('settings-search')
    const content = modal.locator('.flex-1.overflow-y-auto.p-6')
    const listed = (): Promise<string[]> =>
        modal.locator('[data-testid^="settings-category-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!.replace('settings-category-', '')))

    // ⌘F focuses the box
    await content.click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Meta+f')
    await expect(search).toBeFocused()
    // with a Korean input source the same key says 'ㄹ' — the physical key (code KeyF) still focuses the box
    await content.click({ position: { x: 5, y: 5 } })
    await expect(search).not.toBeFocused()
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ㄹ', code: 'KeyF', metaKey: true, bubbles: true, cancelable: true })))
    await expect(search).toBeFocused()

    // «dictation»: Chat alone, its setting under it; Enter opens it there and lights it
    await page.keyboard.type('dictation')
    await expect.poll(listed).toEqual(['chat'])
    await expect(modal.getByTestId('settings-search-match').first()).toHaveText('Keep dictation log')
    await shot(page, modal, 'search')
    await page.keyboard.press('Enter')
    await expect(modal.getByTestId('settings-category-chat')).toHaveClass(/bg-blue-600/)
    const lit = content.locator('[data-settings-found="true"]')
    await expect(lit).toHaveCount(1, { timeout: 5_000 })
    // measured at once: the light goes after a moment
    const found = await lit.evaluate((el) => ({ text: el.textContent ?? '', top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }))
    const box = (await content.boundingBox())!
    expect(found.text).toContain('Keep dictation log')
    // it is in view inside the scrolled content
    expect(found.top).toBeGreaterThanOrEqual(box.y)
    expect(found.bottom).toBeLessThanOrEqual(box.y + box.height)
    expect(await content.evaluate((el) => el.scrollTop), 'it scrolled to it').toBeGreaterThan(0)
    await shot(page, modal, 'found')

    // «tree» → Sidebar; a click on the match opens it there
    await search.fill('tree')
    await expect.poll(listed).toEqual(['sidebar'])
    await modal.getByTestId('settings-search-match').first().click()
    await expect.poll(() => content.locator('[data-settings-found="true"]').evaluateAll((els) => els.map((el) => el.textContent ?? '').join('|'))).toContain('Show Session Tree')

    // nothing matches
    await search.fill('zzqx')
    await expect(modal.getByTestId('settings-search-empty')).toHaveText('No settings match')
    expect(await listed()).toEqual([])

    // Esc empties the box: the full grouped list again; Settings stays open
    await search.press('Escape')
    await expect(search).toHaveValue('')
    await expect(modal.locator('[data-settings-group]')).toHaveCount(4)
    expect(await listed()).toEqual(['general', 'keyboard', 'sidebar', 'terminal', 'chat', 'templates', 'agents', 'phone', 'git', 'github', 'port-monitoring', 'loop', 'editor'])
    await expect(modal).toBeVisible()

    // the index stays true: every title is drawn in its tab
    const missing: string[] = []
    for (const category of new Set(SETTINGS_INDEX.map((entry) => entry.category))) {
        await modal.getByTestId(`settings-category-${category}`).click()
        await page.waitForTimeout(300)
        for (const entry of SETTINGS_INDEX.filter((item) => item.category === category)) {
            const drawn = await content.evaluate(
                (el, title) => Array.from(el.querySelectorAll('h3, h4, p, label, span')).some((node) => node.textContent?.trim() === title),
                entry.title
            )
            if (!drawn) missing.push(`${category}: ${entry.title}`)
        }
    }
    expect(missing).toEqual([])
})
