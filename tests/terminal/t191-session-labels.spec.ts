import { test, expect, Page, _electron as electron } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult, REPO_ROOT, toggleSidebarView } from './helpers'

/**
 * T191 — a session's role and tags (decision 0015), in the app.
 *
 * Seeded: a lead with a role and tags from the store (proves the app reads them), three plain
 * sessions. Then the session menu's Role ▸ and Edit Tags…, the tab menu's Role & Tags…, the All
 * sessions filter button, and the Control API / MCP (set, clear, 400 bad_role, filters, open with a
 * role) — each judged in config.json and the sidebar DOM. Setting a label never adds the AI mark.
 * `T191_SHOTS=<dir>` keeps captures of the list, the menu, the editor and the filter.
 */

interface Discovery { url: string; mcpUrl: string; token: string }
interface ApiSession { id: string; name: string; role: string | null; tags: string[]; aiControlled: boolean }

const SHOTS = process.env.T191_SHOTS

const stored = (userDataDir: string, id: string): { role?: string; tags?: string[] } | undefined =>
    (JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).workspaces as Array<{ sessions: Array<{ id: string; role?: string; tags?: string[] }> }>)
        .flatMap(w => w.sessions).find(s => s.id === id)

async function shot(page: Page, name: string): Promise<void> {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), clip: { x: 0, y: 0, width: 520, height: 560 } })
}

const shownIds = (page: Page) =>
    page.locator('[data-testid="sidebar-all-sessions"] [data-session-item]').evaluateAll(rows => rows.map(r => r.getAttribute('data-session-item')))

