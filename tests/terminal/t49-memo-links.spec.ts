import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, LaunchResult } from './helpers'

/**
 * T49 — memo links.
 *
 * A memo that is not being edited is shown as text with its URLs shortened and
 * clickable; clicking anywhere else returns to the textarea. The click is judged
 * at the far end (shell.openExternal in the main process, stubbed) and the saved
 * memo is read from config.json — the stored text must stay exactly what was typed.
 */

const LONG_URL = 'https://docs.example.com/guides/getting-started/advanced/the-final-page-name?tab=2'
const MEMO = `T49 read ${LONG_URL} then file:///etc/passwd stays text`

const savedMemo = (userDataDir: string, sessionId: string): string | undefined => {
    const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
    for (const workspace of config.workspaces) {
        const found = workspace.sessions.find((s: { id: string }) => s.id === sessionId)
        if (found) return found.memo
    }
    return undefined
}

test.describe('T49 memo links', () => {
    let ctx: LaunchResult
    test.afterEach(async () => { if (ctx) await closeApp(ctx) })

    test('links are short and clickable while reading, anywhere else edits, stored text is untouched', async () => {
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-memo', name: 'T49WS', sessions: [{ id: 's-memo', name: 'T49SESS', memo: MEMO }] }
        ], { settings: { showHomeWorkspace: false } })
        const { app, page, userDataDir } = ctx
        await activateSession(page, 'T49SESS')

        const opened = () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
        await app.evaluate(({ shell }) => {
            const urls: string[] = []
            ;(globalThis as unknown as { __opened: string[] }).__opened = urls
            shell.openExternal = async (url: string) => { urls.push(url) }
        })

        // Opening the memo is for typing: the textarea is up and holds the stored text.
        await page.locator('button[title="Session Memo (⌘J)"]:visible').click()
        const textarea = page.locator('textarea[placeholder="Quick notes..."]')
        await expect(textarea).toBeFocused()
        await expect(textarea).toHaveValue(MEMO)

        // Focus leaves the textarea: the reading view takes over.
        await page.getByText('Memo', { exact: true }).click()
        const read = page.getByTestId('session-memo-read')
        await expect(read).toBeVisible()
        await expect(textarea).toHaveCount(0)

        const link = read.locator('a[data-memo-link]')
        await expect(link).toHaveCount(1)
        const shown = (await link.textContent()) ?? ''
        expect(shown).toBe('docs.example.com/…/the-final-page-name')
        expect(shown.length).toBeLessThanOrEqual(40)
        await expect(link).toHaveAttribute('title', LONG_URL)
        // Only the web link is a link; the file: address is plain text.
        await expect(read).toContainText('file:///etc/passwd')

        // Clicking the link opens it outside and does not start editing.
        await link.click()
        await expect.poll(opened).toEqual([LONG_URL])
        await expect(read).toBeVisible()

        // Anywhere else in the text goes back to editing, with the stored text.
        await read.getByText('T49 read', { exact: false }).click({ position: { x: 4, y: 4 } })
        await expect(textarea).toBeFocused()
        await expect(textarea).toHaveValue(MEMO)

        // What is typed is saved as typed — no link markup in the stored memo.
        await page.keyboard.type('!')
        await expect.poll(() => savedMemo(userDataDir, 's-memo')).toBe(`${MEMO}!`)
        expect(await opened()).toEqual([LONG_URL])
    })

    test('selecting text keeps the reading view, and Enter on a link only opens it', async () => {
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-memo', name: 'T49WS', sessions: [{ id: 's-memo', name: 'T49SESS', memo: MEMO }] }
        ], { settings: { showHomeWorkspace: false } })
        const { app, page } = ctx
        await activateSession(page, 'T49SESS')
        const opened = () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
        await app.evaluate(({ shell }) => {
            const urls: string[] = []
            ;(globalThis as unknown as { __opened: string[] }).__opened = urls
            shell.openExternal = async (url: string) => { urls.push(url) }
        })

        await page.locator('button[title="Session Memo (⌘J)"]:visible').click()
        await page.getByText('Memo', { exact: true }).click()
        const read = page.getByTestId('session-memo-read')
        const textarea = page.locator('textarea[placeholder="Quick notes..."]')
        await expect(read).toBeVisible()

        // Dragging over the text selects it; the click that ends the drag must not swap in the textarea.
        const box = await read.boundingBox()
        expect(box).not.toBeNull()
        await page.mouse.move(box!.x + 14, box!.y + 14)
        await page.mouse.down()
        await page.mouse.move(box!.x + 90, box!.y + 14, { steps: 6 })
        await page.mouse.up()
        expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0)
        await expect(read).toBeVisible()
        await expect(textarea).toHaveCount(0)

        // Enter on a focused link opens the link and stays in the reading view.
        await read.locator('a[data-memo-link]').focus()
        await page.keyboard.press('Enter')
        await expect.poll(opened).toEqual([LONG_URL])
        await expect(read).toBeVisible()
        await expect(textarea).toHaveCount(0)
    })

    test('an empty memo stays a textarea', async () => {
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-empty', name: 'T49EMPTY', sessions: [{ id: 's-empty', name: 'T49EMPTYSESS' }] }
        ], { settings: { showHomeWorkspace: false } })
        const { page } = ctx
        await activateSession(page, 'T49EMPTYSESS')

        await page.locator('button[title="Session Memo (⌘J)"]:visible').click()
        const textarea = page.locator('textarea[placeholder="Quick notes..."]')
        await expect(textarea).toBeFocused()
        await page.getByText('Memo', { exact: true }).click()
        // Nothing to read yet: still the textarea, not an empty reading box.
        await expect(textarea).toBeVisible()
        await expect(page.getByTestId('session-memo-read')).toHaveCount(0)
        // Nothing to copy either.
        await expect(page.getByTestId('session-memo-copy')).toBeDisabled()
    })

    test('the copy button puts the whole memo on the clipboard and keeps the textarea (533a22ba)', async () => {
        const memo = `T49 copy line one\nline two with ${LONG_URL}`
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-copy', name: 'T49COPY', sessions: [{ id: 's-copy', name: 'T49COPYSESS', memo }] }
        ], { settings: { showHomeWorkspace: false } })
        const { app, page } = ctx
        await activateSession(page, 'T49COPYSESS')

        // The clipboard is the machine's, not the test's: put back what was there.
        const savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
        const readClipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())
        try {
            await app.evaluate(({ clipboard }) => clipboard.writeText('T49-BEFORE'))
            await page.locator('button[title="Session Memo (⌘J)"]:visible').click()
            const textarea = page.locator('textarea[placeholder="Quick notes..."]')
            await expect(textarea).toBeFocused()

            const copy = page.getByTestId('session-memo-copy')
            await copy.click()
            // The whole memo, line breaks and the full URL included — not the shortened link text.
            await expect.poll(readClipboard).toBe(memo)
            await expect(copy).toHaveAttribute('title', 'Copied')
            // Copying is not "done editing": the textarea keeps focus and the caret stays put.
            await expect(textarea).toBeFocused()
            await expect(page.getByTestId('session-memo-read')).toHaveCount(0)
            await expect(copy).toHaveAttribute('title', /^Copy memo/, { timeout: 5_000 })

            // From the reading view too, and it stays the reading view.
            await page.getByText('Memo', { exact: true }).click()
            const read = page.getByTestId('session-memo-read')
            await expect(read).toBeVisible()
            await app.evaluate(({ clipboard }) => clipboard.writeText('T49-BEFORE'))
            await copy.click()
            await expect.poll(readClipboard).toBe(memo)
            await expect(read).toBeVisible()
        } finally {
            await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard)
        }
    })
})
