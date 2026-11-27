import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, resizeMainWindow, toggleSidebarView, chooseSidebarView } from './helpers'
import { listedSessions, listLines, searchLines, treeLines } from '../../src/renderer/src/phone/sessionListLines'
import type { PhoneSessionsResponse } from '../../src/shared/phone'

/**
 * T163 — fb-1123 round 2, sidebar header (person's review of PR #182).
 *
 *  - 91fce7bf r2: no strip across both panels. The panels start at the old 8px; only the traffic-light
 *    spot is kept free — inside the sidebar header row on the left, and in the main header when the
 *    sidebar is closed. The lights sit vertically centred in the header row (normal and split view).
 *    At the default sidebar width the title has no room next to the lights: it is hidden (not cut),
 *    and the toolbar's View ▾ names the view (view-filter-1127); a wider sidebar shows it whole. macOS only.
 *    The lights are native and never in a capture: the check reads where main put them
 *    (getWindowButtonPosition) and the captures draw them as an overlay (`-lights-overlay`).
 *  - cbc0ee48: «No folder» in the All sessions view folds like a session folder (chevron, count),
 *    remembers it, joins the header's collapse-all button, and still takes a dropped session folded.
 *  - 6ab4bf73: the header checklist chip is a small button — icon, count and a due dot; the title is
 *    in its tooltip; a click opens the panel.
 *
 * T163_SHOTS=<dir> + T163_LABEL=before|after saves captures before the checks (the old build's "before").
 */

const LABEL = process.env.T163_LABEL ?? 'run'
const isMac = process.platform === 'darwin'
/**
 * The three lights from their top-left corner (macOS 26: ~13px buttons, ~23px centre to centre,
 * measured from the reporter's capture 91fce7bf.png). Generous by a pixel each way.
 */
const LIGHTS = { width: 60, height: 13, diameter: 13, pitch: 23 }
/** Space the header keeps between the lights and its first item. */
const LIGHTS_GAP = 6

const WS = 'ws-t163'
const SESSIONS = ['s-t163-a', 's-t163-b', 's-t163-c', 's-t163-d']
const FOLDER = 'sf-t163'

let result: LaunchResult | null = null
const temps: string[] = []
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    temps.push(dir)
    return dir
}

