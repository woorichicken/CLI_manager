import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, resizeMainWindow, LaunchResult } from './helpers'

/**
 * T72 — two reports of fb-1031.
 *
 * - 88d69c82: a session folder's right-click menu copies the folder name and the IDs of the
 *   sessions in it — one per line, in the order the list shows them (as Copy IDs does). An empty
 *   folder's Copy Session IDs is disabled.
 * - 386b0c76: a button that has a keyboard shortcut names it in its tooltip ("New page (⌥⌘N)"),
 *   and a binding changed in Settings › Keyboard shows the new key, not the default.
 *
 * Judged from the clipboard in main and the buttons' `title`. `T72_SHOTS=<dir>` leaves the folder
 * menu capture and the tooltips as `titles.json` there — written before the checks, so the old code
 * leaves its "before" in the same run.
 */

const SHOTS = process.env.T72_SHOTS
const A1 = 't72-a1-00000-4000-8000-000000000001'
const A2 = 't72-a2-00000-4000-8000-000000000002'
const A3 = 't72-a3-00000-4000-8000-000000000003'
const LOOSE = 't72-loose-00-4000-8000-000000000004'

async function saveShot(page: Page, name: string): Promise<void> {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

test.describe('T72 folder copy and shortcut hints (fb-1031)', () => {
    let ctx: LaunchResult | undefined

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
    })

    test('a session folder menu copies its name and its sessions\' IDs in list order; empty folder disabled (88d69c82)', async () => {
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-t72', name: 'T72WS', sessions: [
                { id: A1, name: 'T72 one', sessionFolderId: 'sf-t72' },
                { id: A2, name: 'T72 two', sessionFolderId: 'sf-t72' },
                { id: A3, name: 'T72 three', sessionFolderId: 'sf-t72' },
                { id: LOOSE, name: 'T72 loose' }
            ] }
        ], {
            settings: { showHomeWorkspace: false },
            config: { sessionFolders: [
                { id: 'sf-t72', name: 'T72 folder', isExpanded: true, createdAt: 1 },
                { id: 'sf-empty', name: 'T72 empty', isExpanded: true, createdAt: 2 }
            ] }
        })
        const { app, page } = ctx
        await resizeMainWindow(app, 1280, 800)
        const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
        const readClipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())
        const folderMenu = page.locator('[data-sidebar-menu="folder"]')

        try {
            await page.locator(`[data-session-item="${LOOSE}"]`).first().click()
            await page.getByTestId('sidebar-view-toggle').click()
            await page.getByTestId('all-sessions-layout-list').click()
            const header = page.getByTestId('session-folder-header-sf-t72')
            await expect(header).toBeVisible()
            // The order the folder shows its rows in is the order to copy.
            const shown = await page.locator('[data-session-folder-body="sf-t72"] [data-session-item]')
                .evaluateAll(rows => rows.map(r => r.getAttribute('data-session-item')))
            expect([...shown].sort()).toEqual([A1, A2, A3].sort())

            await header.click({ button: 'right' })
            await expect(folderMenu).toBeVisible()
            await saveShot(page, 'folder-menu-1280')
            await expect(page.getByTestId('folder-menu-copy-ids')).toBeEnabled()

            await app.evaluate(({ clipboard }) => clipboard.writeText('T72 before copy'))
            await page.getByTestId('folder-menu-copy-ids').click()
            await expect.poll(readClipboard).toBe(shown.join('\n'))
            await expect(folderMenu).toHaveCount(0)
            await expect(page.getByTestId('sidebar-copy-notice')).toContainText('Copied 3 session IDs')

            await header.click({ button: 'right' })
            await page.getByTestId('folder-menu-copy-name').click()
            await expect.poll(readClipboard).toBe('T72 folder')

            await page.getByTestId('session-folder-header-sf-empty').click({ button: 'right' })
            await expect(page.getByTestId('folder-menu-copy-ids')).toBeDisabled()
            await page.keyboard.press('Escape')
            await expect(folderMenu).toHaveCount(0)
        } finally {
            await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
        }
    })

    test('buttons name their shortcut on hover, following a binding changed in Settings (386b0c76)', async () => {
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-hint', name: 'T72HWS', sessions: [{ id: 's-hint', name: 'T72HINT', memo: 'T72 memo' }] }
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
        const { app, page } = ctx
        await resizeMainWindow(app, 1280, 800)
        await page.locator('[data-session-item="s-hint"]').first().getByText('T72HINT', { exact: true }).click()
        await page.locator('button[title^="Session Memo"]:visible').click()
        await expect(page.getByTestId('session-memo-new-page')).toBeVisible()

        const titleOf = (selector: string) => page.locator(selector).first().getAttribute('title')
        const titles = {
            settings: await titleOf('button[title^="Settings"]'),
            closeSidebar: await titleOf('button[title^="Close Sidebar"]'),
            related: await titleOf('[data-related-button="s-hint"]'),
            memo: await titleOf('button[title^="Session Memo"]:visible'),
            memoNewPage: await page.getByTestId('session-memo-new-page').getAttribute('title'),
            memoCopy: await page.getByTestId('session-memo-copy').getAttribute('title')
        }
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true })
            fs.writeFileSync(path.join(SHOTS, 'titles.json'), JSON.stringify(titles, null, 2))
            // The OS draws title tooltips outside the page, so a capture never has them: label each
            // button with its own title text, in the page, for the before/after review only.
            await page.evaluate(() => {
                const picks = [
                    ...Array.from(document.querySelectorAll('button[title^="Settings"], [data-related-button], button[title^="Close Sidebar"]')),
                    ...Array.from(document.querySelectorAll('[data-testid="session-memo-new-page"], [data-testid="session-memo-copy"]'))
                ] as HTMLElement[]
                picks.filter(el => el.offsetParent).forEach((el, i) => {
                    const box = el.getBoundingClientRect()
                    const tip = document.createElement('div')
                    tip.textContent = el.getAttribute('title') ?? ''
                    tip.setAttribute('data-t72-tip', '')
                    Object.assign(tip.style, {
                        position: 'fixed', zIndex: '9999', left: `${Math.max(4, Math.min(box.left, window.innerWidth - 330))}px`,
                        top: `${box.bottom + 6 + (i % 2) * 26}px`, background: '#f5f5f5', color: '#111', font: '12px -apple-system, sans-serif',
                        padding: '3px 7px', borderRadius: '4px', border: '1px solid #999', boxShadow: '0 2px 6px rgba(0,0,0,.4)', whiteSpace: 'nowrap'
                    })
                    document.body.appendChild(tip)
                })
            })
            await saveShot(page, 'tooltips-1280')
            await page.evaluate(() => document.querySelectorAll('[data-t72-tip]').forEach(el => el.remove()))
        }

        expect(titles.settings).toBe('Settings (⌘,)')
        expect(titles.closeSidebar).toBe('Close Sidebar (⌘B)')
        expect(titles.related).toBe('Related sessions — none yet. Open to add one. (⌘⇧L)')
        expect(titles.memo).toBe('Session Memo (⌘J)')
        // Remapped in Settings: the tooltip shows the new key, never the default ⌥⌘N.
        expect(titles.memoNewPage).toBe('New page (⌘⇧M)')
        expect(titles.memoCopy).toBe('Copy memo (⌥⌘C)')
    })
})
