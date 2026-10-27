import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'

/**
 * T60 — Session folders through the Control API (REST and MCP).
 *
 * List, create (the same name gives back the folder that exists), rename (409 on
 * a taken name), put in, take out, delete (sessions stay open), open straight
 * into a folder, and `sessionFolder` on every session. The sidebar's All
 * sessions view must follow without a reload: judged in the DOM, and in
 * config.json for what was stored.
 */

interface Discovery {
    url: string
    mcpUrl: string
    token: string
}
interface Folder {
    id: string
    name: string
    createdAt: string
    sessions: Array<{ id: string; name: string; workspaceName: string }>
}
interface ApiSession {
    id: string
    sessionFolder: { id: string; name: string } | null
    aiControlled: boolean
}

test.describe('T60 Control API session folders', () => {
    let ctx: LaunchResult | undefined
    const dirs: string[] = []
    const dir = (prefix: string): string => {
        const made = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        dirs.push(made)
        return made
    }
    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const made of dirs.splice(0)) fs.rmSync(made, { recursive: true, force: true })
    })

    test('folders are listed, made, renamed, filled, emptied and deleted, and the sidebar follows', async () => {
        const home = dir('climanger-t60-home-')
        const folder = dir('climanger-t60-ws-')
        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-t60', name: 'T60WS', path: folder, sessions: [{ id: 's-a', name: 'T60A' }, { id: 's-b', name: 'T60B' }] }],
            {
                settings: { showHomeWorkspace: false, showSessionCount: true, controlApi: { enabled: true, port: 0 } },
                env: { CLIMANAGER_HOME: home },
                config: { sessionFolders: [{ id: 'sf-old', name: 'T60 Old', isExpanded: true, createdAt: 1000 }] }
            }
        )
        const { page, userDataDir } = ctx
        const discoveryPath = path.join(home, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as Discovery
        const api = async <T = any>(method: string, route: string, body?: unknown): Promise<{ status: number; json: T }> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't60' },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
        }
        const stored = (): Array<{ id: string; name: string }> => JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).sessionFolders ?? []

        await page.getByTestId('sidebar-view-toggle').click()
        await expect(page.locator('[data-session-item="s-a"]')).toBeVisible()
        await expect(page.getByTestId('session-folder-header-sf-old')).toBeVisible()

        // --- list: stored order, ISO time, no sessions yet -------------------
        const listed = await api<{ folders: Folder[] }>('GET', '/v1/session-folders')
        expect(listed.status).toBe(200)
        expect(listed.json.folders).toEqual([{ id: 'sf-old', name: 'T60 Old', createdAt: new Date(1000).toISOString(), sessions: [] }])

        // --- create: 201 once, then the same folder with created:false --------
        const made = await api<{ folder: Folder; created: boolean }>('POST', '/v1/session-folders', { name: '  T60 Ship ' })
        expect(made.status, JSON.stringify(made.json)).toBe(201)
        expect(made.json.created).toBe(true)
        expect(made.json.folder.name).toBe('T60 Ship')
        const shipId = made.json.folder.id
        const again = await api<{ folder: Folder; created: boolean }>('POST', '/v1/session-folders', { name: 't60 SHIP' })
        expect(again.status).toBe(200)
        expect(again.json).toMatchObject({ created: false, folder: { id: shipId } })
        expect(stored().map((f) => f.name)).toEqual(['T60 Old', 'T60 Ship'])
        expect((await api('POST', '/v1/session-folders', { name: '   ' })).status).toBe(400)
        // The window shows it without a reload.
        await expect(page.getByTestId(`session-folder-header-${shipId}`)).toBeVisible({ timeout: 5_000 })

        // --- rename: a taken name is 409, the rest works --------------------
        expect((await api('POST', `/v1/session-folders/${shipId}/rename`, { name: 'T60 old' })).status).toBe(409)
        expect((await api('POST', `/v1/session-folders/${shipId}/rename`, { name: ' ' })).status).toBe(400)
        expect((await api('POST', '/v1/session-folders/no-such/rename', { name: 'x' })).status).toBe(404)
        const renamed = await api<Folder>('POST', '/v1/session-folders/T60%20Ship/rename', { name: 'T60 Release' })
        expect(renamed.status, JSON.stringify(renamed.json)).toBe(200)
        expect(renamed.json.name).toBe('T60 Release')
        await expect(page.getByTestId(`session-folder-header-${shipId}`)).toContainText('T60 Release', { timeout: 5_000 })

        // --- put in / take out: the session answers with its folder ----------
        const body = page.locator(`[data-session-folder-body="${shipId}"]`)
        const put = await api<ApiSession>('POST', '/v1/sessions/s-a/session-folder', { folder: 't60 release' })
        expect(put.status, JSON.stringify(put.json)).toBe(200)
        expect(put.json.sessionFolder).toEqual({ id: shipId, name: 'T60 Release' })
        expect(put.json.aiControlled, 'a label change does not mark the session as AI-driven').toBe(false)
        await expect(body.locator('[data-session-item="s-a"]')).toBeVisible({ timeout: 5_000 })
        await expect(page.locator(`[data-session-folder-count="${shipId}"]`)).toHaveText('(1)')
        expect((await api('POST', '/v1/sessions/s-a/session-folder', { folder: 'nope' })).status).toBe(404)
        expect((await api('POST', '/v1/sessions/s-a/session-folder', {})).status).toBe(400)
        expect((await api('POST', '/v1/sessions/no-session/session-folder', { folder: shipId })).status).toBe(404)
        expect((await api<ApiSession>('GET', '/v1/sessions/s-b')).json.sessionFolder).toBeNull()
        const out = await api<ApiSession>('POST', '/v1/sessions/s-a/session-folder', { folder: null })
        expect(out.json.sessionFolder).toBeNull()
        await expect(page.locator(`[data-session-folder-count="${shipId}"]`)).toHaveText('(0)', { timeout: 5_000 })

        // --- open straight into a folder (id, name, or a new name) ------------
        const opened = await api<{ session: ApiSession }>('POST', '/v1/sessions', { path: folder, name: 'T60OPENED', sessionFolder: shipId })
        expect(opened.status, JSON.stringify(opened.json)).toBe(200)
        expect(opened.json.session.sessionFolder?.id).toBe(shipId)
        await expect(body.locator(`[data-session-item="${opened.json.session.id}"]`)).toBeVisible({ timeout: 5_000 })
        const fresh = await api<{ session: ApiSession }>('POST', '/v1/sessions', { path: folder, name: 'T60FRESH', sessionFolder: 'T60 Brand New' })
        expect(fresh.json.session.sessionFolder?.name).toBe('T60 Brand New')
        expect(stored().filter((f) => f.name === 'T60 Brand New')).toHaveLength(1)
        await expect(page.getByText('T60 Brand New', { exact: true })).toBeVisible({ timeout: 5_000 })

        // --- two folders with one name: by name it is ambiguous --------------
        // (the window lets the user make such a pair; seed it through the same IPC the sidebar uses)
        await page.evaluate(() => window.api.createSessionFolder('T60 Twin'))
        await page.evaluate(() => window.api.createSessionFolder('t60 twin'))
        expect((await api('POST', '/v1/sessions/s-b/session-folder', { folder: 'T60 Twin' })).json).toMatchObject({ error: { code: 'ambiguous_folder' } })

        // --- delete: the folder goes, the sessions stay --------------------
        const openedId = opened.json.session.id
        const removed = await api<{ removed: boolean; releasedSessions: number }>('DELETE', `/v1/session-folders/${shipId}`)
        expect(removed.json).toEqual({ removed: true, releasedSessions: 1 })
        expect(stored().some((f) => f.id === shipId)).toBe(false)
        expect((await api<ApiSession>('GET', `/v1/sessions/${openedId}`)).json.sessionFolder).toBeNull()
        await expect(page.getByTestId(`session-folder-header-${shipId}`)).toHaveCount(0, { timeout: 5_000 })
        await expect(page.locator(`[data-session-item="${openedId}"]`)).toBeVisible()
        expect((await api('DELETE', `/v1/session-folders/${shipId}`)).status).toBe(404)

        // --- MCP -------------------------------------------------------------
        let rpc = 0
        const call = async (name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> => {
            const res = await fetch(discovery.mcpUrl, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${discovery.token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'X-Client-Name': 't60-mcp'
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } })
            })
            const json = JSON.parse(await res.text())
            return { isError: json.result?.isError, text: json.result?.content?.[0]?.text ?? JSON.stringify(json) }
        }
        const tools = JSON.parse(
            await (await fetch(discovery.mcpUrl, {
                method: 'POST',
                headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' })
            })).text()
        ).result.tools.map((t: { name: string }) => t.name)
        for (const name of ['list_session_folders', 'create_session_folder', 'rename_session_folder', 'delete_session_folder', 'move_session_to_folder']) {
            expect(tools).toContain(name)
        }
        const mcpMade = JSON.parse((await call('create_session_folder', { name: 'T60 Mcp' })).text)
        expect(mcpMade.created).toBe(true)
        expect(JSON.parse((await call('create_session_folder', { name: 'T60 MCP' })).text)).toMatchObject({ created: false })
        expect((await call('rename_session_folder', { folder: 'T60 Mcp', name: 'T60 Old' })).isError).toBe(true)
        expect(JSON.parse((await call('rename_session_folder', { folder: 'T60 Mcp', name: 'T60 Mcp 2' })).text).name).toBe('T60 Mcp 2')
        const moved = JSON.parse((await call('move_session_to_folder', { session_id: 's-b', folder: 'T60 Mcp 2' })).text)
        expect(moved.sessionFolder.name).toBe('T60 Mcp 2')
        expect(JSON.parse((await call('list_session_folders', {})).text).folders.find((f: Folder) => f.name === 'T60 Mcp 2').sessions[0].id).toBe('s-b')
        expect(JSON.parse((await call('move_session_to_folder', { session_id: 's-b', folder: null })).text).sessionFolder).toBeNull()
        const mcpOpen = JSON.parse((await call('open_session', { path: folder, name: 'T60MCPOPEN', session_folder: 'T60 Mcp 2' })).text)
        expect(mcpOpen.session.sessionFolder.name).toBe('T60 Mcp 2')
        expect(JSON.parse((await call('delete_session_folder', { folder: 'T60 Mcp 2' })).text)).toEqual({ removed: true, releasedSessions: 1 })
    })
})