function localDay(offset: number): string {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; userDataDir: string }> {
    const project = tempDir('climanager-t163-')
    const now = Date.now()
    result = await launchAppWithWorkspaces(
        [{
            id: WS,
            name: 'T163 project',
            path: project,
            sessions: [
                { id: SESSIONS[0], name: 'T163 alpha', sessionFolderId: FOLDER },
                { id: SESSIONS[1], name: 'T163 bravo' },
                { id: SESSIONS[2], name: 'T163 charlie' },
                { id: SESSIONS[3], name: 'T163 delta' }
            ]
        }],
        {
            settings: { showHomeWorkspace: false, showSessionCount: true },
            config: {
                sessionFolders: [{ id: FOLDER, name: 'T163 filed', isExpanded: true, createdAt: 1 }],
                checklists: [{
                    id: 'cl-t163',
                    title: 'Release checklist with a long title',
                    workspaceId: WS,
                    due: localDay(2),
                    items: [
                        { id: 'i1', text: 'Build', createdAt: now, doneAt: now },
                        { id: 'i2', text: 'Notarize', createdAt: now },
                        { id: 'i3', text: 'Publish', createdAt: now }
                    ],
                    createdAt: now,
                    updatedAt: now,
                    client: 'app'
                }]
            }
        }
    )
    await resizeMainWindow(result.app, 1280, 800)
    await expect(result.page.getByText('T163 delta', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await result.page.getByText('T163 bravo', { exact: true }).first().click()
    return { app: result.app, page: result.page, userDataDir: result.userDataDir }
}

const lightsAt = (app: ElectronApplication): Promise<{ x: number; y: number } | null> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition?.() ?? null)

/** The captures cannot see the native lights: draw three circles where main put them. */
async function drawLights(page: Page, app: ElectronApplication): Promise<void> {
    const at = await lightsAt(app)
    if (!at) return
    await page.evaluate(({ at, d, pitch }) => {
        document.querySelectorAll('[data-t163-lights]').forEach((el) => el.remove())
        const colors = ['#ff5f57', '#febc2e', '#28c840']
        colors.forEach((color, i) => {
            const dot = document.createElement('div')
            dot.setAttribute('data-t163-lights', '')
            Object.assign(dot.style, {
                position: 'fixed', left: `${at.x + i * pitch}px`, top: `${at.y}px`, width: `${d}px`, height: `${d}px`,
                borderRadius: '50%', background: color, zIndex: '2147483647', pointerEvents: 'none'
            })
            document.body.appendChild(dot)
        })
    }, { at, d: LIGHTS.diameter, pitch: LIGHTS.pitch })
}

async function shot(page: Page, app: ElectronApplication | null, dirName: string, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
    const root = process.env.T163_SHOTS
    if (!root) return
    const dir = path.join(root, dirName)
    fs.mkdirSync(dir, { recursive: true })
    if (app) await drawLights(page, app)
    await page.waitForTimeout(400)
    const file = `r2-${LABEL}-${name}${app ? '-lights-overlay' : ''}.png`
    await page.screenshot({ path: path.join(dir, file), clip })
    await page.evaluate(() => document.querySelectorAll('[data-t163-lights]').forEach((el) => el.remove()))
}

/** Drag the sidebar's resize handle so the card is `width` wide (the handler takes clientX). */
async function setSidebarWidth(page: Page, width: number): Promise<void> {
    const handle = page.locator('.glass-panel .cursor-col-resize').first()
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(width, box.y + 200, { steps: 8 })
    await page.mouse.up()
}

const sidebarHeader = (page: Page): Locator => page.getByTestId('sidebar-header')
const sidebarTitle = (page: Page): Locator => page.getByTestId('sidebar-title')

interface TitleState { text: string | null; hidden: boolean; cut: boolean; left: number; right: number }
const titleState = (page: Page): Promise<TitleState> =>
    sidebarTitle(page).evaluate((el) => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return {
            text: el.textContent,
            hidden: style.visibility === 'hidden' || style.display === 'none',
            cut: el.scrollWidth > el.clientWidth,
            left: rect.left,
            right: rect.right
        }
    })

