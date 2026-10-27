import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, LaunchResult } from './helpers'

/**
 * T62 — memo page shortcuts (day-1027: 「메모쪽 단축키 전부 필요함」).
 *
 * Every memo header button has a shortcut: new page ⌥⌘N, previous ⌥⌘←, next
 * ⌥⌘→, delete ⌥⌘⌫ (twice when the page has text, like the button) and copy
 * ⌥⌘C. They open a closed memo first and work while typing in it. A binding
 * changed in Settings › Keyboard replaces the default. Pages are read back from
 * config.json and the clipboard from main, not from the screen alone.
 */

type StoredSession = { id: string; memo?: string; memoPages?: string[] }

const storedSession = (userDataDir: string, sessionId: string): StoredSession | undefined => {
    const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
    for (const workspace of config.workspaces) {
        const found = workspace.sessions.find((s: StoredSession) => s.id === sessionId)
        if (found) return found
    }
    return undefined
}

const textarea = (page: Page) => page.locator('textarea[placeholder="Quick notes..."]')
const pageLabel = (page: Page) => page.getByTestId('session-memo-page')

test.describe('T62 memo shortcuts', () => {
    let ctx: LaunchResult | undefined
    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
    })

    test('the default keys add, turn, copy and delete pages, opening the memo first', async () => {
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-keys', name: 'T62WS', sessions: [{ id: 's-keys', name: 'T62SESS', memo: 'T62 page one' }] }
        ], { settings: { showHomeWorkspace: false } })
        const { app, page, userDataDir } = ctx
        await activateSession(page, 'T62SESS')
        await expect(textarea(page)).toHaveCount(0)

        // New page from the terminal: the memo opens on an empty page 2, ready for typing.
        await page.keyboard.press('Alt+Meta+KeyN')
        await expect(pageLabel(page)).toHaveText('2 / 2')
        await expect(textarea(page)).toHaveValue('')
        await expect(textarea(page)).toBeFocused()
        await textarea(page).pressSequentially('T62 page two')
        await expect.poll(() => storedSession(userDataDir, 's-keys')).toMatchObject({ memo: 'T62 page one', memoPages: ['T62 page two'] })

        // Turning works while typing in the memo, and wraps like the buttons.
        await page.keyboard.press('Alt+Meta+ArrowLeft')
        await expect(pageLabel(page)).toHaveText('1 / 2')
        await expect(textarea(page)).toHaveValue('T62 page one')
        await page.keyboard.press('Alt+Meta+ArrowLeft')
        await expect(pageLabel(page)).toHaveText('2 / 2')
        await page.keyboard.press('Alt+Meta+ArrowRight')
        await expect(pageLabel(page)).toHaveText('1 / 2')
        await page.keyboard.press('Alt+Meta+ArrowRight')
        await expect(pageLabel(page)).toHaveText('2 / 2')

        // Copy takes the page on screen.
        const savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
        try {
            await app.evaluate(({ clipboard }) => clipboard.writeText('T62 before copy'))
            await page.keyboard.press('Alt+Meta+KeyC')
            await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('T62 page two')
        } finally {
            await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard)
        }

        // Delete from a closed memo: it opens and asks for a second press, since the page has text.
        await page.keyboard.press('Escape')
        await expect(textarea(page)).toHaveCount(0)
        await page.keyboard.press('Alt+Meta+Backspace')
        await expect(page.getByTestId('session-memo-delete-page')).toHaveAttribute('data-state', 'confirm')
        await expect(pageLabel(page)).toHaveText('2 / 2')
        await page.keyboard.press('Alt+Meta+Backspace')
        await expect(page.getByTestId('session-memo-pager')).toHaveCount(0)
        await expect(textarea(page)).toHaveValue('T62 page one')
        await expect.poll(() => storedSession(userDataDir, 's-keys')?.memoPages ?? []).toEqual([])

        // With one page left the delete button is gone, so the key does nothing (it would blank the memo).
        await page.keyboard.press('Alt+Meta+Backspace')
        await page.keyboard.press('Alt+Meta+Backspace')
        await expect(textarea(page)).toHaveValue('T62 page one')
        await page.waitForTimeout(800) // past the save debounce
        expect(storedSession(userDataDir, 's-keys')?.memo).toBe('T62 page one')
    })

    test('a binding changed in Settings replaces the default key', async () => {
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-custom', name: 'T62CWS', sessions: [{ id: 's-custom', name: 'T62CUSTOM', memo: 'T62 custom' }] }
        ], {
            settings: {
                showHomeWorkspace: false,
                keyboard: {
                    scrollShortcuts: true,
                    showScrollButtons: true,
                    shortcuts: { memoNewPage: { key: 'M', modifiers: ['mod', 'shift'], code: 'm' } }
                }
            }
        })
        const { page } = ctx
        await activateSession(page, 'T62CUSTOM')

        await page.keyboard.press('Alt+Meta+KeyN')
        await page.waitForTimeout(500)
        await expect(textarea(page)).toHaveCount(0)

        await page.keyboard.press('Meta+Shift+KeyM')
        await expect(pageLabel(page)).toHaveText('2 / 2')
    })
})
