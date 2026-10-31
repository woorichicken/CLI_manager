import { test, expect, Page, ElectronApplication, _electron as electron } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, resizeMainWindow, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T71 — Header checklists (standup note 「기획 - 리스트」, 2nd plan): titled lists with a
 * deadline and a project that belong to no session. A lead makes one through the Control
 * API, the header chip shows the one looked at last, the panel pages through them with
 * ‹ › and edits them, and any session checks items through MCP. Closing a session leaves
 * checklists alone; removing a workspace only drops the project link; what was looked at
 * last survives a restart.
 *
 * Judged at the ends: the API's own answer, the chip and panel DOM, focus, and
 * config.json. CHECKLIST_SHOTS=<folder> saves captures at 1280 and 390 wide.
 */

const LEAD = 's-t71-lead'
const WORKER = 's-t71-worker'
const OTHER = 's-t71-other'

interface Discovery {
    url: string
    token: string
}

interface ApiChecklist {
    id: string
    title: string
    workspaceId: string | null
    workspaceName: string | null
    due: string | null
    overdue: boolean
    done: number
    total: number
    complete: boolean
    items: Array<{ id: string; n: number; text: string; done: boolean }>
    client: string
    createdBy: string | null
    createdByName: string | null
}

const RELEASE_ITEMS = [
    'Bump version & write release notes',
    'Build & notarize',
    'Publish the GitHub release',
    'Upload DMG to R2 · check the public URL',
    'Website links + changelog row'
]