test('T163 91fce7bf r2: only the traffic-light spot is free — panels at 8px, title hidden at 256, whole when wider; collapsed and split', async () => {
    test.skip(!isMac, 'the traffic lights are macOS only')
    const { app, page } = await launch()

    // Captures first (the old build is the "before"): 256 in both views, 340, collapsed.
    const header = { x: 0, y: 0, width: 1280, height: 120 }
    await shot(page, app, '91fce7bf', '1280-sidebar256', header)
    await toggleSidebarView(page)
    await shot(page, app, '91fce7bf', '1280-sidebar256-all', header)
    await toggleSidebarView(page)
    await setSidebarWidth(page, 340)
    await shot(page, app, '91fce7bf', '1280-sidebar340', header)
    await setSidebarWidth(page, 256)
    await page.locator('button[title^="Close Sidebar"]').click()
    await shot(page, app, '91fce7bf', '1280-collapsed', header)
    await page.locator('button[title^="Open Sidebar"]').click()
    await expect(page.locator('button[title^="Close Sidebar"]')).toBeVisible()

    const lights = await lightsAt(app)
    expect(lights, 'main reports the traffic light position').not.toBeNull()
    const lightsRight = lights!.x + LIGHTS.width
    const lightsCentre = lights!.y + LIGHTS.height / 2

    // No strip: both panels start where they did before round 1.
    const tops = await page.evaluate(() => Array.from(document.querySelectorAll('.glass-panel')).map((el) => Math.round(el.getBoundingClientRect().top)))
    expect(tops.length).toBeGreaterThanOrEqual(2)
    for (const top of tops) expect(top, 'panel top').toBe(8)
    await expect(page.locator('[data-window-title-strip]')).toHaveCount(0)

    // The lights sit in the sidebar header row, centred.
    const row = (await sidebarHeader(page).boundingBox())!
    expect(Math.abs(lightsCentre - (row.y + row.height / 2)), `lights centre ${lightsCentre} vs header ${row.y}+${row.height}`).toBeLessThanOrEqual(2)

    // 256: nothing in the header starts under the lights; the title is hidden, not cut, and the
    // toolbar's View ▾ names the view it is on (it replaced the header's view toggle — view-filter-1127).
    const firstButtonLeft = (): Promise<number> => sidebarHeader(page).evaluate((el) => {
        const buttons = Array.from(el.querySelectorAll('button')).filter((b) => (b as HTMLElement).offsetWidth > 0)
        return Math.min(...buttons.map((b) => b.getBoundingClientRect().left))
    })
    expect(await firstButtonLeft()).toBeGreaterThanOrEqual(lightsRight + LIGHTS_GAP)
    for (const view of ['Workspaces', 'All sessions']) {
        await expect.poll(async () => (await titleState(page)).text).toBe(view)
        const state = await titleState(page)
        expect(state.hidden, `${view} title hidden at 256: ${JSON.stringify(state)}`).toBe(true)
        await expect(page.getByTestId('sidebar-view-menu')).toHaveText(view === 'Workspaces' ? 'Folders' : 'List')
        expect(await firstButtonLeft()).toBeGreaterThanOrEqual(lightsRight + LIGHTS_GAP)
        await toggleSidebarView(page)
    }

    // Wider: the title is back, whole, right of the lights — in both views (the All view with its
    // collapse-all button is the fullest row).
    await setSidebarWidth(page, 340)
    for (const view of ['Workspaces', 'All sessions']) {
        await expect.poll(async () => (await titleState(page)).text).toBe(view)
        await expect.poll(async () => (await titleState(page)).hidden, { timeout: 3000 }).toBe(false)
        const state = await titleState(page)
        expect(state.cut, `${view} title whole at 340: ${JSON.stringify(state)}`).toBe(false)
        expect(state.left).toBeGreaterThanOrEqual(lightsRight + LIGHTS_GAP)
        await toggleSidebarView(page)
    }
    await setSidebarWidth(page, 256)
    await expect.poll(async () => (await titleState(page)).hidden).toBe(true)

    // Collapsed: the main header keeps the spot free; Open Sidebar starts right of the lights.
    await page.locator('button[title^="Close Sidebar"]').click()
    const open = page.locator('button[title^="Open Sidebar"]')
    await expect(open).toBeVisible()
    const openBox = (await open.boundingBox())!
    expect(openBox.x, 'Open Sidebar right of the lights').toBeGreaterThanOrEqual(lightsRight + LIGHTS_GAP)
    const mainHeader = (await page.locator('.glass-panel > div.draggable').first().boundingBox())!
    expect(Math.abs(lightsCentre - (mainHeader.y + mainHeader.height / 2))).toBeLessThanOrEqual(2)
    // At 390 the button still fits whole.
    await resizeMainWindow(app, 390, 800)
    await expect.poll(async () => {
        const box = (await open.boundingBox())!
        const visible = await open.evaluate((el) => {
            const r = el.getBoundingClientRect()
            const parent = el.parentElement!.getBoundingClientRect()
            return r.right <= parent.right + 0.5
        })
        return box.x >= lightsRight + LIGHTS_GAP && visible
    }).toBe(true)
    await resizeMainWindow(app, 1280, 800)
    await open.click()
    await expect(sidebarHeader(page)).toBeVisible()

    // Split view: the header row is shorter and the lights move up with it — centred again.
    await toggleSidebarView(page)
    await chooseSidebarView(page, 'list')
    for (const id of [SESSIONS[1], SESSIONS[2]]) {
        await page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${id}"]`).hover()
        await page.locator(`[data-session-select="${id}"]`).click()
    }
    await page.getByTestId('session-selection-split').click()
    await expect.poll(async () => Math.round((await sidebarHeader(page).boundingBox())!.height)).toBe(24)
    await expect.poll(async () => {
        const at = await lightsAt(app)
        const r = (await sidebarHeader(page).boundingBox())!
        return Math.abs(at!.y + LIGHTS.height / 2 - (r.y + r.height / 2)) <= 2
    }, { timeout: 3000 }).toBe(true)
    await shot(page, app, '91fce7bf', '1280-split', header)
})

