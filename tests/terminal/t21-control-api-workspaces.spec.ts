import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'

/**
 * T21 — AI Control API keeps the sidebar tidy.
 *
 * Folders an AI opens used to pile up at the top level of the sidebar until
 * someone deleted them by hand. Now a new registration lands in a sidebar
 * folder, is marked as AI-registered, can be unregistered by the API (never
 * the user's own), and an ephemeral one leaves with its last session.
 *
 * Checked at the ends: the sidebar from the DOM (which folder a workspace row
 * sits in), persistence from config.json, and that the folder on disk survives.
 */

const EXISTING_FOLDER = { id: 'f-t21-existing', name: 'T21EXISTING', isExpanded: true, createdAt: 1700000000000 }
const DEFAULT_FOLDER_NAME = 'AI Work'

interface Discovery {
    url: string
    mcpUrl: string
    token: string
}

interface ApiWorkspace {
    id: string
    path: string
    sessionCount: number
    folder: { id: string; name: string } | null
    registeredBy: 'ai' | 'user'
    registeredByClient: string
    ephemeral: boolean
}

interface OpenResult {
    session: { id: string; workspaceId: string }
    workspace: ApiWorkspace
    createdWorkspace: boolean
    createdFolder: boolean
    terminalStarted: boolean
    note?: string
}

interface StoredConfig {
    workspaces: Array<{ id: string; folderId?: string; aiRegistration?: { client: string; ephemeral?: boolean } }>
    folders?: Array<{ id: string; name: string }>
}

