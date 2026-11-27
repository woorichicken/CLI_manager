import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, resizeMainWindow, LaunchResult, toggleSidebarView, chooseSidebarView } from './helpers'
import type { SessionRelation } from '../../src/shared/types'

/**
 * T63 — Tree layout of the sidebar's All sessions view (day-1027: 「트리 보기도
 * 정상적으로 구현 … 설정에서 껐다가 킬 수 있었으면」).
 *
 * Seeded like a batch: a chief opened two leads and talked in a third session,
 * one lead opened a worker that worked in a helper, and the user dragged one
 * session onto another. Tree shows each session under its parent — the dropped-on
 * session for a hand-added pair — oldest first, with its workspace path cut at the
 * front; sessions without a parent or child sit under "Not in a tree". A row click goes to that
 * session. Settings › Sidebar turns the layout off (list only, no switch) and
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
const SOLO = 't63-solo-000-4000-8000-000000000009'

const RELATIONS: SessionRelation[] = [
    { from: CHIEF, to: LEAD_A, kind: 'opened', at: 1 },
    { from: CHIEF, to: LEAD_B, kind: 'opened', at: 2 },
    { from: LEAD_A, to: WORKER, kind: 'opened', at: 3 },
    { from: WORKER, to: HELPER, kind: 'connected', at: 4 },
    { from: CHIEF, to: TALK, kind: 'connected', at: 5 },
    // Added by hand (HAND dropped on LOOSE): HAND hangs under LOOSE (9fa825e7).
    { from: LOOSE, to: HAND, kind: 'manual', at: 6 },
    // Removed by the user: not shown anywhere.
    { from: LEAD_B, to: SOLO, kind: 'opened', at: 7, dismissed: true }
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

    // The CLIMANAGER_HOME of the last launch — where the Control API writes its discovery file.
    let home = ''
    async function launch(extra: { controlApi?: boolean } = {}): Promise<LaunchResult> {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t63-'))
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t63-home-'))
        temps.push(root, home)
        // A long path, so the label has to be cut; its last folder must stay in view.
        const deep = path.join(root, 'a-rather-long-parent-folder', 'another-long-folder-name', 'CLImanger-worktrees', 'd1027-api')
        const chief = path.join(root, 'chief')
        for (const dir of [deep, chief]) fs.mkdirSync(dir, { recursive: true })
        return launchAppWithWorkspaces([
            { id: 'ws-chief', name: 'chief', path: chief, sessions: [
                { id: CHIEF, name: 'T63 chief' }, { id: TALK, name: 'T63 talk' }, { id: LOOSE, name: 'T63 loose' },
                { id: SOLO, name: 'T63 solo' }
            ] },
            { id: 'ws-deep', name: 'CLImanger', path: deep, sessions: [
                { id: LEAD_A, name: 'T63 lead A' }, { id: LEAD_B, name: 'T63 lead B' },
                { id: WORKER, name: 'T63 worker' }, { id: HELPER, name: 'T63 helper' }, { id: HAND, name: 'T63 hand' }
            ] }
        ], {
            settings: { showHomeWorkspace: false, ...(extra.controlApi ? { controlApi: { enabled: true, port: 0 } } : {}) },
            config: { sessionRelations: RELATIONS },
            env: { CLIMANAGER_HOME: home }
        })
    }

    test('Tree puts each session under its parent, cuts paths at the front and goes to a clicked row', async () => {
        ctx = await launch()
        const { page } = ctx
        await resizeMainWindow(ctx.app, 1280, 800)
        await toggleSidebarView(page)
        await expect(page.getByTestId('sidebar-view-menu')).toHaveAttribute('data-view', 'list')
        await chooseSidebarView(page, 'tree')

        // Roots in sidebar order, each level oldest relation first; a child sits right under its parent.
        await expect.poll(() => treeIds(page, 'session-tree-rows')).toEqual([CHIEF, LEAD_A, WORKER, HELPER, LEAD_B, TALK, LOOSE, HAND])
        expect(await treeDepths(page)).toEqual([0, 1, 2, 3, 1, 1, 0, 1])
        // A removed pair does not make a tree.
        expect(await treeIds(page, 'session-tree-unlinked-rows')).toEqual([SOLO])

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

    // fb-1117 (사람 구두 11-17): 「왜 팀장이 엠금융 팀장으로 엮여 있는지」 — a lead that only looked at
    // another session's screen became its parent. Reading, waiting and focusing set the AI mark only;
    // typing into the session is what relates the two.
    test('a session another one only read, waited on or focused stays where it was; typing into it moves it under', async () => {
        ctx = await launch({ controlApi: true })
        const { page, userDataDir } = ctx
        await resizeMainWindow(ctx.app, 1280, 800)
        await toggleSidebarView(page)
        await chooseSidebarView(page, 'tree')
        const original = [CHIEF, LEAD_A, WORKER, HELPER, LEAD_B, TALK, LOOSE, HAND]
        await expect.poll(() => treeIds(page, 'session-tree-rows')).toEqual(original)

        const discoveryPath = path.join(home, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as { url: string; token: string }
        const api = async (method: string, route: string, body?: unknown): Promise<number> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't63', 'X-Caller-Session': LEAD_B },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            await res.text()
            return res.status
        }
        const pairWithLoose = (): SessionRelation[] =>
            ((JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).sessionRelations ?? []) as SessionRelation[])
                .filter(r => (r.from === LEAD_B && r.to === LOOSE) || (r.from === LOOSE && r.to === LEAD_B))
        const looseRow = page.locator(`[data-testid="session-tree-rows"] [data-session-item="${LOOSE}"]`)
        const related = page.locator('[data-related-modal]')

        // Lead B checks on LOOSE three ways, the way a chief or lead watches a session it does not drive.
        expect(await api('GET', `/v1/sessions/${LOOSE}/output`)).toBe(200)
        expect(await api('POST', `/v1/sessions/${LOOSE}/wait`, { timeoutMs: 3_000, quietMs: 300 })).toBe(200)
        expect(await api('POST', `/v1/sessions/${LOOSE}/focus`, {})).toBe(200)
        await page.waitForTimeout(2500) // long enough for a recorded pair to reach the sidebar
        await looseRow.getByText('T63 loose', { exact: true }).click()
        // Review shots before any check, so the old code leaves its "before" here too.
        const shots = process.env.T63_SHOTS
        if (shots) {
            fs.mkdirSync(shots, { recursive: true })
            await page.screenshot({ path: path.join(shots, 'tree-after-reads-1280.png') })
            await page.locator(`[data-related-button="${LOOSE}"]`).click()
            await expect(related).toBeVisible()
            await page.waitForTimeout(800)
            await page.screenshot({ path: path.join(shots, 'related-loose-after-reads-1280.png') })
            await page.keyboard.press('Escape')
            await expect(related).toHaveCount(0)
        }

        expect(pairWithLoose()).toEqual([])
        expect(await treeIds(page, 'session-tree-rows')).toEqual(original)
        await expect(looseRow).not.toHaveAttribute('data-tree-depth', /.*/) // a root carries no depth
        await expect(page.locator(`[data-related-button="${LOOSE}"]`)).toHaveAttribute('data-related-count', '1')
        await page.locator(`[data-related-button="${LOOSE}"]`).click()
        await expect(related.locator(`[data-related-row="${HAND}"]`)).toBeVisible()
        await expect(related.locator(`[data-related-row="${LEAD_B}"]`)).toHaveCount(0)
        await page.keyboard.press('Escape')

        // Typing into it is work in it: now LOOSE hangs under lead B.
        expect(await api('POST', `/v1/sessions/${LOOSE}/input`, { text: 'true' })).toBe(200)
        await expect.poll(pairWithLoose).toMatchObject([{ from: LEAD_B, to: LOOSE, kind: 'connected' }])
        await expect(looseRow).toHaveAttribute('data-tree-depth', '2', { timeout: 10_000 })
    })

    test('Settings turns the tree off (list only, no switch) and back on', async () => {
        ctx = await launch()
        const { page } = ctx
        await toggleSidebarView(page)
        await chooseSidebarView(page, 'tree')
        await expect(page.getByTestId('sidebar-session-tree')).toBeVisible()

        await page.locator('button[title^="Settings"]').click()

        await page.getByTestId('settings-category-sidebar').click()
        await page.getByTestId('settings-show-session-tree').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page.getByTestId('sidebar-session-tree')).toHaveCount(0, { timeout: 15_000 })
        // View ▾ falls back to List and offers no Tree (T192)
        await expect(page.getByTestId('sidebar-view-menu')).toHaveAttribute('data-view', 'list')
        await expect(page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${HELPER}"]`)).toHaveCount(1)

        // Back on: the switch returns with the layout chosen before.
        await page.locator('button[title^="Settings"]').click()
        await page.getByTestId('settings-category-sidebar').click()
        await page.getByTestId('settings-show-session-tree').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page.getByTestId('sidebar-session-tree')).toBeVisible({ timeout: 15_000 })
        await expect(page.getByTestId('sidebar-view-menu')).toHaveAttribute('data-view', 'tree')
    })

    // Batch sessions share a long prefix and differ at the end ("…CLI-Manager api" / "…CLI-Manager ui"):
    // the name has to win the row, or a lead and its workers look the same (총괄 되돌림 1, 2026-10-27).
    test('names that differ only at the end stay apart at depth 3, the path giving way first', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t63-names-'))
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t63-names-home-'))
        temps.push(root, home)
        const deep = path.join(root, 'Users', 'someone', 'Downloads', 'CLImanger-worktrees', 'd1027-api')
        fs.mkdirSync(deep, { recursive: true })
        const names: Record<string, string> = {
            [CHIEF]: 'AI: d1027 총괄',
            [LEAD_A]: 'AI: d1027 팀장 CLI-Manager',
            [WORKER]: 'AI: d1027 CLI-Manager api',
            [HELPER]: 'AI: d1027 CLI-Manager ui'
        }
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-names', name: 'CLImanger', path: deep, sessions: Object.entries(names).map(([id, name]) => ({ id, name })) }
        ], {
            settings: { showHomeWorkspace: false },
            config: { sessionRelations: [
                { from: CHIEF, to: LEAD_A, kind: 'opened', at: 1 },
                { from: LEAD_A, to: WORKER, kind: 'opened', at: 2 },
                { from: WORKER, to: HELPER, kind: 'opened', at: 3 }
            ] },
            env: { CLIMANAGER_HOME: home }
        })
        const { page } = ctx
        await resizeMainWindow(ctx.app, 1280, 800)
        await toggleSidebarView(page)
        await chooseSidebarView(page, 'tree')
        await expect.poll(() => treeDepths(page)).toEqual([0, 1, 2, 3])

        // The three share "AI: d1027 " and differ at the end (…CLI-Manager / …Manager api / …Manager ui):
        // the last letter has to be on screen.
        const telling: Array<[string, number]> = [LEAD_A, WORKER, HELPER].map(id => [id, names[id].length - 1])
        for (const [id, index] of telling) {
            // Found by text and the label's test id, which the earlier layout had too: the check runs on both.
            const row = await page.locator(`[data-session-item="${id}"]`).evaluate((item, [at, name]) => {
                // The innermost element holding the whole name (it may split it into pieces).
                const nameEl = Array.from(item.querySelectorAll('span')).filter(el => el.textContent === name).pop() as HTMLElement
                const label = item.querySelector('[data-testid="session-workspace-label"]') as HTMLElement
                // On screen = not clipped away by any ancestor up to the row (a wrapped label sits below its clip).
                const shown = (el: HTMLElement): boolean => {
                    const r = el.getBoundingClientRect()
                    if (r.width < 1 || r.height < 1) return false
                    for (let a = el.parentElement; a && a !== item.parentElement; a = a.parentElement) {
                        const style = getComputedStyle(a)
                        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
                        const b = a.getBoundingClientRect()
                        if (r.top >= b.bottom - 1 || r.bottom <= b.top + 1 || r.left >= b.right - 1 || r.right <= b.left + 1) return false
                    }
                    return true
                }
                // The letter at `at`, in whichever text piece holds it, must end inside that piece's box.
                const walker = document.createTreeWalker(nameEl, NodeFilter.SHOW_TEXT)
                let offset = at
                let node = walker.nextNode() as Text | null
                while (node && offset >= node.length) {
                    offset -= node.length
                    node = walker.nextNode() as Text | null
                }
                const range = document.createRange()
                range.setStart(node!, offset)
                range.setEnd(node!, offset + 1)
                const pieces = [nameEl, ...Array.from(nameEl.querySelectorAll('span'))]
                return {
                    tellingVisible: range.getBoundingClientRect().right <= node!.parentElement!.getBoundingClientRect().right + 0.5,
                    nameCut: pieces.some(el => el.scrollWidth > el.clientWidth),
                    pathShown: shown(label),
                    title: item.querySelector('[data-testid="session-name-with-path"]')?.getAttribute('title') ?? null
                }
            }, [index, names[id]] as const)
            expect(row.tellingVisible, `${names[id]}: the end that tells it apart is cut off`).toBe(true)
            // The name is only cut once the path is gone.
            if (row.nameCut) expect(row.pathShown, `${names[id]}: name cut while its path still shows`).toBe(false)
            expect(row.title).toBe(`${names[id]}\n${deep}`)
        }
    })
})