test('T163 cbc0ee48: «No folder» folds like a folder, is remembered, joins collapse-all, and takes a drop while folded', async () => {
    const { page, userDataDir } = await launch()
    await toggleSidebarView(page)
    await chooseSidebarView(page, 'list')
    const list = page.getByTestId('sidebar-all-sessions')
    const none = page.getByTestId('session-folder-none')
    const unfiledRow = (id: string) => list.locator(`[data-session-folder-none-body] [data-session-item="${id}"]`)
    await expect(none).toBeVisible()
    await shot(page, null, 'cbc0ee48', 'all-sessions', { x: 0, y: 0, width: 300, height: 420 })

    // A row like a folder heading: chevron, count, state.
    await expect(none).toHaveAttribute('data-state', 'expanded')
    await expect(page.locator('[data-session-folder-count="none"]')).toHaveText('(3)')
    await expect(unfiledRow(SESSIONS[1])).toBeVisible()
    await none.click()
    await expect(none).toHaveAttribute('data-state', 'collapsed')
    await expect(list.locator(`[data-session-item="${SESSIONS[1]}"]`)).toHaveCount(0)
    await expect(list.locator(`[data-session-item="${SESSIONS[0]}"]`)).toBeVisible() // the folder is untouched
    await shot(page, null, 'cbc0ee48', 'no-folder-collapsed', { x: 0, y: 0, width: 300, height: 420 })

    // Remembered across a reload.
    await page.reload()
    await expect(page.getByTestId('session-folder-none')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('session-folder-none')).toHaveAttribute('data-state', 'collapsed')
    await expect(list.locator(`[data-session-item="${SESSIONS[1]}"]`)).toHaveCount(0)

    // Folded, it still takes a session dragged out of the folder.
    const from = (await list.locator(`[data-session-item="${SESSIONS[0]}"]`).boundingBox())!
    const to = (await none.boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 6, from.y + from.height / 2 + 6, { steps: 3 })
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
    await expect(none).toHaveAttribute('data-drop-state', 'over')
    await page.mouse.up()
    await expect.poll(() => {
        const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
        return config.workspaces[0].sessions.find((s: { id: string }) => s.id === SESSIONS[0])?.sessionFolderId ?? null
    }).toBeNull()
    await expect(page.locator('[data-session-folder-count="none"]')).toHaveText('(4)')
    await expect(none).toHaveAttribute('data-state', 'collapsed')

    // Collapse-all counts «No folder»: the folder open + No folder folded = something open.
    const foldAll = page.getByTestId('sidebar-collapse-session-folders')
    await expect(foldAll).toHaveAttribute('data-state', 'expanded')
    await foldAll.click()
    await expect(foldAll).toHaveAttribute('data-state', 'collapsed')
    await expect(none).toHaveAttribute('data-state', 'collapsed')
    await expect(page.locator(`[data-session-folder-body="${FOLDER}"]`)).toHaveCount(0)
    await foldAll.click()
    await expect(foldAll).toHaveAttribute('data-state', 'expanded')
    await expect(none).toHaveAttribute('data-state', 'expanded')
    await expect(unfiledRow(SESSIONS[1])).toBeVisible()
    await expect(page.locator(`[data-session-folder-body="${FOLDER}"]`)).toBeVisible()
    // Only No folder open still counts as open.
    await page.getByTestId(`session-folder-header-${FOLDER}`).click()
    await expect(foldAll).toHaveAttribute('data-state', 'expanded')
    await none.click()
    await expect(foldAll).toHaveAttribute('data-state', 'collapsed')
})

