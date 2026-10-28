import { test, expect, Page, Locator } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, LaunchResult, SeedWorkspace } from './helpers'

/**
 * T59 — drag a sidebar session row onto another to relate them (report 269168e4).
 *
 * The drop is the Related dialog's "Add by hand": the dragged session goes
 * under the one it was dropped on (9fa825e7) — below it in that session's
 * Related dialog, marked "by hand" — and a pair the user removed with × comes
 * back when the user drags it in again. A real mouse drag, judged in the DOM, the Related dialog
 * and config.json `sessionRelations`.
 */

type StoredRelation = { from: string; to: string; kind: string; dismissed?: boolean }

const storedRelations = (userDataDir: string): StoredRelation[] =>
    JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).sessionRelations ?? []
const pairOf = (userDataDir: string, a: string, b: string): StoredRelation | undefined =>
    storedRelations(userDataDir).find(r => (r.from === a && r.to === b) || (r.from === b && r.to === a))

async function dragRowOver(page: Page, sessionId: string, target: Locator): Promise<void> {
    const from = await page.locator(`[data-session-item="${sessionId}"]`).boundingBox()
    const to = await target.boundingBox()
    expect(from && to).toBeTruthy()
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
    await page.mouse.down()
    await page.mouse.move(from!.x + from!.width / 2 + 6, from!.y + from!.height / 2 + 6, { steps: 3 })
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 })
}

test.describe('T59 drag to relate', () => {
    let ctx: LaunchResult | undefined
    const dirs: string[] = []
    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const made of dirs.splice(0)) fs.rmSync(made, { recursive: true, force: true })
    })

    const seed = (): SeedWorkspace[] => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t59-'))
        dirs.push(folder)
        return [
            { id: 'ws-one', name: 'T59WSONE', path: folder, sessions: [{ id: 's-a1', name: 'T59A1' }, { id: 's-a2', name: 'T59A2' }] },
            { id: 'ws-two', name: 'T59WSTWO', path: folder, sessions: [{ id: 's-b1', name: 'T59B1' }] }
        ]
    }

    test('in All sessions a row dropped on another relates them; a pair removed with × comes back when dragged in', async () => {
        ctx = await launchAppWithWorkspaces(seed(), { settings: { showHomeWorkspace: false } })
        const { page, userDataDir } = ctx
        await page.getByTestId('sidebar-view-toggle').click()
        const list = page.getByTestId('sidebar-all-sessions')
        const target = list.locator('[data-session-item="s-a1"]')
        await expect(target).toBeVisible()

        await dragRowOver(page, 's-b1', target)
        await expect(page.locator('[data-session-relate-target="s-a1"]')).toBeVisible()
        await page.mouse.up()
        await expect(page.locator('[data-session-relate-target]')).toHaveCount(0)
        await expect(page.getByTestId('sidebar-drop-notice')).toHaveText('T59B1 is now under T59A1')
        // Stored "dropped on → dragged": the drop target is the parent.
        await expect.poll(() => pairOf(userDataDir, 's-a1', 's-b1')).toMatchObject({ kind: 'manual', from: 's-a1', to: 's-b1' })
        expect(pairOf(userDataDir, 's-a1', 's-b1')?.dismissed).toBeFalsy()

        // The dropped-on session's Related dialog lists the dragged one below it, marked "by hand".
        await activateSession(page, 'T59A1')
        await page.locator('[data-related-button="s-a1"]').click()
        const dialog = page.locator('[data-related-modal]')
        const manualRow = dialog.locator('[data-related-tree="down"] [data-related-row="s-b1"]')
        await expect(manualRow.locator('[data-related-by-hand]')).toBeVisible()
        await expect(manualRow).toBeVisible()
        await manualRow.locator('[data-related-remove]').click()
        await expect(manualRow).toHaveCount(0)
        await expect.poll(() => pairOf(userDataDir, 's-a1', 's-b1')?.dismissed).toBe(true)
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)

        // The user dragging it in again is a choice the user made: the removed pair is restored.
        // (Wait out the first notice, so the next one is the second drop's.)
        await expect(page.getByTestId('sidebar-drop-notice')).toHaveCount(0)
        await page.mouse.move(900, 500)
        await dragRowOver(page, 's-b1', list.locator('[data-session-item="s-a1"]'))
        await page.mouse.up()
        await expect(page.getByTestId('sidebar-drop-notice')).toHaveText('T59B1 is now under T59A1')
        await expect.poll(() => pairOf(userDataDir, 's-a1', 's-b1')?.dismissed).toBeFalsy()
        await page.locator('[data-related-button="s-a1"]').click()
        await expect(manualRow).toBeVisible()
        await page.keyboard.press('Escape')

        // Once more: already there, nothing changes.
        await expect(page.getByTestId('sidebar-drop-notice')).toHaveCount(0)
        await page.mouse.move(900, 500)
        await dragRowOver(page, 's-b1', list.locator('[data-session-item="s-a1"]'))
        await page.mouse.up()
        await expect(page.getByTestId('sidebar-drop-notice')).toHaveText('Already related: T59B1 ↔ T59A1')
        expect(storedRelations(userDataDir).filter(r => [r.from, r.to].includes('s-b1'))).toHaveLength(1)
    })

    test('a row does not take itself, and the workspace tree relates rows the same way', async () => {
        ctx = await launchAppWithWorkspaces(seed(), { settings: { showHomeWorkspace: false } })
        const { page, userDataDir } = ctx
        const a2 = page.locator('[data-session-item="s-a2"]')
        const b1 = page.locator('[data-session-item="s-b1"]')
        await expect(a2).toBeVisible()
        await expect(b1).toBeVisible()

        // Over its own row: no highlight, and the drop does nothing.
        await dragRowOver(page, 's-a2', a2)
        await page.mouse.move(((await a2.boundingBox())!.x) + 20, ((await a2.boundingBox())!.y) + 4, { steps: 4 })
        await expect(page.locator('[data-session-relate-target]')).toHaveCount(0)
        await page.mouse.up()
        await page.waitForTimeout(500)
        expect(storedRelations(userDataDir)).toEqual([])

        // Folder view, across workspaces: the same rows, the same drop.
        await dragRowOver(page, 's-a2', b1)
        await expect(page.locator('[data-session-relate-target="s-b1"]')).toBeVisible()
        await page.mouse.up()
        await expect(page.getByTestId('sidebar-drop-notice')).toHaveText('T59A2 is now under T59B1')
        await expect.poll(() => pairOf(userDataDir, 's-a2', 's-b1')).toMatchObject({ kind: 'manual' })
    })
})