test.describe('T21 Control API workspace cleanup', () => {
    let ctx: LaunchResult
    const tempDirs: string[] = []
    const tempDir = (prefix: string): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        tempDirs.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('AI registrations go into a folder, unregister only themselves, and ephemeral ones leave with their last session', async () => {
        const climanagerHome = tempDir('climanger-t21-home-')
        const userFolder = tempDir('climanger-t21-user-')
        const leftoverFolder = tempDir('climanger-t21-leftover-')
        const defaultFolderDir = tempDir('climanger-t21-default-')
        const byIdDir = tempDir('climanger-t21-byid-')
        const newFolderDir = tempDir('climanger-t21-newfolder-')
        const topLevelDir = tempDir('climanger-t21-top-')
        const ephemeralDir = tempDir('climanger-t21-ephemeral-')
        const mcpDir = tempDir('climanger-t21-mcp-')
        const afterSettingDir = tempDir('climanger-t21-setting-')

        ctx = await launchAppWithWorkspaces(
            [
                // An old-format workspace: no aiRegistration, so it counts as the user's.
                { id: 'ws-user', name: 'T21USER', path: userFolder, sessions: [{ id: 's-t21-user', name: 'T21USERSESS' }] },
                // An ephemeral registration the app quit before cleaning up.
                {
                    id: 'ws-leftover',
                    name: 'T21LEFTOVER',
                    path: leftoverFolder,
                    sessions: [],
                    aiRegistration: { client: 'old', since: 1700000000000, ephemeral: true }
                }
            ],
            {
                // controlApi without aiFolderName: an existing user's settings, which default to DEFAULT_FOLDER_NAME.
                settings: { controlApi: { enabled: true, port: 0 } },
                folders: [EXISTING_FOLDER],
                env: { CLIMANAGER_HOME: climanagerHome }
            }
        )
        const { page, userDataDir } = ctx

        const discoveryPath = path.join(climanagerHome, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as Discovery

        const api = async <T = unknown>(method: string, route: string, body?: unknown): Promise<{ status: number; json: T }> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: {
                    Authorization: `Bearer ${discovery.token}`,
                    'Content-Type': 'application/json',
                    'X-Client-Name': 't21'
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
        }
        const mcpCall = async (name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> => {
            const res = await fetch(discovery.mcpUrl, {
                method: 'POST',
                headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
            })
            const json = await res.json()
            return { isError: json.result.isError, text: json.result.content[0].text }
        }
        const stored = (): StoredConfig => JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
        const workspaceRow = (id: string) => page.locator(`[data-workspace-item="${id}"]`)

        // --- Startup sweep: a spent ephemeral registration is gone ------------
        await workspaceRow('ws-user').waitFor({ timeout: 15_000 })
        await expect(workspaceRow('ws-leftover')).toHaveCount(0)
        expect(stored().workspaces.map(w => w.id)).not.toContain('ws-leftover')

        // --- List: an old-format workspace is the user's ----------------------
        const initial = await api<ApiWorkspace[]>('GET', '/v1/workspaces?query=t21user')
        expect(initial.json).toHaveLength(1)
        expect(initial.json[0]).toMatchObject({ id: 'ws-user', registeredBy: 'user', registeredByClient: '', ephemeral: false, folder: null })

        // --- Open, no folder given: the default folder is created and used ---
        const byDefault = await api<OpenResult>('POST', '/v1/sessions', { path: defaultFolderDir, command: 'echo T21', name: 'T21DEFAULT' })
        expect(byDefault.status, JSON.stringify(byDefault.json)).toBe(200)
        expect(byDefault.json.createdWorkspace).toBe(true)
        expect(byDefault.json.createdFolder).toBe(true)
        expect(byDefault.json.workspace).toMatchObject({ registeredBy: 'ai', registeredByClient: 't21', ephemeral: false })
        expect(byDefault.json.workspace.folder?.name).toBe(DEFAULT_FOLDER_NAME)
        const defaultFolderId = byDefault.json.workspace.folder!.id
        const defaultWs = byDefault.json.session.workspaceId
        await expectInFolder(page, defaultWs, defaultFolderId)
        await expect(page.locator(`[data-testid="folder-header-${defaultFolderId}"]`)).toContainText(DEFAULT_FOLDER_NAME)
        expect(stored().folders?.find(f => f.id === defaultFolderId)?.name).toBe(DEFAULT_FOLDER_NAME)
        const storedDefault = stored().workspaces.find(w => w.id === defaultWs)
        expect(storedDefault?.folderId).toBe(defaultFolderId)
        expect(storedDefault?.aiRegistration?.client).toBe('t21')

        // --- Open into an existing folder by id ------------------------------
        const byId = await api<OpenResult>('POST', '/v1/sessions', { path: byIdDir, command: 'echo T21', folder: EXISTING_FOLDER.id })
        expect(byId.json.createdFolder).toBe(false)
        expect(byId.json.workspace.folder).toEqual({ id: EXISTING_FOLDER.id, name: EXISTING_FOLDER.name })
        await expectInFolder(page, byId.json.session.workspaceId, EXISTING_FOLDER.id)

        // --- A new name creates that folder; a name match is case-insensitive -
        const byNewName = await api<OpenResult>('POST', '/v1/sessions', { path: newFolderDir, command: 'echo T21', folder: 'T21NEWGROUP' })
        expect(byNewName.json.createdFolder).toBe(true)
        expect(byNewName.json.workspace.folder?.name).toBe('T21NEWGROUP')
        await expectInFolder(page, byNewName.json.session.workspaceId, byNewName.json.workspace.folder!.id)
        expect(stored().folders?.filter(f => f.name === 'T21NEWGROUP')).toHaveLength(1)

        // --- '' is the top level ---------------------------------------------
        const topLevel = await api<OpenResult>('POST', '/v1/sessions', { path: topLevelDir, command: 'echo T21', folder: '' })
        expect(topLevel.json.workspace.folder).toBeNull()
        await workspaceRow(topLevel.json.session.workspaceId).waitFor({ timeout: 10_000 })
        await expect(page.locator(`[data-folder-body] [data-workspace-item="${topLevel.json.session.workspaceId}"]`)).toHaveCount(0)

        // --- The user's workspace is never moved or flagged ------------------
        const intoUser = await api<OpenResult>('POST', '/v1/sessions', { path: userFolder, command: 'echo T21', folder: 'T21NEWGROUP', ephemeral: true })
        expect(intoUser.json.createdWorkspace).toBe(false)
        expect(intoUser.json.note).toContain('ignored')
        expect(intoUser.json.workspace).toMatchObject({ id: 'ws-user', registeredBy: 'user', ephemeral: false, folder: null })
        expect(stored().workspaces.find(w => w.id === 'ws-user')?.folderId).toBeUndefined()

        // --- Unregister: the user's is refused, open sessions block ----------
        const refused = await api<{ error: { code: string } }>('DELETE', '/v1/workspaces/ws-user')
        expect(refused.status).toBe(403)
        expect(refused.json.error.code).toBe('not_ai_registered')
        expect((await api('DELETE', '/v1/workspaces/no-such-workspace')).status).toBe(404)
        const busy = await api<{ error: { code: string } }>('DELETE', `/v1/workspaces/${defaultWs}`)
        expect(busy.status).toBe(409)
        expect(busy.json.error.code).toBe('has_sessions')
        // Closing the user's last session must not remove their (non-ephemeral) workspace.
        expect((await api('DELETE', `/v1/sessions/${intoUser.json.session.id}`)).status).toBe(200)
        expect((await api('DELETE', '/v1/sessions/s-t21-user')).status).toBe(200)
        await expect(workspaceRow('ws-user')).toHaveCount(1)
        expect(stored().workspaces.map(w => w.id)).toContain('ws-user')

        // --- Close then unregister: gone from the sidebar, files intact -------
        expect((await api('DELETE', `/v1/sessions/${byDefault.json.session.id}`)).status).toBe(200)
        expect((await api('DELETE', `/v1/workspaces/${defaultWs}`)).status).toBe(200)
        await expect(workspaceRow(defaultWs)).toHaveCount(0, { timeout: 5_000 })
        expect(stored().workspaces.map(w => w.id)).not.toContain(defaultWs)
        expect(fs.existsSync(defaultFolderDir)).toBe(true)
        expect((await api('DELETE', `/v1/workspaces/${defaultWs}`)).status).toBe(404)

        // --- Ephemeral: survives while any session is open --------------------
        const eph1 = await api<OpenResult>('POST', '/v1/sessions', { path: ephemeralDir, command: 'echo T21', ephemeral: true, name: 'T21EPH1' })
        expect(eph1.json.workspace.ephemeral).toBe(true)
        const ephWs = eph1.json.session.workspaceId
        await workspaceRow(ephWs).waitFor({ timeout: 10_000 })
        const eph2 = await api<OpenResult>('POST', '/v1/sessions', { path: ephemeralDir, command: 'echo T21', name: 'T21EPH2' })
        expect(eph2.json.createdWorkspace).toBe(false)
        expect(eph2.json.session.workspaceId).toBe(ephWs)
        const listed = await api<ApiWorkspace[]>('GET', `/v1/workspaces?query=${encodeURIComponent(path.basename(ephemeralDir))}`)
        expect(listed.json[0]).toMatchObject({ id: ephWs, ephemeral: true, registeredBy: 'ai', sessionCount: 2 })

        expect((await api('DELETE', `/v1/sessions/${eph1.json.session.id}`)).status).toBe(200)
        await expect(page.locator(`[data-session-item="${eph1.json.session.id}"]`)).toHaveCount(0, { timeout: 5_000 })
        await expect(workspaceRow(ephWs)).toHaveCount(1)

        // The last session closed the way the user closes one: the sidebar IPC.
        await page.evaluate(
            ([ws, id]) =>
                (window as unknown as { api: { removeSession: (w: string, s: string) => Promise<boolean> } }).api.removeSession(ws, id),
            [ephWs, eph2.json.session.id]
        )
        await expect(workspaceRow(ephWs)).toHaveCount(0, { timeout: 5_000 })
        expect(stored().workspaces.map(w => w.id)).not.toContain(ephWs)
        expect(fs.existsSync(ephemeralDir)).toBe(true)

        // --- MCP: same rules -------------------------------------------------
        const toolsRes = await fetch(discovery.mcpUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        })
        const tools = (await toolsRes.json()).result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>
        expect(tools.map(t => t.name)).toContain('unregister_workspace')
        expect(Object.keys(tools.find(t => t.name === 'open_session')!.inputSchema.properties)).toEqual(
            expect.arrayContaining(['folder', 'ephemeral'])
        )
        const mcpRefused = await mcpCall('unregister_workspace', { workspace_id: 'ws-user' })
        expect(mcpRefused.isError).toBe(true)
        expect(mcpRefused.text).toContain('not_ai_registered')

        const mcpOpened = JSON.parse((await mcpCall('open_session', { path: mcpDir, command: 'echo T21', ephemeral: true, folder: 't21existing' })).text) as OpenResult
        expect(mcpOpened.workspace.folder?.id).toBe(EXISTING_FOLDER.id)
        expect(mcpOpened.workspace.ephemeral).toBe(true)
        await expectInFolder(page, mcpOpened.session.workspaceId, EXISTING_FOLDER.id)
        expect((await mcpCall('close_session', { session_id: mcpOpened.session.id })).isError).toBeFalsy()
        await expect(workspaceRow(mcpOpened.session.workspaceId)).toHaveCount(0, { timeout: 5_000 })

        expect((await api('DELETE', `/v1/sessions/${byNewName.json.session.id}`)).status).toBe(200)
        const mcpUnregistered = await mcpCall('unregister_workspace', { workspace_id: byNewName.json.session.workspaceId })
        expect(mcpUnregistered.isError, mcpUnregistered.text).toBeFalsy()
        await expect(workspaceRow(byNewName.json.session.workspaceId)).toHaveCount(0, { timeout: 5_000 })

        // --- Clearing the setting: top level, and the server is not restarted -
        await page.evaluate(() => {
            const w = window as unknown as { api: { setControlApi: (s: unknown) => Promise<unknown> } }
            return w.api.setControlApi({ enabled: true, port: 0, aiFolderName: '' })
        })
        // port 0 picks a new port on every start, so a restart would move the URL.
        expect((await api('GET', '/v1/health')).status).toBe(200)
        const afterSetting = await api<OpenResult>('POST', '/v1/sessions', { path: afterSettingDir, command: 'echo T21' })
        expect(afterSetting.json.createdWorkspace).toBe(true)
        expect(afterSetting.json.workspace.folder).toBeNull()

        expect(ctx.pageErrors).toEqual([])
    })
})

/** The workspace row is rendered inside that folder's body in the sidebar. */
async function expectInFolder(page: Page, workspaceId: string, folderId: string): Promise<void> {
    await expect(page.locator(`[data-folder-body="${folderId}"] [data-workspace-item="${workspaceId}"]`)).toHaveCount(1, { timeout: 10_000 })
}