test('T163 6ab4bf73: the checklist chip is a small button — count and due dot, title in the tooltip, click opens the panel', async () => {
    const { page } = await launch()
    const chip = page.getByTestId('checklist-chip')
    await expect(chip).toHaveAttribute('data-checklist-id', 'cl-t163')
    await shot(page, null, '6ab4bf73', 'header-1280', { x: 0, y: 0, width: 1280, height: 60 })

    // Small: no title text on it, the count and a dot.
    await expect(chip).toHaveAttribute('data-progress', '1/3')
    expect((await chip.innerText()).trim()).toBe('1/3')
    expect((await chip.boundingBox())!.width, 'chip width').toBeLessThanOrEqual(80)
    const dot = page.getByTestId('checklist-chip-due')
    await expect(dot).toHaveAttribute('data-due-tone', 'soon')
    const dotBox = (await dot.boundingBox())!
    expect(dotBox.width).toBeLessThanOrEqual(8)
    expect(dotBox.height).toBeLessThanOrEqual(8)
    // The title and deadline are in the tooltip.
    const title = (await chip.getAttribute('title')) ?? ''
    expect(title.split('\n')[0]).toMatch(/^Checklists \(.+\) — Release checklist with a long title · 1\/3 · due /)

    // A click opens the panel; ⌘⇧J still toggles it.
    await chip.click()
    await expect(page.getByTestId('checklist-panel')).toBeVisible()
    await expect(page.getByTestId('checklist-title')).toHaveText('Release checklist with a long title')
    await shot(page, null, '6ab4bf73', 'panel-open', { x: 600, y: 0, width: 680, height: 420 })
    await page.keyboard.press('Meta+Shift+J')
    await expect(page.getByTestId('checklist-panel')).toHaveCount(0)
    await page.keyboard.press('Meta+Shift+J')
    await expect(page.getByTestId('checklist-panel')).toBeVisible()
})

const visibleTerminals = (page: Page): Promise<(string | null)[]> =>
    page.evaluate(() => Array.from(document.querySelectorAll('[data-session-id]'))
        .filter(el => getComputedStyle(el).visibility === 'visible' && (el as HTMLElement).offsetWidth > 0)
        .map(el => el.getAttribute('data-session-id')))

