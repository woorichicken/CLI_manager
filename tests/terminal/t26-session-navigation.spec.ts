import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, LaunchResult } from './helpers'

/**
 * T26 — tab navigation, closing and deleting must agree with the sidebar.
 *
 * The sidebar shows sessions in the order the user dragged them into, but the
 * terminal list underneath keeps creation order (reordering it would remount
 * terminals). Every path that picks "the next/previous tab" has to use the
 * sidebar's order, and has to see sessions that were added or deleted since
 * the workspace was last selected — otherwise Cmd+] jumps somewhere the user
 * cannot predict, or onto a deleted session and shows an empty screen.
 *
 * The signal is which terminal is actually visible, not React state: that is
 * what the user sees.
 */

/** Id of the single visible terminal, or a comma list / 'none' when that is not the case. */
const visibleSession = (page: Page): Promise<string> => page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-session-id]'))
        .filter((el) => getComputedStyle(el).visibility === 'visible')
        .map((el) => el.getAttribute('data-session-id'))
        .join(',') || 'none')

const sidebarOrder = (page: Page, ids: string[]): Promise<string[]> => page.evaluate((wanted) =>
    Array.from(document.querySelectorAll('[data-session-item]'))
        .map((el) => el.getAttribute('data-session-item') ?? '')
        .filter((id) => wanted.includes(id)), ids)

/** Drag a session row one row down by its handle — the user's reorder gesture. */
async function dragSessionDownOneRow(page: Page, sessionId: string, belowId: string): Promise<void> {
    const row = page.locator(`[data-session-item="${sessionId}"]`)
    await row.hover()
    const handle = row.getByTitle('Drag to reorder')
    const handleBox = (await handle.boundingBox())!
    const rowBox = (await row.boundingBox())!
    const belowBox = (await page.locator(`[data-session-item="${belowId}"]`).boundingBox())!
    const rowHeight = belowBox.y - rowBox.y
    const x = handleBox.x + handleBox.width / 2
    const y = handleBox.y + handleBox.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y + rowHeight, { steps: 12 })
    await page.mouse.up()
}

/** Which session holds the keyboard, by xterm's own focus class. */
const focusedSession = (page: Page): Promise<string> => page.evaluate(() =>
    Array.from(document.querySelectorAll('.xterm.focus'))
        .map((el) => el.closest('[data-session-id]')?.getAttribute('data-session-id') ?? '?')
        .join(',') || 'none')

/**
 * Put `sessionId` into split view next to the visible terminal: the sidebar row's
 * HTML5 drag, dropped on the terminal area. Synthetic events are enough here —
 * they only build the layout; what is under test is the keyboard afterwards.
 */
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

async function deleteFromSidebar(page: Page, sessionId: string): Promise<void> {
    const row = page.locator(`[data-session-item="${sessionId}"]`)
    await row.hover()
    await row.getByTitle('Delete session').click()
    await expect(row).toHaveCount(0, { timeout: 10_000 })
}

