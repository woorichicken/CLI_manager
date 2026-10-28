import { test, expect, _electron as electron, ElectronApplication, Locator, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, resizeMainWindow, LaunchResult, REPO_ROOT, SeedWorkspace } from './helpers'
import type { SessionRelation } from '../../src/shared/types'

/**
 * T65 — sidebar All sessions, five reports of fb-1028.
 *
 * - 9fa825e7: a session row dropped on another goes under it — in the Tree and in the Related
 *   dialog — winning over the session that opened it; a row dropped on its own child is refused.
 * - d44191ed: the Tree keeps its order while the user clicks through it.
 * - dca55fd6: a Tree row with sessions under it folds; the fold survives a restart, and a folded
 *   row holding the active session is marked.
 * - f44ebd21: in the List, a line between the pinned sessions and the rest.
 * - 540ceb60: the sidebar's right-click menus close on a press outside, on Esc, on a click in the
 *   terminal and on a right-click elsewhere.
 *
 * Real mouse drags and clicks, judged in the DOM, config.json and localStorage across a relaunch.
 * `T65_SHOTS=<dir>` leaves 1280 and 390 captures there (taken before the checks that the old code
 * fails, so the same spec captures the "before" screens on it).
 */

const SHOTS = process.env.T65_SHOTS
const CHIEF = 't65-chief-00-4000-8000-000000000001'
const LEAD = 't65-lead-000-4000-8000-000000000002'
const WORKER = 't65-worker-0-4000-8000-000000000003'
const LOOSE = 't65-loose-00-4000-8000-000000000004'
const LEAD_B = 't65-lead-b-0-4000-8000-000000000005'
const W2 = 't65-w2-00000-4000-8000-000000000006'
const ROOT2 = 't65-root2-00-4000-8000-000000000007'
const X = 't65-x-000000-4000-8000-000000000008'

type StoredRelation = { from: string; to: string; kind: string; dismissed?: boolean }
const readConfig = (userDataDir: string) => JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
const storedRelations = (userDataDir: string): StoredRelation[] => readConfig(userDataDir).sessionRelations ?? []
const pairOf = (userDataDir: string, a: string, b: string): StoredRelation | undefined =>
    storedRelations(userDataDir).find(r => !r.dismissed && ((r.from === a && r.to === b) || (r.from === b && r.to === a)))

const treeRows = (page: Page) =>
    page.locator('[data-testid="session-tree-rows"] [data-session-item]').evaluateAll(rows =>
        rows.map(r => `${r.getAttribute('data-session-item')}@${r.getAttribute('data-tree-depth') ?? 0}`))
const unlinkedIds = (page: Page) =>
    page.locator('[data-testid="session-tree-unlinked-rows"] [data-session-item]').evaluateAll(rows => rows.map(r => r.getAttribute('data-session-item')))
const at = (id: string, depth: number) => `${id}@${depth}`

async function shot(page: Page, app: ElectronApplication, name: string): Promise<void> {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(SHOTS, `${name}-1280.png`) })
    await resizeMainWindow(app, 390, 800)
    await page.waitForTimeout(700)
    await page.screenshot({ path: path.join(SHOTS, `${name}-390.png`) })
    await resizeMainWindow(app, 1280, 800)
    await page.waitForTimeout(500)
}

/** Press on a sidebar row and move onto `target` with the mouse; the button stays down. */
async function dragRowOver(page: Page, sessionId: string, target: Locator): Promise<void> {
    const from = await page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${sessionId}"]`).boundingBox()
    const to = await target.boundingBox()
    expect(from && to).toBeTruthy()
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
    await page.mouse.down()
    await page.mouse.move(from!.x + from!.width / 2 + 6, from!.y + from!.height / 2 + 6, { steps: 3 })
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 })
}

const row = (page: Page, id: string) => page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${id}"]`)