/** Local date `offset` days from today, YYYY-MM-DD — the same clock the app compares with. */
function dayFromToday(offset: number): string {
    const date = new Date()
    date.setDate(date.getDate() + offset)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const chip = (page: Page) => page.getByTestId('checklist-chip')
const panel = (page: Page) => page.getByTestId('checklist-panel')
const itemRow = (page: Page, text: string) =>
    panel(page).locator('li[data-checklist-item]').filter({ has: page.getByText(text, { exact: true }) })
const itemTexts = (page: Page): Promise<string[]> => panel(page).getByTestId('checklist-item-text').allTextContents()
const focusedSession = (page: Page): Promise<string | null> =>
    page.evaluate(() => document.activeElement?.closest('[data-session-id]')?.getAttribute('data-session-id') ?? null)

test.describe('T71 header checklists', () => {
    let ctx: LaunchResult | undefined
    let relaunched: ElectronApplication | null = null
    const temps: string[] = []
    const tempDir = (prefix: string): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        temps.push(dir)
        return dir
    }
    let homeDir = ''

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        if (relaunched) await relaunched.close().catch(() => undefined)
        relaunched = null
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    const shotsDir = (): string | undefined => {
        const shots = process.env.CHECKLIST_SHOTS
        if (shots) fs.mkdirSync(shots, { recursive: true })
        return shots
    }

    async function launch(): Promise<LaunchResult> {
        homeDir = tempDir('climanager-t71-home-')
        return launchAppWithWorkspaces(
            [
                {
                    id: 'ws-t71', name: 'T71WS', path: tempDir('climanager-t71-ws-'), sessions: [
                        { id: LEAD, name: 'T71 lead' },
                        { id: WORKER, name: 'T71 worker' }
                    ]
                },
                { id: 'ws-t71-other', name: 'T71Other', path: tempDir('climanager-t71-other-'), sessions: [{ id: OTHER, name: 'T71 other' }] }
            ],
            {
                settings: { controlApi: { enabled: true, port: 0 }, showHomeWorkspace: false },
                env: { CLIMANAGER_HOME: homeDir }
            }
        )
    }

    async function apiFor(home: string) {
        const discoveryPath = path.join(home, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as Discovery
        return async <T = unknown>(method: string, route: string, body?: unknown, caller?: string): Promise<{ status: number; json: T }> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: {
                    Authorization: `Bearer ${discovery.token}`,
                    'Content-Type': 'application/json',
                    'X-Client-Name': 't71',
                    ...(caller !== undefined ? { 'X-Caller-Session': caller } : {})
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
        }
    }

    test('the lead makes a checklist, the header shows it, the panel and other sessions check it off', async () => {
        ctx = await launch()
        const { app, page } = ctx
        const shots = shotsDir()
        await resizeMainWindow(app, 1280, 800)
        await activateSession(page, 'T71 worker')
        const api = await apiFor(homeDir)
        const get = async (ref: string): Promise<ApiChecklist> =>
            (await api<{ checklist: ApiChecklist }>('GET', `/v1/checklists/${encodeURIComponent(ref)}`)).json.checklist
        const mcp = async (name: string, args: Record<string, unknown>, caller?: string) =>
            (await api<{ result: { content: Array<{ text: string }>; isError?: boolean } }>(
                'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, caller
            )).json.result

        // No checklist yet: the chip is only an icon.
        await expect(chip(page)).toHaveAttribute('data-progress', '')
        if (shots) await page.screenshot({ path: path.join(shots, 'header-empty-1280.png'), clip: { x: 0, y: 0, width: 1280, height: 110 } })

        // --- The lead makes one through REST ------------------------------------
        const made = await api<{ checklist: ApiChecklist; created: boolean }>('POST', '/v1/checklists', {
            title: 'v1.24 release', project: 'T71WS', due: dayFromToday(2), items: RELEASE_ITEMS
        }, LEAD)
        expect(made.status, JSON.stringify(made.json)).toBe(201)
        expect(made.json.checklist).toMatchObject({
            title: 'v1.24 release', workspaceId: 'ws-t71', workspaceName: 'T71WS', due: dayFromToday(2), overdue: false,
            done: 0, total: 5, complete: false, client: 't71', createdBy: LEAD, createdByName: 'T71 lead'
        })
        const releaseId = made.json.checklist.id
        const repeat = await api<{ checklist: ApiChecklist; created: boolean }>('POST', '/v1/checklists', { title: 'v1.24 release', items: RELEASE_ITEMS.slice(0, 2) }, LEAD)
        expect(repeat.status).toBe(200)
        expect(repeat.json).toMatchObject({ created: false, checklist: { id: releaseId, total: 5 } })

        // Refused: no title, a date that does not exist, an unknown project, a bad status.
        expect((await api('POST', '/v1/checklists', { items: ['x'] })).status).toBe(400)
        expect((await api('POST', '/v1/checklists', { title: 'Bad date', due: '2026-02-30' })).status).toBe(400)
        expect((await api('POST', '/v1/checklists', { title: 'Ghost project', project: 'No such workspace' })).status).toBe(404)
        expect((await api('GET', '/v1/checklists?status=maybe')).status).toBe(400)
        // Making a checklist does not mark any session as AI-driven: it is not a terminal.
        const sessions = (await api<Array<{ id: string; aiControlled: boolean }>>('GET', '/v1/sessions?scope=all')).json
        expect(sessions.length).toBe(3)
        expect(sessions.every((s) => !s.aiControlled)).toBe(true)

        await expect(chip(page)).toHaveAttribute('data-checklist-id', releaseId)
        await expect(chip(page)).toHaveAttribute('data-progress', '0/5')
        await expect(page.getByTestId('checklist-chip-title')).toHaveText('v1.24 release')
        await expect(page.getByTestId('checklist-chip-due')).toHaveAttribute('data-due-tone', 'soon')

        // --- A second one through MCP, with an earlier (passed) deadline ---------
        const docs = await mcp('checklist_create', { title: 'Docs sweep', items: ['README', 'CHANGELOG'], due: dayFromToday(-1) }, WORKER)
        expect(docs.isError ?? false).toBe(false)
        const docsId = (JSON.parse(docs.content[0].text) as { checklist: ApiChecklist }).checklist.id
        const order = (await api<{ checklists: ApiChecklist[] }>('GET', '/v1/checklists')).json.checklists
        expect(order.map((c) => [c.title, c.overdue])).toEqual([['Docs sweep', true], ['v1.24 release', false]])
        // The header keeps the one it was showing — it does not jump to the new, more urgent one.
        await expect(chip(page)).toHaveAttribute('data-checklist-id', releaseId)
        if (shots) await page.screenshot({ path: path.join(shots, 'header-chip-1280.png'), clip: { x: 0, y: 0, width: 1280, height: 110 } })

        // --- ⌘⇧J opens the panel on that checklist --------------------------------
        await page.keyboard.press('Meta+Shift+J')
        await expect(panel(page)).toBeVisible()
        await expect(page.getByTestId('checklist-add-input')).toBeFocused()
        await expect(page.getByTestId('checklist-title')).toHaveText('v1.24 release')
        await expect(page.getByTestId('checklist-position')).toHaveText('2 / 2')
        expect(await itemTexts(page)).toEqual(RELEASE_ITEMS)
        await expect(page.getByTestId('checklist-maker')).toHaveText('by T71 lead')
        await expect(page.getByTestId('checklist-project')).toHaveValue('ws-t71')
        await expect(page.getByTestId('checklist-due')).toHaveAttribute('data-due-tone', 'soon')

        // Checking in the panel: the item keeps its place, and the API sees it.
        await itemRow(page, 'Build & notarize').getByTestId('checklist-item-check').click()
        await expect(itemRow(page, 'Build & notarize')).toHaveAttribute('data-item-done', 'true')
        expect(await itemTexts(page)).toEqual(RELEASE_ITEMS)
        await expect.poll(async () => (await get(releaseId)).items.filter((i) => i.done).map((i) => i.n)).toEqual([2])
        await expect(chip(page)).toHaveAttribute('data-progress', '1/5')

        // Another session checks one by number through MCP — by the title, as an agent would.
        const checked = await mcp('checklist_check', { checklist: 'v1.24 release', item: 1 }, WORKER)
        expect(checked.content[0].text).toBe('v1.24 release: 2/5 checked.')
        await expect(itemRow(page, RELEASE_ITEMS[0])).toHaveAttribute('data-item-done', 'true')
        await expect(chip(page)).toHaveAttribute('data-progress', '2/5')
        expect((await mcp('checklist_check', { checklist: 'v1.24 release', item: 99 })).isError).toBe(true)
        expect((await mcp('checklist_check', { checklist: 'No such list', item: 1 })).isError).toBe(true)
        if (shots) await page.screenshot({ path: path.join(shots, 'panel-1280.png'), clip: { x: 0, y: 0, width: 1280, height: 520 } })

        // Adding, renaming and deleting items from the panel.
        await page.getByTestId('checklist-add-input').fill('Smoke-test on a clean account')
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('checklist-add-input')).toHaveValue('')
        await expect(page.getByTestId('checklist-add-input')).toBeFocused()
        await expect.poll(async () => (await get(releaseId)).items.map((i) => i.text).at(-1)).toBe('Smoke-test on a clean account')
        await itemRow(page, 'Website links + changelog row').getByTestId('checklist-item-text').dblclick()
        await page.getByTestId('checklist-item-input').fill('Website links + changelog')
        await page.keyboard.press('Enter')
        await expect.poll(async () => (await get(releaseId)).items[4].text).toBe('Website links + changelog')
        await itemRow(page, 'Smoke-test on a clean account').hover()
        await itemRow(page, 'Smoke-test on a clean account').getByTestId('checklist-item-remove').click()
        await expect.poll(async () => (await get(releaseId)).total).toBe(5)

        // Renaming the checklist reaches the chip.
        await page.getByTestId('checklist-title').dblclick()
        await page.getByTestId('checklist-title-input').fill('v1.24 release (final)')
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('checklist-chip-title')).toHaveText('v1.24 release (final)')

        // The deadline: a picked date saves without leaving the field; an emptied field clears it.
        await page.getByTestId('checklist-due').click()
        await page.getByTestId('checklist-due-input').fill(dayFromToday(5))
        await expect.poll(async () => (await get(releaseId)).due).toBe(dayFromToday(5))
        await page.getByTestId('checklist-due-input').fill('')
        await expect.poll(async () => (await get(releaseId)).due).toBeNull()
        await page.getByTestId('checklist-due-input').blur()
        await expect(page.getByTestId('checklist-set-due')).toBeVisible()

        // The project select: "No project" clears it.
        await page.getByTestId('checklist-project').selectOption('')
        await expect.poll(async () => (await get(releaseId)).workspaceId).toBeNull()
        await page.getByTestId('checklist-project').selectOption('ws-t71')
        await expect.poll(async () => (await get(releaseId)).workspaceName).toBe('T71WS')

        // ‹ › page through, wrapping; ← → do the same when no field has focus.
        await page.getByTestId('checklist-next').click()
        await expect(page.getByTestId('checklist-title')).toHaveText('Docs sweep')
        await expect(page.getByTestId('checklist-position')).toHaveText('1 / 2')
        await expect(chip(page)).toHaveAttribute('data-checklist-id', docsId)
        await expect(page.getByTestId('checklist-chip-due')).toHaveAttribute('data-due-tone', 'overdue')
        await page.keyboard.press('ArrowLeft')
        await expect(page.getByTestId('checklist-title')).toHaveText('v1.24 release (final)')

        // Esc closes and gives focus to the terminal in view. Nothing had focus when the panel opened —
        // the worker was already on screen at launch, so the page body did — and focus must not stay there.
        await page.keyboard.press('Escape')
        await expect(panel(page)).toHaveCount(0)
        await expect.poll(() => focusedSession(page)).toBe(WORKER)

        // A click outside closes it too; the memo's corner does not cover the panel.
        await page.keyboard.press('Meta+J')
        await expect(page.locator(`[data-session-id="${WORKER}"] textarea[placeholder="Quick notes..."]`)).toBeVisible()
        await chip(page).click()
        await expect(panel(page)).toBeVisible()
        const onTop = await panel(page).evaluate((el) => {
            const box = el.getBoundingClientRect()
            const hit = document.elementFromPoint(box.right - 20, box.top + 40)
            return hit !== null && el.contains(hit)
        })
        expect(onTop).toBe(true)
        await page.locator(`[data-session-id="${WORKER}"] .xterm-screen`).click({ position: { x: 40, y: 200 } })
        await expect(panel(page)).toHaveCount(0)
        await page.keyboard.press('Meta+J')

        // --- Split view: the chip is still in the (shorter) header ------------------
        await page.getByTestId('sidebar-view-toggle').click()
        await page.getByTestId('all-sessions-layout-list').click()
        for (const id of [LEAD, WORKER]) {
            await page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${id}"]`).hover()
            await page.locator(`[data-session-select="${id}"]`).click()
        }
        await page.getByTestId('session-selection-split').click()
        await expect.poll(() => page.evaluate(() =>
            Array.from(document.querySelectorAll('[data-session-id]')).filter((el) => getComputedStyle(el).visibility === 'visible').length
        )).toBe(2)
        await expect(chip(page)).toBeVisible()
        await expect(chip(page)).toHaveAttribute('data-progress', '2/5')
        if (shots) await page.screenshot({ path: path.join(shots, 'header-split-1280.png'), clip: { x: 0, y: 0, width: 1280, height: 110 } })
        await page.getByTestId('session-selection-clear').click()
        await page.getByTestId('sidebar-view-toggle').click()
        await activateSession(page, 'T71 worker')

        // --- Closing sessions leaves checklists alone --------------------------------
        expect((await api('DELETE', `/v1/sessions/${LEAD}`)).status).toBe(200)
        const afterClose = await get(releaseId)
        expect(afterClose).toMatchObject({ title: 'v1.24 release (final)', total: 5, done: 2, createdBy: LEAD, createdByName: null })

        // --- Making one in the panel: the project in view is its project -------------
        await chip(page).click()
        await page.getByTestId('checklist-new').click()
        await page.getByTestId('checklist-new-input').fill('Made in the panel')
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('checklist-title')).toHaveText('Made in the panel')
        await expect(page.getByTestId('checklist-add-input')).toBeFocused()
        const panelMade = await get('Made in the panel')
        expect(panelMade).toMatchObject({ client: 'app', workspaceId: 'ws-t71', total: 0, createdBy: null })

        // Deleting takes two clicks.
        await page.getByTestId('checklist-delete').click()
        await expect(page.getByTestId('checklist-delete')).toHaveAttribute('data-state', 'confirm')
        await page.getByTestId('checklist-delete').click()
        await expect.poll(async () => (await api('GET', `/v1/checklists/${panelMade.id}`)).status).toBe(404)
        await expect(page.getByTestId('checklist-title')).not.toHaveText('Made in the panel')

        // --- 390 wide: the chip drops the title, the panel stays in the window --------
        await page.keyboard.press('Escape')
        await page.locator('button[title="Close Sidebar"]').click()
        await resizeMainWindow(app, 390, 800)
        await expect(page.getByTestId('checklist-chip-title')).toBeHidden()
        await chip(page).click()
        await expect(panel(page)).toBeVisible()
        const box = await panel(page).boundingBox()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(390)
        if (shots) await page.screenshot({ path: path.join(shots, 'panel-390.png'), clip: { x: 0, y: 0, width: 390, height: 520 } })
    })

    test('a removed workspace keeps its checklists without the project; the one looked at last survives a restart', async () => {
        ctx = await launch()
        const { page } = ctx
        await activateSession(page, 'T71 lead')
        const api = await apiFor(homeDir)

        // An API-registered workspace, its checklist, then the workspace goes.
        const scratch = tempDir('climanager-t71-scratch-')
        const opened = await api<{ session: { id: string; workspaceId: string } }>('POST', '/v1/sessions', { path: scratch })
        expect(opened.status, JSON.stringify(opened.json)).toBe(200)
        const scratchWs = opened.json.session.workspaceId
        const tied = await api<{ checklist: ApiChecklist }>('POST', '/v1/checklists', { title: 'Scratch work', project: scratch, items: ['one'] })
        expect(tied.json.checklist.workspaceId).toBe(scratchWs)
        expect((await api('DELETE', `/v1/sessions/${opened.json.session.id}`)).status).toBe(200)
        const unregistered = await api('DELETE', `/v1/workspaces/${scratchWs}`)
        expect([200, 404]).toContain(unregistered.status)   // 404 when it was ephemeral and went with its last session
        const untied = (await api<{ checklist: ApiChecklist }>('GET', `/v1/checklists/${tied.json.checklist.id}`)).json.checklist
        expect(untied).toMatchObject({ title: 'Scratch work', workspaceId: null, total: 1 })

        const second = await api<{ checklist: ApiChecklist }>('POST', '/v1/checklists', { title: 'Survive the restart', due: dayFromToday(1), items: ['a', 'b'] }, LEAD)
        expect(second.status).toBe(201)
        // Look at the second one, so it is the one the header keeps.
        await chip(page).click()
        while ((await page.getByTestId('checklist-title').textContent()) !== 'Survive the restart') {
            await page.getByTestId('checklist-next').click()
        }
        await page.keyboard.press('Escape')
        await expect(chip(page)).toHaveAttribute('data-checklist-id', second.json.checklist.id)

        const userDataDir = ctx.userDataDir
        temps.push(userDataDir)
        const onDisk = (): Array<{ id: string; workspaceId?: string }> =>
            JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).checklists ?? []
        expect(onDisk().map((c) => c.id).sort()).toEqual([tied.json.checklist.id, second.json.checklist.id].sort())
        expect(onDisk().find((c) => c.id === tied.json.checklist.id)!.workspaceId).toBeUndefined()
        await ctx.app.close()
        ctx = undefined

        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: {
                ...process.env,
                CLIMANGER_TEST_USERDATA: userDataDir,
                CLIMANGER_TERM_DEBUG: '1',
                CLIMANGER_TEST_HEADLESS: '1',
                CLIMANAGER_HOME: homeDir
            } as Record<string, string>
        })
        const page2 = await relaunched.firstWindow()
        await page2.locator(`[data-session-item="${LEAD}"]`).waitFor({ timeout: 30_000 })
        await expect(chip(page2)).toHaveAttribute('data-checklist-id', second.json.checklist.id)
        await expect(chip(page2)).toHaveAttribute('data-progress', '0/2')
    })
})