test.describe('T191 session role and tags', () => {
    let ctx: LaunchResult | undefined
    let relaunched: Awaited<ReturnType<typeof electron.launch>> | null = null
    const dirs: string[] = []
    const dir = (prefix: string): string => {
        const made = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        dirs.push(made)
        return made
    }
    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        if (relaunched) await relaunched.close().catch(() => undefined)
        relaunched = null
        for (const made of dirs.splice(0)) fs.rmSync(made, { recursive: true, force: true })
    })

    async function launch(labels = true, sessionFolders = false): Promise<{ page: Page; userDataDir: string; home: string; folder: string }> {
        const home = dir('climanger-t191-home-')
        const folder = dir('climanger-t191-ws-')
        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-t191', name: 'T191WS', path: folder, sessions: [
                { id: 's-lead', name: 'T191 lead', ...(labels ? { role: 'lead', tags: ['night-1125'] } : {}) },
                { id: 's-a', name: 'T191 fix the sidebar', ...(sessionFolders ? { sessionFolderId: 'sf-work' } : {}) },
                { id: 's-b', name: 'T191 phone icons' },
                { id: 's-c', name: 'T191 plain', ...(sessionFolders ? { sessionFolderId: 'sf-other' } : {}) }
            ] }],
            {
                settings: { showHomeWorkspace: false, controlApi: { enabled: true, port: 0 } },
                env: { CLIMANAGER_HOME: home },
                ...(sessionFolders ? { config: { sessionFolders: [
                    { id: 'sf-work', name: 'T191 Work folder', isExpanded: true, createdAt: 1000 },
                    { id: 'sf-other', name: 'T191 Other folder', isExpanded: true, createdAt: 1001 }
                ] } } : {})
            }
        )
        await toggleSidebarView(ctx.page)
        await expect(ctx.page.locator('[data-session-item="s-a"]')).toBeVisible()
        return { page: ctx.page, userDataDir: ctx.userDataDir, home, folder }
    }

    test('the session menu sets the role, the editor sets tags, the filter narrows All sessions', async () => {
        const { page, userDataDir } = await launch()

        // Read from the store: the seeded lead shows its icon and its tag; a plain session has neither.
        const lead = page.locator('[data-session-item="s-lead"]')
        await expect(lead).toHaveAttribute('data-work-role', 'lead')
        await expect(lead.locator('[data-work-role-icon="lead"]')).toBeVisible()
        await expect(lead.locator('[data-session-tags-text]')).toHaveText(' · #night-1125')
        // The tag rides inside the dim workspace label — the part that gives way before the name.
        expect(await lead.locator('[data-testid="session-workspace-label"] [data-session-tags-text]').count()).toBe(1)
        await expect(page.locator('[data-session-item="s-a"]')).not.toHaveAttribute('data-work-role', /.+/)

        // Role ▸ Work from the row's menu: saved on click, the icon follows, no AI mark.
        await page.locator('[data-session-item="s-a"]').click({ button: 'right' })
        await page.getByTestId('session-menu-role').hover()
        const submenu = page.getByTestId('session-menu-role-submenu')
        await expect(submenu).toBeVisible()
        await shot(page, 'menu-role')
        await submenu.locator('[data-role-option="work"]').click()
        await expect(page.locator('[data-sidebar-menu="session"]')).toHaveCount(0)
        await expect(page.locator('[data-session-item="s-a"] [data-work-role-icon="work"]')).toBeVisible()
        await expect.poll(() => stored(userDataDir, 's-a')?.role).toBe('work')
        await expect(page.locator('[data-session-item="s-a"]')).toHaveAttribute('data-session-role', 'user')

        // Pointing at another row closes the submenu.
        await page.locator('[data-session-item="s-b"]').click({ button: 'right' })
        await page.getByTestId('session-menu-role').hover()
        await expect(submenu).toBeVisible()
        await page.locator('[data-session-pin-toggle="s-b"]').hover()
        await expect(submenu).toHaveCount(0)
        await page.keyboard.press('Escape')

        // Edit Tags…: Enter and a comma make tags, a duplicate is dropped, Esc cancels without saving.
        await page.locator('[data-session-item="s-a"]').click({ button: 'right' })
        await page.getByTestId('session-menu-edit-tags').click()
        const dialog = page.locator('[data-session-labels-dialog]')
        await expect(dialog).toBeVisible()
        await expect(dialog.locator('[data-labels-role="work"]')).toHaveAttribute('aria-checked', 'true')
        const input = dialog.locator('[data-labels-tag-input]')
        await input.fill('Night-1125')
        await input.press('Enter')
        await input.pressSequentially('sidebar, NIGHT-1125,')
        await expect(dialog.locator('[data-labels-tag]')).toHaveCount(2)
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        expect(stored(userDataDir, 's-a')?.tags).toBeUndefined()

        // Again, and Save — the suggestion from another session is offered and taken; a word left in the box counts.
        await page.locator('[data-session-item="s-a"]').click({ button: 'right' })
        await page.getByTestId('session-menu-edit-tags').click()
        await expect(dialog.locator('[data-labels-suggestion="night-1125"]')).toBeVisible()
        await dialog.locator('[data-labels-suggestion="night-1125"]').click()
        await dialog.locator('[data-labels-tag-input]').fill('sidebar')
        await shot(page, 'editor')
        await dialog.locator('[data-labels-save]').click()
        await expect(dialog).toHaveCount(0)
        await expect.poll(() => stored(userDataDir, 's-a')?.tags).toEqual(['night-1125', 'sidebar'])
        await expect(page.locator('[data-session-item="s-a"] [data-session-tags-text]')).toHaveText(' · #night-1125 +1')
        await shot(page, 'list')

        // The tab's menu opens the same editor: set Talk on s-b there.
        await page.locator('[data-session-item="s-b"]').click()
        await page.locator('[data-session-tab="s-b"]').click({ button: 'right' })
        await page.locator('[data-tab-menu-item="labels"]').click()
        await expect(dialog).toBeVisible()
        await dialog.locator('[data-labels-role="talk"]').click()
        await dialog.locator('[data-labels-save]').click()
        await expect.poll(() => stored(userDataDir, 's-b')?.role).toBe('talk')

        // Filter: Work shows only s-a; then tag night-1125 on top (role AND tag); the dot says it is on.
        const filterButton = page.getByTestId('all-sessions-label-filter')
        await filterButton.click()
        const filterMenu = page.getByTestId('all-sessions-label-filter-menu')
        await filterMenu.locator('[data-filter-role="work"]').click()
        await expect.poll(() => shownIds(page)).toEqual(['s-a'])
        await expect(filterButton).toHaveAttribute('data-filter-active', 'true')
        await filterMenu.locator('[data-filter-role="work"]').click()   // picking it again turns it off
        await filterMenu.locator('[data-filter-tag="night-1125"]').click()
        await expect.poll(async () => (await shownIds(page)).sort()).toEqual(['s-a', 's-lead'])
        await shot(page, 'filter')
        await filterMenu.locator('[data-filter-role="talk"]').click()
        await expect(page.getByTestId('all-sessions-filter-empty')).toBeVisible()
        // Pressing the button again closes the menu (not close-then-reopen).
        await filterButton.click()
        await expect(filterMenu).toHaveCount(0)
        await page.getByTestId('all-sessions-filter-empty').getByRole('button', { name: 'Clear filter' }).click()
        await expect.poll(async () => (await shownIds(page)).length).toBe(4)
        await expect(filterButton).not.toHaveAttribute('data-filter-active', 'true')

        // None clears the role; the store loses the field instead of keeping null.
        await page.locator('[data-session-item="s-a"]').click({ button: 'right' })
        await page.getByTestId('session-menu-role').click()
        await page.getByTestId('session-menu-role-submenu').locator('[data-role-option="none"]').click()
        await expect.poll(() => stored(userDataDir, 's-a') && 'role' in stored(userDataDir, 's-a')!).toBe(false)
        await expect(page.locator('[data-session-item="s-a"] [data-work-role-icon]')).toHaveCount(0)
    })

    test('the Control API and MCP set, clear and filter labels; a bad role is refused and changes nothing', async () => {
        const { page, userDataDir, home, folder } = await launch()
        const discovery = JSON.parse(await (async () => {
            const file = path.join(home, 'control-api.json')
            await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
            return fs.readFileSync(file, 'utf-8')
        })()) as Discovery
        const api = async <T = any>(method: string, route: string, body?: unknown): Promise<{ status: number; json: T }> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't191' },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
        }

        expect((await api<ApiSession>('GET', '/v1/sessions/s-a')).json).toMatchObject({ role: null, tags: [] })
        expect((await api<ApiSession>('GET', '/v1/sessions/s-lead')).json).toMatchObject({ role: 'lead', tags: ['night-1125'] })

        const set = await api<ApiSession>('POST', '/v1/sessions/s-a/labels', { role: 'Work', tags: ['#Night-1125', 'night-1125', ' phone '] })
        expect(set.status).toBe(200)
        expect(set.json).toMatchObject({ role: 'work', tags: ['Night-1125', 'phone'], aiControlled: false })
        expect(stored(userDataDir, 's-a')).toMatchObject({ role: 'work', tags: ['Night-1125', 'phone'] })
        // The sidebar follows without a reload (the API's `updated` event).
        await expect(page.locator('[data-session-item="s-a"] [data-work-role-icon="work"]')).toBeVisible()
        await expect(page.locator('[data-session-item="s-a"]')).not.toHaveAttribute('data-session-role', 'ai')

        // Omitted keys stay: only the tags change.
        expect((await api<ApiSession>('POST', '/v1/sessions/s-a/labels', { tags: ['phone'] })).json).toMatchObject({ role: 'work', tags: ['phone'] })

        const bad = await api<{ error: { code: string } }>('POST', '/v1/sessions/s-a/labels', { role: 'worker', tags: ['x'] })
        expect(bad.status).toBe(400)
        expect(JSON.stringify(bad.json)).toContain('bad_role')
        expect(stored(userDataDir, 's-a')).toMatchObject({ role: 'work', tags: ['phone'] })
        expect((await api('POST', '/v1/sessions/s-a/labels', {})).status).toBe(400)
        expect((await api('POST', '/v1/sessions/s-a/labels', { tags: 'phone' })).status).toBe(400)
        expect((await api('POST', '/v1/sessions/nope/labels', { role: 'work' })).status).toBe(404)

        // Filters, with scope all (none of these is AI-marked).
        const byRole = (await api<ApiSession[]>('GET', '/v1/sessions?scope=all&role=work')).json
        expect(byRole.map(s => s.id)).toEqual(['s-a'])
        const byTag = (await api<ApiSession[]>('GET', '/v1/sessions?scope=all&tag=%23NIGHT-1125')).json
        expect(byTag.map(s => s.id)).toEqual(['s-lead'])
        expect((await api('GET', '/v1/sessions?scope=all&role=bogus')).status).toBe(400)

        // Opening with a role and tags; a bad role opens nothing.
        const before = (await api<ApiSession[]>('GET', '/v1/sessions?scope=all')).json.length
        expect((await api('POST', '/v1/sessions', { path: folder, name: 'T191 bad', role: 'chief' })).status).toBe(400)
        expect((await api<ApiSession[]>('GET', '/v1/sessions?scope=all')).json.length).toBe(before)
        const opened = await api<{ session: ApiSession }>('POST', '/v1/sessions', { path: folder, name: 'T191 watcher', role: 'watch', tags: ['night-1125'] })
        expect(opened.status).toBe(200)
        expect(opened.json.session).toMatchObject({ role: 'watch', tags: ['night-1125'] })
        await expect(page.locator(`[data-session-item="${opened.json.session.id}"] [data-work-role-icon="watch"]`)).toBeVisible()

        // MCP: the tool is listed, clears the role, filters by role.
        let rpc = 0
        const mcp = async (method: string, params: unknown): Promise<any> => JSON.parse(await (await fetch(discovery.mcpUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Client-Name': 't191-mcp' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params })
        })).text())
        const tools = (await mcp('tools/list', {})).result.tools.map((t: { name: string }) => t.name)
        expect(tools).toContain('set_session_labels')
        const call = async (name: string, args: Record<string, unknown>) => (await mcp('tools/call', { name, arguments: args })).result
        const cleared = await call('set_session_labels', { session_id: 's-a', role: null })
        expect(JSON.parse(cleared.content[0].text)).toMatchObject({ role: null, tags: ['phone'] })
        expect((await call('set_session_labels', { session_id: 's-a', role: 'boss' })).isError).toBe(true)
        // Nothing to set is a protocol error (invalid params), not a tool result.
        expect((await mcp('tools/call', { name: 'set_session_labels', arguments: { session_id: 's-a' } })).error).toBeTruthy()
        const listed = JSON.parse((await call('list_sessions', { scope: 'all', role: 'lead' })).content[0].text) as ApiSession[]
        expect(listed.map(s => s.id)).toEqual(['s-lead'])
        await expect(page.locator('[data-session-item="s-a"] [data-work-role-icon]')).toHaveCount(0)
        expect(stored(userDataDir, 's-a')).toEqual(expect.not.objectContaining({ role: expect.anything() }))
    })

    test('without any role or tag the toolbar keeps its buttons; the filter appears once one is set', async () => {
        const { page } = await launch(false)
        await expect(page.getByTestId('all-sessions-new-session')).toBeVisible()
        await expect(page.getByTestId('all-sessions-label-filter')).toHaveCount(0)
        await page.locator('[data-session-item="s-c"]').click({ button: 'right' })
        await page.getByTestId('session-menu-role').click()
        await page.getByTestId('session-menu-role-submenu').locator('[data-role-option="watch"]').click()
        await expect(page.getByTestId('all-sessions-label-filter')).toBeVisible()
    })

    test('labels survive a reorder and an app restart', async () => {
        const { page, userDataDir } = await launch()
        await page.locator('[data-session-item="s-b"]').click({ button: 'right' })
        await page.getByTestId('session-menu-role').click()
        await page.getByTestId('session-menu-role-submenu').locator('[data-role-option="talk"]').click()
        await page.locator('[data-session-item="s-b"]').click({ button: 'right' })
        await page.getByTestId('session-menu-edit-tags').click()
        await page.locator('[data-session-labels-dialog] [data-labels-tag-input]').fill('planning')
        await page.locator('[data-session-labels-dialog] [data-labels-save]').click()
        await expect.poll(() => stored(userDataDir, 's-b')).toMatchObject({ role: 'talk', tags: ['planning'] })
        // A reorder writes the workspace's session list again; the labels must ride along.
        await page.evaluate(() => window.api.reorderSessions('ws-t191', ['s-c', 's-b', 's-a', 's-lead']))
        expect(stored(userDataDir, 's-b')).toMatchObject({ role: 'talk', tags: ['planning'] })

        // closeApp deletes userData; the relaunch needs it.
        await ctx!.app.close()
        dirs.push(userDataDir)
        ctx!.userDataDir = path.join(userDataDir, '..', 'climanger-t191-unused')
        ctx = undefined
        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: { ...process.env, CLIMANGER_TEST_USERDATA: userDataDir, CLIMANGER_TERM_DEBUG: '1', CLIMANGER_TEST_HEADLESS: '1' } as Record<string, string>
        })
        const again = await relaunched.firstWindow()
        await expect(again.getByTestId('sidebar-all-sessions')).toBeVisible({ timeout: 30_000 })
        await expect(again.locator('[data-session-item="s-b"] [data-work-role-icon="talk"]')).toBeVisible()
        await expect(again.locator('[data-session-item="s-b"] [data-session-tags-text]')).toHaveText(' · #planning')
        expect(stored(userDataDir, 's-b')).toMatchObject({ role: 'talk', tags: ['planning'] })
    })

    test('while filtering, empty session folders are not drawn and hidden rows leave the pick', async () => {
        const { page } = await launch(true, true)
        // s-a sits in "Work folder", s-c in "Other folder"; give s-a the Work role.
        await page.locator('[data-session-item="s-a"]').click({ button: 'right' })
        await page.getByTestId('session-menu-role').click()
        await page.getByTestId('session-menu-role-submenu').locator('[data-role-option="work"]').click()
        await expect(page.getByTestId('session-folder-header-sf-other')).toBeVisible()

        // Pick two rows, then filter to Work: the hidden one leaves the pick.
        for (const id of ['s-a', 's-c']) {
            await page.locator(`[data-session-item="${id}"]`).hover()
            await page.locator(`[data-session-select="${id}"]`).check()
        }
        await expect(page.getByTestId('session-selection-count')).toHaveText('2 selected')
        await page.getByTestId('all-sessions-label-filter').click()
        await page.getByTestId('all-sessions-label-filter-menu').locator('[data-filter-role="work"]').click()
        await page.keyboard.press('Escape')
        await expect.poll(() => shownIds(page)).toEqual(['s-a'])
        await expect(page.getByTestId('session-folder-header-sf-work')).toBeVisible()
        await expect(page.getByTestId('session-folder-header-sf-other')).toHaveCount(0)
        await expect(page.getByTestId('session-selection-count')).toHaveText('1 selected')
    })
})