test.describe('T65 sidebar tree (fb-1028)', () => {
    let ctx: LaunchResult | undefined
    let relaunched: ElectronApplication | null = null
    const dirs: string[] = []
    const dir = (prefix: string): string => {
        const made = fs.mkdtempSync(path.join(os.tmpdir(), `climanger-t65-${prefix}-`))
        dirs.push(made)
        return made
    }
    test.afterEach(async () => {
        if (relaunched) await relaunched.close().catch(() => undefined)
        relaunched = null
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const made of dirs.splice(0)) fs.rmSync(made, { recursive: true, force: true })
    })

    async function openTree(page: Page): Promise<void> {
        await page.getByTestId('sidebar-view-toggle').click()
        await page.getByTestId('all-sessions-layout-tree').click()
        await expect(page.getByTestId('sidebar-session-tree')).toBeVisible()
    }

    test('a dropped row goes under the row it was dropped on, over its opener; a drop on its own child is refused (9fa825e7)', async () => {
        const home = dir('home')
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-t65', name: 'T65WS', path: dir('ws'), sessions: [
                { id: CHIEF, name: 'T65 chief' }, { id: LEAD, name: 'T65 lead' }, { id: WORKER, name: 'T65 worker' }, { id: LOOSE, name: 'T65 loose' },
                { id: ROOT2, name: 'T65 other lead' }
            ] }
        ], {
            settings: { showHomeWorkspace: false },
            config: { sessionRelations: [
                { from: CHIEF, to: LEAD, kind: 'opened', at: 1 },
                { from: LEAD, to: WORKER, kind: 'opened', at: 2 }
            ] satisfies SessionRelation[] },
            env: { CLIMANGER_HOME: home }
        })
        const { page, app, userDataDir } = ctx
        await resizeMainWindow(app, 1280, 800)
        await openTree(page)
        await expect.poll(() => treeRows(page)).toEqual([at(CHIEF, 0), at(LEAD, 1), at(WORKER, 2)])
        expect(await unlinkedIds(page)).toEqual([LOOSE, ROOT2])

        // The loose session dropped on the worker: under the worker.
        await dragRowOver(page, LOOSE, row(page, WORKER))
        await expect(page.locator(`[data-session-relate-target="${WORKER}"]`)).toBeVisible()
        await page.mouse.up()
        const notice = page.getByTestId('sidebar-drop-notice')
        await expect(notice).toBeVisible()
        // Read now: it goes after two seconds, and the captures below take about that long.
        const said = await notice.textContent()
        await page.mouse.move(900, 500)
        // Captured before the checks, so the old code's screens come out of the same run.
        await shot(page, app, 'tree-dragged')
        await row(page, WORKER).getByText('T65 worker', { exact: true }).click()
        await page.locator(`[data-related-button="${WORKER}"]`).click()
        await expect(page.locator('[data-related-modal]')).toBeVisible()
        await shot(page, app, 'related-dragged')
        await page.keyboard.press('Escape')
        expect(said).toBe('T65 loose is now under T65 worker')
        await expect.poll(() => treeRows(page)).toEqual([at(CHIEF, 0), at(LEAD, 1), at(WORKER, 2), at(LOOSE, 3)])
        expect(await unlinkedIds(page)).toEqual([ROOT2])
        expect(pairOf(userDataDir, WORKER, LOOSE)).toMatchObject({ from: WORKER, to: LOOSE, kind: 'manual' })

        // The chief dropped on the loose session, which is below it: refused, nothing stored.
        await expect(page.getByTestId('sidebar-drop-notice')).toHaveCount(0)
        await dragRowOver(page, CHIEF, row(page, LOOSE))
        await page.mouse.up()
        await expect(page.getByTestId('sidebar-drop-notice')).toHaveText("Can't put T65 chief under T65 loose: T65 loose is below it")
        await page.waitForTimeout(400)
        expect(pairOf(userDataDir, CHIEF, LOOSE)).toBeUndefined()
        expect(await treeRows(page)).toEqual([at(CHIEF, 0), at(LEAD, 1), at(WORKER, 2), at(LOOSE, 3)])

        // The worker, opened by the lead, dropped on the other lead: the drop wins, and what hangs under it comes along.
        await expect(page.getByTestId('sidebar-drop-notice')).toHaveCount(0)
        await page.mouse.move(900, 500)
        await dragRowOver(page, WORKER, row(page, ROOT2))
        await page.mouse.up()
        await expect(page.getByTestId('sidebar-drop-notice')).toHaveText('T65 worker is now under T65 other lead')
        await expect.poll(() => treeRows(page)).toEqual([at(CHIEF, 0), at(LEAD, 1), at(ROOT2, 0), at(WORKER, 1), at(LOOSE, 2)])
        await expect(page.getByTestId('session-tree-unlinked')).toHaveCount(0)

        // The worker's Related dialog: the drop target above (by hand), the loose session below, the opener kept apart.
        await row(page, WORKER).getByText('T65 worker', { exact: true }).click()
        await page.locator(`[data-related-button="${WORKER}"]`).click()
        const dialog = page.locator('[data-related-modal]')
        await expect(dialog).toBeVisible()
        await shot(page, app, 'related-moved')
        await expect(dialog.locator(`[data-related-tree="up"] [data-related-row="${ROOT2}"] [data-related-by-hand]`)).toBeVisible()
        await expect(dialog.locator(`[data-related-tree="down"] [data-related-row="${LOOSE}"]`)).toBeVisible()
        await expect(dialog.locator(`[data-related-tree="other"] [data-related-row="${LEAD}"]`)).toBeVisible()
        await page.keyboard.press('Escape')

        // The opener's dialog no longer has the worker below it, but still lists it.
        await row(page, LEAD).getByText('T65 lead', { exact: true }).click()
        await page.locator(`[data-related-button="${LEAD}"]`).click()
        await expect(dialog.locator(`[data-related-tree="other"] [data-related-row="${WORKER}"]`)).toBeVisible()
        await expect(dialog.locator(`[data-related-tree="down"] [data-related-row]`)).toHaveCount(0)
        await page.keyboard.press('Escape')

        // Dragged back onto its opener: the latest drop wins here too — the drop holding it elsewhere goes.
        await expect(page.getByTestId('sidebar-drop-notice')).toHaveCount(0)
        await page.mouse.move(900, 500)
        await dragRowOver(page, WORKER, row(page, LEAD))
        await page.mouse.up()
        await expect(page.getByTestId('sidebar-drop-notice')).toHaveText('T65 worker is back under T65 lead')
        await expect.poll(() => treeRows(page)).toEqual([at(CHIEF, 0), at(LEAD, 1), at(WORKER, 2), at(LOOSE, 3)])
        expect(await unlinkedIds(page)).toEqual([ROOT2])
        expect(pairOf(userDataDir, ROOT2, WORKER)).toBeUndefined()
        expect(pairOf(userDataDir, LEAD, WORKER)).toMatchObject({ from: LEAD, to: WORKER, kind: 'opened' })
        expect(ctx.pageErrors).toEqual([])
    })

    test('the Tree keeps its order while clicked through; a fold stays after a restart and marks the active session (d44191ed, dca55fd6)', async () => {
        const home = dir('home')
        const seed: SeedWorkspace[] = [
            { id: 'ws-t65', name: 'T65WS', path: dir('ws'), sessions: [
                { id: CHIEF, name: 'T65 chief' }, { id: LEAD, name: 'T65 lead A' }, { id: LEAD_B, name: 'T65 lead B' },
                { id: WORKER, name: 'T65 w1' }, { id: W2, name: 'T65 w2' }, { id: ROOT2, name: 'T65 root2' }, { id: X, name: 'T65 x' }
            ] }
        ]
        const relations: SessionRelation[] = [
            { from: CHIEF, to: LEAD, kind: 'opened', at: 1 }, { from: CHIEF, to: LEAD_B, kind: 'opened', at: 2 },
            { from: LEAD, to: WORKER, kind: 'opened', at: 3 }, { from: LEAD, to: W2, kind: 'opened', at: 4 },
            { from: ROOT2, to: X, kind: 'connected', at: 5 }
        ]
        ctx = await launchAppWithWorkspaces(seed, { settings: { showHomeWorkspace: false }, config: { sessionRelations: relations }, env: { CLIMANGER_HOME: home } })
        const { page, app } = ctx
        await resizeMainWindow(app, 1280, 800)
        await openTree(page)
        const fixed = [at(CHIEF, 0), at(LEAD, 1), at(WORKER, 2), at(W2, 2), at(LEAD_B, 1), at(ROOT2, 0), at(X, 1)]
        await expect.poll(async () => (await treeRows(page)).length).toBe(fixed.length)
        const first = await treeRows(page)

        // Clicking through, the pointer leaving the list after each — the old tree re-sorted by what was viewed:
        // an older child, an older sibling and the second root are the rows that moved up there.
        for (const [id, name] of [[WORKER, 'T65 w1'], [LEAD, 'T65 lead A'], [ROOT2, 'T65 root2']] as const) {
            await row(page, id).getByText(name, { exact: true }).click()
            await page.mouse.move(900, 500)
            await page.waitForTimeout(400)
            if (id === WORKER) await shot(page, app, 'tree-after-click')
            expect(await treeRows(page), `after clicking ${name}`).toEqual(first)
        }
        // And that fixed order is oldest relation first, roots in sidebar order.
        expect(first).toEqual(fixed)
        // W2 is on screen; folding its parent hides it, and the lead stands in for it.
        await row(page, W2).getByText('T65 w2', { exact: true }).click()
        await page.mouse.move(900, 500)
        await shot(page, app, 'tree-before-fold')
        await page.locator(`[data-tree-toggle="${LEAD}"]`).click()
        await expect(page.locator(`[data-tree-toggle="${LEAD}"]`)).toHaveAttribute('aria-expanded', 'false')
        await expect.poll(() => treeRows(page)).toEqual([at(CHIEF, 0), at(LEAD, 1), at(LEAD_B, 1), at(ROOT2, 0), at(X, 1)])
        await expect(page.locator(`[data-tree-hidden-count="${LEAD}"]`)).toHaveText('+2')
        await expect(page.locator(`[data-tree-holds-active="${LEAD}"]`)).toHaveCount(1)
        // A row with nothing under it has no button; the toggle does not select the row.
        await expect(page.locator(`[data-tree-toggle="${LEAD_B}"]`)).toHaveCount(0)
        await page.locator(`[data-tree-toggle="${CHIEF}"]`).click()
        await expect.poll(() => treeRows(page)).toEqual([at(CHIEF, 0), at(ROOT2, 0), at(X, 1)])
        await expect(page.locator(`[data-tree-hidden-count="${CHIEF}"]`)).toHaveText('+4')
        // Only the outermost fold marks it: the lead is hidden now.
        await expect(page.locator(`[data-tree-holds-active="${CHIEF}"]`)).toHaveCount(1)
        await page.locator(`[data-tree-toggle="${CHIEF}"]`).click()
        await page.mouse.move(900, 500)
        await shot(page, app, 'tree-folded')

        // Relaunch on the same userData: still the Tree, the lead still folded, the chief open.
        const userDataDir = ctx.userDataDir
        await app.close()
        dirs.push(userDataDir)
        ctx = undefined
        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: { ...process.env, CLIMANGER_TEST_USERDATA: userDataDir, CLIMANGER_TERM_DEBUG: '1', CLIMANGER_TEST_HEADLESS: '1', CLIMANGER_HOME: home } as Record<string, string>
        })
        const page2 = await relaunched.firstWindow()
        await expect(page2.getByTestId('sidebar-session-tree')).toBeVisible({ timeout: 30_000 })
        await expect.poll(() => treeRows(page2), { timeout: 15_000 }).toEqual([at(CHIEF, 0), at(LEAD, 1), at(LEAD_B, 1), at(ROOT2, 0), at(X, 1)])
        await expect(page2.locator(`[data-tree-hidden-count="${LEAD}"]`)).toHaveText('+2')
        await page2.locator(`[data-tree-toggle="${LEAD}"]`).click()
        await expect.poll(() => treeRows(page2)).toEqual(fixed)
    })

    test('the List draws a line under the pinned sessions, in a session folder too; the Tree does not (f44ebd21)', async () => {
        const folder = dir('ws')
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-one', name: 'T65ONE', path: folder, sessions: [
                { id: 's-a1', name: 'T65A1' }, { id: 's-a2', name: 'T65A2' }, { id: 's-a3', name: 'T65A3' },
                { id: 's-f1', name: 'T65F1', sessionFolderId: 'sf-t65' }, { id: 's-f2', name: 'T65F2', sessionFolderId: 'sf-t65' }
            ] }
        ], {
            settings: { showHomeWorkspace: false },
            config: { sessionFolders: [{ id: 'sf-t65', name: 'T65 folder', isExpanded: true, createdAt: 1 }] }
        })
        const { page, app } = ctx
        await resizeMainWindow(app, 1280, 800)
        await page.getByTestId('sidebar-view-toggle').click()
        const divider = page.getByTestId('session-list-pinned-divider')
        await expect(row(page, 's-a1')).toBeVisible()
        await expect(divider).toHaveCount(0)

        const pin = async (id: string): Promise<void> => {
            await row(page, id).click({ button: 'right' })
            await page.locator(`[data-session-pin-toggle="${id}"]`).click()
            await page.mouse.move(900, 500)
            await expect(row(page, id).locator('[data-session-pinned]')).toHaveCount(1)
        }
        await pin('s-a3')
        await pin('s-f2')
        await shot(page, app, 'list-pinned-divider')
        // One line under the pinned row of "No folder", one in the folder.
        await expect(divider).toHaveCount(2)
        const around = await divider.evaluateAll(lines => lines.map(line => [
            line.previousElementSibling?.querySelector('[data-session-item]')?.getAttribute('data-session-item'),
            line.nextElementSibling?.querySelector('[data-session-item]')?.getAttribute('data-session-item')
        ]))
        expect(around).toEqual([['s-f2', 's-f1'], ['s-a3', 's-a1']])
        const lineBox = await divider.last().boundingBox()
        const listBox = await page.getByTestId('sidebar-all-sessions').boundingBox()
        expect(lineBox!.x).toBeGreaterThanOrEqual(listBox!.x)
        expect(lineBox!.x + lineBox!.width).toBeLessThanOrEqual(listBox!.x + listBox!.width)

        // Everything in "No folder" pinned: nothing to divide there.
        await pin('s-a1')
        await pin('s-a2')
        await expect(divider).toHaveCount(1)
        await page.getByTestId('all-sessions-layout-tree').click()
        await expect(page.getByTestId('sidebar-session-tree')).toBeVisible()
        await expect(divider).toHaveCount(0)
    })

    test('right-click menus close on a press outside, Esc, a terminal click and a right-click elsewhere (540ceb60)', async () => {
        const folder = dir('ws')
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-one', name: 'T65ONE', path: folder, folderId: 'wf-t65', sessions: [
                { id: 's-a1', name: 'T65A1', sessionFolderId: 'sf-t65' }, { id: 's-a2', name: 'T65A2' }
            ] },
            { id: 'ws-two', name: 'T65TWO', path: folder, sessions: [{ id: 's-b1', name: 'T65B1' }] }
        ], {
            settings: { showHomeWorkspace: false },
            folders: [{ id: 'wf-t65', name: 'T65 WS folder', isExpanded: true, createdAt: 1 }],
            config: { sessionFolders: [{ id: 'sf-t65', name: 'T65 folder', isExpanded: true, createdAt: 1 }] }
        })
        const { page, app } = ctx
        await resizeMainWindow(app, 1280, 800)
        // The sidebar's menus are portals on <body>; matched by their look, so the old code is counted too.
        const menus = page.locator('body > div.fixed.shadow-xl.backdrop-blur-md')
        const anyMenu = (): Promise<number> => menus.count()
        await page.locator('[data-session-item="s-b1"]').first().getByText('T65B1', { exact: true }).click()
        await page.waitForTimeout(500)
        // Empty sidebar space under the last row: nothing there takes the press.
        const pressOutside = async (): Promise<void> => {
            const bottom = await page.locator('[data-session-item]').evaluateAll(rows =>
                Math.max(...rows.filter(r => (r as HTMLElement).offsetParent).map(r => r.getBoundingClientRect().bottom)))
            await page.mouse.click(60, bottom + 60)
        }

        type Opener = { name: string; open: () => Promise<void> }
        const folderView: Opener[] = [
            { name: 'session', open: () => page.locator('[data-session-item="s-a2"]').first().click({ button: 'right' }) },
            { name: 'workspace', open: () => page.locator('[data-workspace-item="ws-two"]').getByText('T65TWO', { exact: true }).first().click({ button: 'right' }) },
            { name: 'workspace folder', open: () => page.getByTestId('folder-header-wf-t65').click({ button: 'right' }) }
        ]
        const allView: Opener[] = [
            { name: 'session folder', open: () => page.getByTestId('session-folder-header-sf-t65').click({ button: 'right' }) },
            { name: 'session (All)', open: () => row(page, 's-a2').click({ button: 'right' }) }
        ]
        const closers: Array<[string, () => Promise<void>]> = [
            ['a press on the sidebar outside it', pressOutside],
            ['Esc', async () => { await page.keyboard.press('Escape') }],
            // The terminal of T65B1 fills the main area.
            ['a click in the terminal', async () => { await page.mouse.click(800, 400) }]
        ]

        const check = async (openers: Opener[]): Promise<void> => {
            for (const opener of openers) {
                for (const [how, close] of closers) {
                    await opener.open()
                    await expect(menus, `${opener.name} menu opens`).toHaveCount(1)
                    await close()
                    await expect.poll(anyMenu, { message: `${opener.name} menu, closed by ${how}` }).toBe(0)
                }
            }
            // Right-click another row: the first menu goes, only the new one stays.
            await openers[0].open()
            await openers[1].open()
            await expect.poll(anyMenu, { message: 'one menu after a right-click elsewhere' }).toBe(1)
            await page.keyboard.press('Escape')
            await expect.poll(anyMenu).toBe(0)
        }

        // The report's screen first: the session folder menu in All sessions, then a press elsewhere.
        await page.getByTestId('sidebar-view-toggle').click()
        await expect(page.getByTestId('session-folder-header-sf-t65')).toBeVisible()
        await allView[0].open()
        await expect(menus).toHaveCount(1)
        await pressOutside()
        await shot(page, app, 'folder-menu-after-outside-press')
        await expect.poll(anyMenu, { message: 'session folder menu, closed by a press outside' }).toBe(0)
        await check(allView)
        await page.getByTestId('sidebar-view-toggle').click()
        await expect(page.getByTestId('folder-header-wf-t65')).toBeVisible()
        await check(folderView)
        await page.getByTestId('sidebar-view-toggle').click()

        // The menus still work: a menu item runs and closes it.
        await row(page, 's-a2').click({ button: 'right' })
        await page.locator('[data-session-pin-toggle="s-a2"]').click()
        await expect(menus).toHaveCount(0)
        await expect(row(page, 's-a2').locator('[data-session-pinned]')).toHaveCount(1)
    })

    // A real batch's names and paths (fb-1028), no style caps injected: the fold button, the count
    // and the pinned line have to fit the default sidebar at depth 3.
    test('long batch names at depth 3: the fold button, the count and the pinned line stay inside the row', async () => {
        const root = dir('batch')
        const repo = path.join(root, 'Users', 'someone', 'Downloads', 'CLImanger-worktrees', 'fb1028-b')
        const chief = path.join(root, 'Users', 'someone', '.climanager', 'chief')
        for (const made of [repo, chief]) fs.mkdirSync(made, { recursive: true })
        const names: Record<string, string> = {
            [CHIEF]: 'AI: fb1028 총괄 — 라쏘런 피드백 3개 프로젝트 반영',
            [LEAD]: 'AI: fb1028 팀장 CLI Manager — 제보 12건 트리아지',
            [WORKER]: 'AI: fb1028 CLI Manager 사이드바 All sessions 트리',
            [LOOSE]: 'AI: fb1028 CLI Manager 사이드바 트리 캡처 보조',
            [LEAD_B]: 'AI: fb1028 팀장 콘텐츠 운영 — 제보 7건'
        }
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-chief', name: 'chief', path: chief, sessions: [{ id: CHIEF, name: names[CHIEF] }, { id: LEAD_B, name: names[LEAD_B] }] },
            { id: 'ws-repo', name: 'CLImanger', path: repo, sessions: [LEAD, WORKER, LOOSE].map(id => ({ id, name: names[id] })) }
        ], {
            settings: { showHomeWorkspace: false },
            config: { sessionRelations: [
                { from: CHIEF, to: LEAD, kind: 'opened', at: 1 }, { from: CHIEF, to: LEAD_B, kind: 'opened', at: 2 },
                { from: LEAD, to: WORKER, kind: 'opened', at: 3 }, { from: WORKER, to: LOOSE, kind: 'manual', at: 4 }
            ] satisfies SessionRelation[] }
        })
        const { page, app } = ctx
        await resizeMainWindow(app, 1280, 800)
        await openTree(page)
        await expect.poll(() => treeRows(page)).toEqual([at(CHIEF, 0), at(LEAD, 1), at(WORKER, 2), at(LOOSE, 3), at(LEAD_B, 1)])
        await page.locator(`[data-tree-toggle="${WORKER}"]`).click()
        await page.mouse.move(900, 500)

        const inside = async (id: string, selector: string) => row(page, id).evaluate((item, sel) => {
            const box = item.getBoundingClientRect()
            const part = item.querySelector(sel)?.getBoundingClientRect()
            return part ? part.left >= box.left - 0.5 && part.right <= box.right + 0.5 && part.width > 0 : null
        }, selector)
        for (const width of [1280, 390]) {
            await resizeMainWindow(app, width, 800)
            await page.waitForTimeout(600)
            for (const id of [CHIEF, LEAD, WORKER]) expect(await inside(id, `[data-tree-toggle="${id}"]`), `toggle of ${names[id]} at ${width}`).toBe(true)
            expect(await inside(WORKER, `[data-tree-hidden-count="${WORKER}"]`), `count at ${width}`).toBe(true)
            const list = page.getByTestId('sidebar-all-sessions')
            expect(await list.evaluate(el => el.scrollWidth <= el.clientWidth), `no sideways scroll at ${width}`).toBe(true)
        }
        await resizeMainWindow(app, 1280, 800)
        await shot(page, app, 'tree-long-names')

        // The List with a pinned long name: the line sits inside the list.
        await page.getByTestId('all-sessions-layout-list').click()
        await row(page, WORKER).click({ button: 'right' })
        await page.locator(`[data-session-pin-toggle="${WORKER}"]`).click()
        await page.mouse.move(900, 500)
        const divider = page.getByTestId('session-list-pinned-divider')
        await expect(divider).toHaveCount(1)
        const lineBox = await divider.boundingBox()
        const listBox = await page.getByTestId('sidebar-all-sessions').boundingBox()
        expect(lineBox!.x + lineBox!.width).toBeLessThanOrEqual(listBox!.x + listBox!.width)
        await shot(page, app, 'list-long-names')
    })
})