test('T163 1b965ad1: reply threads stay out of the sidebar lists and ⌘[ ] — Threads, search and the thread on screen still show them', async () => {
    const project = tempDir('climanager-t163t-')
    const P = 's-t163-parent', T1 = 's-t163-thread1', F = 's-t163-fork', T2 = 's-t163-thread2', X = 's-t163-other'
    const TFOLDER = 'sf-t163-threads'
    const now = Date.now()
    const anchor = { turnTs: new Date(now - 60_000).toISOString() }
    result = await launchAppWithWorkspaces(
        [{
            id: WS,
            name: 'T163 threads',
            path: project,
            sessions: [
                { id: P, name: 'T163 parent' },
                { id: T1, name: 'T163 thread one' },
                { id: F, name: 'T163 plain fork' },
                { id: T2, name: 'T163 thread two', sessionFolderId: TFOLDER },
                { id: X, name: 'T163 other' }
            ]
        }],
        {
            settings: { showHomeWorkspace: false, showSessionCount: true, showPlayground: false },
            config: {
                sessionFolders: [{ id: TFOLDER, name: 'T163 kept', isExpanded: true, createdAt: 1 }],
                sessionRelations: [
                    { from: P, to: T1, kind: 'opened', at: now - 3000, anchor },
                    { from: P, to: T2, kind: 'opened', at: now - 2000, anchor },
                    // a fork with no anchor (opened before threads, or by a lead): an ordinary session
                    { from: P, to: F, kind: 'opened', at: now - 1000 }
                ]
            }
        }
    )
    const { app, page, userDataDir } = result
    await resizeMainWindow(app, 1280, 800)
    const workspaceList = page.getByTestId('sidebar-workspace-list')
    await expect(workspaceList.locator(`[data-session-item="${P}"]`)).toBeVisible({ timeout: 15_000 })
    await workspaceList.locator(`[data-session-item="${P}"]`).click()
    await expect.poll(() => visibleTerminals(page)).toEqual([P])
    await shot(page, null, '1b965ad1', 'folders', { x: 0, y: 0, width: 420, height: 400 })

    // Folder view: the threads are not rows, nor in the count; the plain fork is.
    await expect(workspaceList.locator(`[data-session-item="${F}"]`)).toBeVisible()
    await expect(workspaceList.locator(`[data-session-item="${T1}"]`)).toHaveCount(0)
    await expect(workspaceList.locator(`[data-session-item="${T2}"]`)).toHaveCount(0)
    await expect(workspaceList.getByText('(3)', { exact: true }).first()).toBeVisible()

    // ⌘] from the parent goes to the next listed session, not into its thread.
    await page.keyboard.press('Meta+]')
    await expect.poll(() => visibleTerminals(page)).toEqual([F])
    await page.keyboard.press('Meta+[')
    await expect.poll(() => visibleTerminals(page)).toEqual([P])

    // All sessions, List: not in the session folder, not under «No folder».
    await toggleSidebarView(page)
    await chooseSidebarView(page, 'list')
    const all = page.getByTestId('sidebar-all-sessions')
    await expect(all.locator(`[data-session-item="${X}"]`)).toBeVisible()
    await shot(page, null, '1b965ad1', 'all-list', { x: 0, y: 0, width: 420, height: 400 })
    await expect(all.locator(`[data-session-item="${T1}"]`)).toHaveCount(0)
    await expect(all.locator(`[data-session-item="${T2}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-session-folder-count="${TFOLDER}"]`)).toHaveText('(0)')
    await expect(page.locator('[data-session-folder-count="none"]')).toHaveText('(3)')

    // Tree: the plain fork under its parent, no thread.
    await chooseSidebarView(page, 'tree')
    await expect(all.locator(`[data-session-item="${F}"]`)).toBeVisible()
    await expect(all.locator(`[data-session-item="${T1}"]`)).toHaveCount(0)
    await expect(all.locator(`[data-session-item="${T2}"]`)).toHaveCount(0)

    // Threads (💬) lists them.
    await page.getByTestId('all-sessions-threads').click()
    await expect(page.locator(`[data-testid="sidebar-thread-row"][data-child-id="${T1}"]`)).toBeVisible()
    await expect(page.locator(`[data-testid="sidebar-thread-row"][data-child-id="${T2}"]`)).toBeVisible()
    await page.getByTestId('all-sessions-threads').click()
    await chooseSidebarView(page, 'list')

    // Search finds a thread; opened from there it keeps its row while it is on screen.
    await page.getByTestId('sidebar-search-toggle').click()
    await page.getByPlaceholder('Search projects and sessions').fill('thread one')
    const found = page.locator(`[data-testid="sidebar-search-results"] [data-session-item="${T1}"]`).first()
    await expect(found).toBeVisible()
    await found.click()
    await expect.poll(() => visibleTerminals(page)).toEqual([T1])
    await page.getByTestId('sidebar-search-toggle').click()
    await expect(all.locator(`[data-session-item="${T1}"]`)).toBeVisible()
    await shot(page, null, '1b965ad1', 'thread-on-screen', { x: 0, y: 0, width: 420, height: 400 })
    // Moving on, it leaves the list again.
    await all.locator(`[data-session-item="${X}"]`).click()
    await expect.poll(() => visibleTerminals(page)).toEqual([X])
    await expect(all.locator(`[data-session-item="${T1}"]`)).toHaveCount(0)

    // An order that leaves sessions out does not delete them (the sidebar orders only what it shows).
    await page.evaluate(([ws, a, b]) => window.api.reorderSessions(ws, [a, b]), [WS, X, P])
    await expect.poll(() => {
        const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
        return config.workspaces[0].sessions.map((s: { id: string }) => s.id)
    }).toEqual([X, P, T1, F, T2])
})

