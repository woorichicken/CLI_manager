import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, resizeMainWindow, LaunchResult } from './helpers'
import type { SessionRelation } from '../../src/shared/types'

/**
 * T63 — Tree layout of the sidebar's All sessions view (day-1027: 「트리 보기도
 * 정상적으로 구현 … 설정에서 껐다가 킬 수 있었으면」).
 *
 * Seeded like a batch: a chief opened two leads and talked in a third session,
 * one lead opened a worker that worked in a helper. Tree shows each session
 * under its parent with its workspace path cut at the front; sessions without
 * a parent or child sit under "Not in a tree". A row click goes to that
 * session. Settings › General turns the layout off (list only, no switch) and
 * back on (the tree returns). Judged in the DOM and the computed visibility.
 */

const CHIEF = 't63-chief-00-4000-8000-000000000001'
const LEAD_A = 't63-lead-a-0-4000-8000-000000000002'
const LEAD_B = 't63-lead-b-0-4000-8000-000000000003'
const WORKER = 't63-worker-0-4000-8000-000000000004'
const HELPER = 't63-helper-0-4000-8000-000000000005'
const TALK = 't63-talk-000-4000-8000-000000000006'
const LOOSE = 't63-loose-00-4000-8000-000000000007'
const HAND = 't63-hand-000-4000-8000-000000000008'

const RELATIONS: SessionRelation[] = [
    { from: CHIEF, to: LEAD_A, kind: 'opened', at: 1 },
    { from: CHIEF, to: LEAD_B, kind: 'opened', at: 2 },
    { from: LEAD_A, to: WORKER, kind: 'opened', at: 3 },
    { from: WORKER, to: HELPER, kind: 'connected', at: 4 },
    { from: CHIEF, to: TALK, kind: 'connected', at: 5 },
    // Added by hand: no direction, so not a tree edge.
    { from: LOOSE, to: HAND, kind: 'manual', at: 6 },
    // Removed by the user: not shown anywhere.
    { from: LEAD_B, to: LOOSE, kind: 'opened', at: 7, dismissed: true }
]

const treeIds = (page: Page, group: string) =>
    page.locator(`[data-testid="${group}"] [data-session-item]`).evaluateAll(rows => rows.map(r => r.getAttribute('data-session-item')))

const treeDepths = (page: Page) =>
    page.locator('[data-testid="session-tree-rows"] [data-session-item]').evaluateAll(rows => rows.map(r => Number(r.getAttribute('data-tree-depth') ?? 0)))

const visibleTerminals = (page: Page) =>
    page.evaluate(() => Array.from(document.querySelectorAll('[data-session-id]'))
        .filter(el => getComputedStyle(el).visibility === 'visible' && (el as HTMLElement).offsetWidth > 0)
        .map(el => el.getAttribute('data-session-id')))

test.describe('T63 All sessions tree', () => {
    let ctx: LaunchResult | undefined
    const temps: string[] = []
    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    async function launch(): Promise<LaunchResult> {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t63-'))
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t63-home-'))
        temps.push(root, home)
        // A long path, so the label has to be cut; its last folder must stay in view.
        const deep = path.join(root, 'a-rather-long-parent-folder', 'another-long-folder-name', 'CLImanger-worktrees', 'd1027-api')
        const chief = path.join(root, 'chief')
        for (const dir of [deep, chief]) fs.mkdirSync(dir, { recursive: true })
        return launchAppWithWorkspaces([
            { id: 'ws-chief', name: 'chief', path: chief, sessions: [
                { id: CHIEF, name: 'T63 chief' }, { id: TALK, name: 'T63 talk' }, { id: LOOSE, name: 'T63 loose' }
            ] },
            { id: 'ws-deep', name: 'CLImanger', path: deep, sessions: [
                { id: LEAD_A, name: 'T63 lead A' }, { id: LEAD_B, name: 'T63 lead B' },
                { id: WORKER, name: 'T63 worker' }, { id: HELPER, name: 'T63 helper' }, { id: HAND, name: 'T63 hand' }
            ] }
        ], { settings: { showHomeWorkspace: false }, config: { sessionRelations: RELATIONS }, env: { CLIMANAGER_HOME: home } })
    }

    test('Tree puts each session under its parent, cuts paths at the front and goes to a clicked row', async () => {
        ctx = await launch()
        const { page } = ctx
        await resizeMainWindow(ctx.app, 1280, 800)
        await page.getByTestId('sidebar-view-toggle').click()
        await expect(page.getByTestId('all-sessions-layout-list')).toHaveAttribute('aria-pressed', 'true')
        await page.getByTestId('all-sessions-layout-tree').click()

        // Nothing viewed yet, so each level is newest relation first; a child sits right under its parent.
        await expect.poll(() => treeIds(page, 'session-tree-rows')).toEqual([CHIEF, TALK, LEAD_B, LEAD_A, WORKER, HELPER])
        expect(await treeDepths(page)).toEqual([0, 1, 1, 1, 2, 3])
        // A hand-added pair and a removed pair do not make a tree.
        expect((await treeIds(page, 'session-tree-unlinked-rows'))!.sort()).toEqual([HAND, LOOSE].sort())

        // The path label of a deep row is cut, and what is cut is the front: its last character is in view.
        const label = await page.locator(`[data-session-item="${WORKER}"] [data-testid="session-workspace-label"]`).evaluate(el => {
            const text = el.querySelector('bdi')?.firstChild as Text | null
            if (!text) return null
            const range = document.createRange()
            range.setStart(text, text.length - 1)
            range.setEnd(text, text.length)
            const last = range.getBoundingClientRect()
            const box = el.getBoundingClientRect()
            return { text: text.data, cut: el.scrollWidth > el.clientWidth, lastInView: last.left >= box.left - 1 && last.right <= box.right + 1 }
        })
        expect(label?.text.endsWith(path.join('CLImanger-worktrees', 'd1027-api'))).toBe(true)
        expect(label?.cut).toBe(true)
        expect(label?.lastInView).toBe(true)

        await page.locator(`[data-session-item="${HELPER}"]`).getByText('T63 helper', { exact: true }).click()
        await expect.poll(() => visibleTerminals(page)).toContain(HELPER)
    })

    test('Settings turns the tree off (list only, no switch) and back on', async () => {
        ctx = await launch()
        const { page } = ctx
        await page.getByTestId('sidebar-view-toggle').click()
        await page.getByTestId('all-sessions-layout-tree').click()
        await expect(page.getByTestId('sidebar-session-tree')).toBeVisible()

        await page.locator('button[title="Settings"]').click()
        await page.getByTestId('settings-show-session-tree').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page.getByTestId('sidebar-session-tree')).toHaveCount(0, { timeout: 15_000 })
        await expect(page.getByTestId('all-sessions-layout-tree')).toHaveCount(0)
        await expect(page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${HELPER}"]`)).toHaveCount(1)

        // Back on: the switch returns with the layout chosen before.
        await page.locator('button[title="Settings"]').click()
        await page.getByTestId('settings-show-session-tree').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page.getByTestId('sidebar-session-tree')).toBeVisible({ timeout: 15_000 })
        await expect(page.getByTestId('all-sessions-layout-tree')).toHaveAttribute('aria-pressed', 'true')
    })
})
