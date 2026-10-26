import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, LaunchResult } from './helpers'

/**
 * T56 — memo pages (report 533a22ba).
 *
 * The memo used to be one sheet the user split with "--------" lines. It now
 * has pages: a new page, ‹ › to turn them (wrapping round), "n / N", delete a
 * page, and copy takes the page on screen. Page 1 stays in `memo` — the only
 * field older builds read — and the rest go to `memoPages`; both are read back
 * from config.json, not from the screen.
 */

const OLD_SHEET = 'T56 first note\n--------\nT56 second note on the same sheet'

type StoredSession = { id: string; memo?: string; memoPages?: string[] }

const storedSession = (userDataDir: string, sessionId: string): StoredSession | undefined => {
    const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
    for (const workspace of config.workspaces) {
        const found = workspace.sessions.find((s: StoredSession) => s.id === sessionId)
        if (found) return found
    }
    return undefined
}

test.describe('T56 memo pages', () => {
    let ctx: LaunchResult | undefined
    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
    })

    test('a one-sheet memo becomes page 1 as is, and pages can be added, turned, copied and deleted', async () => {
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-pages', name: 'T56WS', sessions: [{ id: 's-pages', name: 'T56SESS', memo: OLD_SHEET }] }
        ], { settings: { showHomeWorkspace: false } })
        const { app, page, userDataDir } = ctx
        await activateSession(page, 'T56SESS')

        await page.locator('button[title="Session Memo (⌘J)"]:visible').click()
        const textarea = page.locator('textarea[placeholder="Quick notes..."]')
        // The old sheet is one page: its "--------" line is text, not a page break.
        await expect(textarea).toHaveValue(OLD_SHEET)
        await expect(page.getByTestId('session-memo-pager')).toHaveCount(0)
        await expect(page.getByTestId('session-memo-delete-page')).toHaveCount(0)

        // A new page goes at the end, empty and ready for typing.
        await page.getByTestId('session-memo-new-page').click()
        await expect(page.getByTestId('session-memo-page')).toHaveText('2 / 2')
        await expect(textarea).toHaveValue('')
        await expect(textarea).toBeFocused()
        await textarea.pressSequentially('T56 page two')
        await expect.poll(() => storedSession(userDataDir, 's-pages')).toMatchObject({ memo: OLD_SHEET, memoPages: ['T56 page two'] })

        // ‹ goes back; › past the last page wraps round to the first.
        await page.getByTestId('session-memo-prev').click()
        await expect(page.getByTestId('session-memo-page')).toHaveText('1 / 2')
        await expect(textarea).toHaveValue(OLD_SHEET)
        await page.getByTestId('session-memo-next').click()
        await page.getByTestId('session-memo-next').click()
        await expect(page.getByTestId('session-memo-page')).toHaveText('1 / 2')
        await page.getByTestId('session-memo-prev').click()
        await expect(page.getByTestId('session-memo-page')).toHaveText('2 / 2')
        await expect(textarea).toHaveValue('T56 page two')

        // Copy takes the page on screen, not the whole memo.
        const savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
        try {
            await page.getByTestId('session-memo-copy').click()
            await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('T56 page two')
        } finally {
            await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard)
        }

        // Typing on page 1 changes page 1 only.
        await page.getByTestId('session-memo-prev').click()
        await textarea.press('End')
        await textarea.pressSequentially(' (edited)')
        await expect.poll(() => storedSession(userDataDir, 's-pages')).toMatchObject({
            memo: `${OLD_SHEET} (edited)`,
            memoPages: ['T56 page two']
        })

        // A page with text needs a second click to go; the page after it takes its place.
        await page.getByTestId('session-memo-next').click()
        const del = page.getByTestId('session-memo-delete-page')
        await del.click()
        await expect(del).toHaveAttribute('data-state', 'confirm')
        await expect(page.getByTestId('session-memo-page')).toHaveText('2 / 2')
        await del.click()
        await expect(page.getByTestId('session-memo-pager')).toHaveCount(0)
        await expect(textarea).toHaveValue(`${OLD_SHEET} (edited)`)
        await expect.poll(() => storedSession(userDataDir, 's-pages')?.memoPages).toBeUndefined()
        expect(storedSession(userDataDir, 's-pages')?.memo).toBe(`${OLD_SHEET} (edited)`)
    })

    test('stored pages open as pages, and a save that sends only page 1 (an older build) keeps the rest', async () => {
        ctx = await launchAppWithWorkspaces([
            {
                id: 'ws-stored', name: 'T56STORED', sessions: [{
                    id: 's-stored', name: 'T56STOREDSESS', memo: 'T56 page one', memoPages: ['T56 page two', 'T56 page three']
                }]
            }
        ], { settings: { showHomeWorkspace: false } })
        const { page, userDataDir } = ctx
        await activateSession(page, 'T56STOREDSESS')

        await page.locator('button[title="Session Memo (⌘J)"]:visible').click()
        const textarea = page.locator('textarea[placeholder="Quick notes..."]')
        await expect(page.getByTestId('session-memo-page')).toHaveText('1 / 3')
        await expect(textarea).toHaveValue('T56 page one')
        await page.getByTestId('session-memo-prev').click()
        await expect(page.getByTestId('session-memo-page')).toHaveText('3 / 3')
        await expect(textarea).toHaveValue('T56 page three')

        // 1.19.0 and earlier save the memo without pages: the later pages must survive that.
        await page.evaluate(() => window.api.updateSessionMemo('ws-stored', 's-stored', 'T56 page one, saved by an older build'))
        await expect.poll(() => storedSession(userDataDir, 's-stored')).toMatchObject({
            memo: 'T56 page one, saved by an older build',
            memoPages: ['T56 page two', 'T56 page three']
        })

        // An empty page is deleted at once — nothing to lose.
        await page.getByTestId('session-memo-new-page').click()
        await expect(page.getByTestId('session-memo-page')).toHaveText('4 / 4')
        await page.getByTestId('session-memo-delete-page').click()
        await expect(page.getByTestId('session-memo-page')).toHaveText('3 / 3')

        // An empty page keeps its textarea after focus leaves; typing into it again stays in the textarea.
        await page.getByTestId('session-memo-new-page').click()
        await page.getByText('Memo', { exact: true }).click()
        await expect(textarea).toHaveValue('')
        await textarea.click()
        await textarea.pressSequentially('ab')
        await expect(textarea).toHaveValue('ab')
        await expect(textarea).toBeFocused()
        await expect(page.getByTestId('session-memo-read')).toHaveCount(0)
    })
})