test('T163 1b965ad1 phone: the session list flags reply threads — List and Tree skip them, search finds them', async () => {
    const home = tempDir('climanager-t163p-')
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const OWNER = 'owner-t163@example.com'
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    const P = 's-t163p-parent', T1 = 's-t163p-thread1', F = 's-t163p-fork', T2 = 's-t163p-thread2'
    const TFOLDER = 'sf-t163p-threads'
    const anchor = { turnTs: new Date(Date.now() - 60_000).toISOString() }
    result = await launchAppWithWorkspaces(
        [{
            id: WS,
            name: 'T163 phone',
            path: project,
            sessions: [
                { id: P, name: 'T163 parent' },
                { id: T1, name: 'T163 thread one' },
                { id: F, name: 'T163 plain fork' },
                { id: T2, name: 'T163 thread two', sessionFolderId: TFOLDER }
            ]
        }],
        {
            settings: { phone: { enabled: true, port: 0 }, showHomeWorkspace: false },
            config: {
                sessionFolders: [{ id: TFOLDER, name: 'T163 kept', isExpanded: true, createdAt: 1 }],
                sessionRelations: [
                    { from: P, to: T1, kind: 'opened', at: 1, anchor },
                    { from: P, to: T2, kind: 'opened', at: 2, anchor },
                    { from: P, to: F, kind: 'opened', at: 3 }
                ]
            },
            env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLIMANAGER_HOME: path.join(home, 'climanager') }
        }
    )
    const { page } = result
    await expect.poll(() => page.evaluate(() => window.api.getPhoneState().then((s) => s.running)), { timeout: 15_000 }).toBe(true)
    const port = (await page.evaluate(() => window.api.getPhoneState())).port
    const res = await fetch(`http://127.0.0.1:${port}/api/phone/sessions`, {
        headers: { 'Tailscale-User-Login': OWNER, 'X-Forwarded-For': '100.101.102.103' }
    })
    expect(res.status).toBe(200)
    const data = await res.json() as PhoneSessionsResponse

    // Every session is sent (the phone's search needs them); the threads carry the flag.
    expect(data.sessions.map((s) => s.id).sort()).toEqual([P, T1, F, T2].sort())
    expect(data.sessions.filter((s) => s.thread).map((s) => s.id).sort()).toEqual([T1, T2].sort())
    // The tree and the folder headings are built without them: a folder holding only a thread is not a heading.
    const treeIds = [...(data.tree?.rows ?? []).map((r) => r.id), ...(data.tree?.unlinked ?? [])]
    expect(treeIds).not.toContain(T1)
    expect(treeIds).not.toContain(T2)
    expect(treeIds).toContain(F)
    expect(data.sessionFolders).toEqual([])

    // What the phone draws from it (the same functions as the drawer).
    const rowIds = (lines: ReturnType<typeof listLines> | null) => (lines ?? []).flatMap((line) => (line.kind === 'row' ? [line.session.id] : []))
    expect(rowIds(listLines(data)).sort()).toEqual([F, P].sort())
    expect(rowIds(treeLines(data))).not.toContain(T1)
    expect(listedSessions(data).length).toBe(2)
    expect(rowIds(searchLines(data, 'thread two'))).toEqual([T2])
})