test.describe('T26 session navigation', () => {
    let ctx: LaunchResult
    const tempDirs: string[] = []

    const tempDir = (): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t26-'))
        tempDirs.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    const launchThree = async (): Promise<Page> => {
        // Plain directories: the startup worktree scan leaves them alone.
        ctx = await launchAppWithWorkspaces([
            {
                id: 'ws-a', name: 'T26WSA', path: tempDir(), sessions: [
                    { id: 's-1', name: 'T26ONE' },
                    { id: 's-2', name: 'T26TWO' },
                    { id: 's-3', name: 'T26THREE' }
                ]
            },
            { id: 'ws-b', name: 'T26WSB', path: tempDir(), sessions: [{ id: 's-b', name: 'T26BEE' }] }
        ])
        const { page } = ctx
        // Seeded workspaces start expanded — clicking the name would collapse it.
        await page.locator('[data-session-item="s-1"]').waitFor({ timeout: 10_000 })
        return page
    }

    test('Cmd+] and Cmd+[ follow the order the sidebar shows', async () => {
        const page = await launchThree()
        // Selected first, reordered after: selecting snapshots the workspace, so
        // this is the order that used to go stale.
        await activateSession(page, 'T26ONE')
        await expect.poll(() => visibleSession(page)).toBe('s-1')

        await dragSessionDownOneRow(page, 's-1', 's-2')
        await expect.poll(() => sidebarOrder(page, ['s-1', 's-2', 's-3'])).toEqual(['s-2', 's-1', 's-3'])

        await page.keyboard.press('Meta+BracketRight')
        await expect.poll(() => visibleSession(page)).toBe('s-3')
        await page.keyboard.press('Meta+BracketLeft')
        await page.keyboard.press('Meta+BracketLeft')
        await expect.poll(() => visibleSession(page)).toBe('s-2')
    })

    test('Cmd+] skips a session deleted from the sidebar', async () => {
        const page = await launchThree()
        await activateSession(page, 'T26ONE')
        await deleteFromSidebar(page, 's-2')

        await page.keyboard.press('Meta+BracketRight')
        await expect.poll(() => visibleSession(page)).toBe('s-3')
    })

    test('deleting the active session from the sidebar shows its neighbour, like Cmd+W', async () => {
        const page = await launchThree()
        await activateSession(page, 'T26TWO')
        await deleteFromSidebar(page, 's-2')
        await expect.poll(() => visibleSession(page)).toBe('s-1')
    })

    test('Cmd+W moves to the previous tab in sidebar order', async () => {
        const page = await launchThree()
        // Sidebar: 2, 3, 1 — the previous tab of 1 is 3; in creation order there is none before it.
        await dragSessionDownOneRow(page, 's-1', 's-2')
        await dragSessionDownOneRow(page, 's-1', 's-3')
        await expect.poll(() => sidebarOrder(page, ['s-1', 's-2', 's-3'])).toEqual(['s-2', 's-3', 's-1'])

        await activateSession(page, 'T26ONE')
        await page.keyboard.press('Meta+w')
        await expect(page.locator('[data-session-item="s-1"]')).toHaveCount(0, { timeout: 10_000 })
        await expect.poll(() => visibleSession(page)).toBe('s-3')
    })

    test('Cmd+Shift+] and Cmd+Shift+[ switch workspaces', async () => {
        const page = await launchThree()
        await activateSession(page, 'T26ONE')

        await page.keyboard.press('Meta+Shift+BracketRight')
        await expect.poll(() => visibleSession(page)).toBe('s-b')
        await page.keyboard.press('Meta+Shift+BracketLeft')
        await expect.poll(() => visibleSession(page)).toBe('s-1')
    })

    test('in split view Cmd+` moves the caret and Cmd+W closes the active pane', async () => {
        const page = await launchThree()
        await activateSession(page, 'T26ONE')
        await dropIntoSplit(page, 's-2')
        await expect.poll(() => visibleSession(page)).toBe('s-1,s-2')

        await page.locator('[data-session-id="s-1"] .xterm-helper-textarea').focus()
        await page.keyboard.press('Meta+Backquote')
        await expect.poll(() => focusedSession(page), { message: 'caret follows the active pane' }).toBe('s-2')

        await page.keyboard.press('Meta+w')
        await expect(page.locator('[data-session-item="s-2"]')).toHaveCount(0, { timeout: 10_000 })
        // One pane left: split view ends and that pane is the visible tab.
        await expect.poll(() => visibleSession(page)).toBe('s-1')
    })

    test('deleting a session shown in split view removes its pane', async () => {
        const page = await launchThree()
        await activateSession(page, 'T26ONE')
        await dropIntoSplit(page, 's-2')
        await dropIntoSplit(page, 's-3')
        await expect.poll(() => visibleSession(page)).toBe('s-1,s-2,s-3')

        await deleteFromSidebar(page, 's-2')
        await expect.poll(() => visibleSession(page)).toBe('s-1,s-3')
        // Two panes sit side by side. A stale id would keep the three-pane grid:
        // s-3 alone on the bottom row and an empty slot where s-2 was.
        const paneTop = (id: string): Promise<number> =>
            page.locator(`[data-session-id="${id}"]`).evaluate((el) => Math.round(el.getBoundingClientRect().top))
        await expect.poll(async () => (await paneTop('s-3')) - (await paneTop('s-1'))).toBe(0)
        await expect(page.getByText('T26TWO', { exact: true })).toHaveCount(0)
    })

    test('Cmd+Shift+] walks workspaces in sidebar order, pinned first', async () => {
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-a', name: 'T26WSA', path: tempDir(), sessions: [{ id: 's-1', name: 'T26ONE' }] },
            { id: 'ws-b', name: 'T26WSB', path: tempDir(), sessions: [{ id: 's-b', name: 'T26BEE' }] },
            { id: 'ws-c', name: 'T26WSC', path: tempDir(), sessions: [{ id: 's-c', name: 'T26SEE' }] }
        ])
        const { page } = ctx
        // Pinning B draws it above A: the sidebar reads B, A, C.
        await page.getByText('T26WSB', { exact: true }).first().click({ button: 'right' })
        await page.getByText('Pin to Top', { exact: true }).click()
        await page.getByText('Pinned', { exact: true }).waitFor({ timeout: 10_000 })

        await activateSession(page, 'T26ONE')
        await page.keyboard.press('Meta+Shift+BracketRight')
        await expect.poll(() => visibleSession(page)).toBe('s-c')
        // Upward from A is the pinned B — creation order would wrap to the playground instead.
        await page.keyboard.press('Meta+Shift+BracketLeft')
        await expect.poll(() => visibleSession(page)).toBe('s-1')
        await page.keyboard.press('Meta+Shift+BracketLeft')
        await expect.poll(() => visibleSession(page)).toBe('s-b')
    })

    /**
     * Whether the page swallowed the last Cmd+W. A keydown the page does not
     * prevent goes on to the app menu, whose Close Window owns Cmd+W — that is
     * the window-closing path. The native menu cannot be driven headless
     * (synthetic keys never reach NSMenu, checked with sendInputEvent too), so
     * the swallowed flag is the observable stand-in.
     */
    const watchCmdW = (page: Page): Promise<void> => page.evaluate(() => {
        const w = window as unknown as { __cmdW: boolean[] }
        w.__cmdW = []
        // Read once dispatch is over: the hook re-registers its listener when
        // state changes, so it may run after this one.
        window.addEventListener('keydown', (e) => {
            if (e.metaKey && e.code === 'KeyW') setTimeout(() => w.__cmdW.push(e.defaultPrevented), 0)
        }, true)
    })
    const cmdWSwallowed = (page: Page): Promise<boolean[]> =>
        page.evaluate(() => (window as unknown as { __cmdW: boolean[] }).__cmdW)

    test('Cmd+W while renaming closes the tab, not the window', async () => {
        const page = await launchThree()
        await activateSession(page, 'T26TWO')
        await watchCmdW(page)
        // Cmd+R opens the rename field: the focus is now a plain <input>.
        await page.keyboard.press('Meta+r')
        await expect(page.locator('[data-session-item="s-2"] input')).toBeFocused()

        await page.keyboard.press('Meta+w')
        await expect.poll(() => cmdWSwallowed(page), { message: 'Cmd+W must not reach the menu' }).toEqual([true])
        await expect(page.locator('[data-session-item="s-2"]')).toHaveCount(0, { timeout: 10_000 })
        await expect.poll(() => visibleSession(page)).toBe('s-1')
    })

    test('Cmd+W right after Cmd+T does not reach the menu', async () => {
        const page = await launchThree()
        await activateSession(page, 'T26TWO')
        await watchCmdW(page)
        // Inside the 500ms template window, Cmd+T's pending key used to let the next key through.
        // Cmd held throughout, as a hand does it: no fresh Meta keydown between T and W.
        await page.keyboard.down('Meta')
        await page.keyboard.press('t')
        await page.keyboard.press('w')
        await page.keyboard.up('Meta')
        await expect.poll(() => cmdWSwallowed(page)).toEqual([true])
    })
})
