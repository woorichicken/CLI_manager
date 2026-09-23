import { test, expect } from '@playwright/test'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T15 — AI Control API, end to end against the built app.
 *
 * An AI opens a session in a folder the app has never seen, runs a template in
 * it, submits prompts, waits for the "agent" to finish and reads the screen —
 * while the session shows up in the sidebar, green, and the user can take it
 * back. The agent is scripts/mock-cli/agent-mock.cjs: a raw-mode TUI with a
 * spinner that says "esc to interrupt", bracketed paste and an approval prompt,
 * which is exactly the surface the API's busy/idle and input logic depends on.
 *
 * Checked at the ends, not in the middle: what reached the program is read
 * from what the program printed (ANSWER[n]: …), the sidebar from the DOM, and
 * persistence from config.json on disk.
 */

const AGENT_WORK_MS = 1500
const TEMPLATE = {
    id: 'tpl-agent-mock',
    name: 'agent-mock',
    icon: 'terminal',
    description: 'Test agent',
    command: `node ${path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')} --work-ms ${AGENT_WORK_MS}`
}
const USER_SESSION_ID = 's-user-owned'

interface Discovery {
    url: string
    mcpUrl: string
    token: string
}

interface ApiSession {
    id: string
    name: string
    state: string
    awaitingInput: boolean
    workspaceId: string
    controlledBy: string
}

test.describe('T15 AI Control API', () => {
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

    test('an AI opens, drives and hands back a session the user can watch', async () => {
        const climanagerHome = tempDir('climanger-t15-home-')
        const userFolder = tempDir('climanger-t15-user-')
        const aiFolder = tempDir('climanger-t15-ai-')

        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-user', name: 'T15USER', path: userFolder, sessions: [{ id: USER_SESSION_ID, name: 'T15USERSESS' }] }],
            {
                settings: { controlApi: { enabled: true, port: 0 } },
                customTemplates: [TEMPLATE],
                env: { CLIMANAGER_HOME: climanagerHome }
            }
        )
        const { page, userDataDir } = ctx

        // --- Discovery file: written, owner-only ---------------------------
        const discoveryPath = path.join(climanagerHome, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        expect(fs.statSync(discoveryPath).mode & 0o777).toBe(0o600)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as Discovery
        expect(discovery.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

        const api = async <T = unknown>(method: string, route: string, body?: unknown): Promise<{ status: number; json: T }> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: {
                    Authorization: `Bearer ${discovery.token}`,
                    'Content-Type': 'application/json',
                    'X-Client-Name': 't15'
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
        }

        // --- Guards: token, Host, Origin -----------------------------------
        expect((await fetch(discovery.url + '/v1/health')).status).toBe(401)
        expect((await fetch(discovery.url + '/v1/health', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
        expect(await rawStatus(discovery, { host: 'evil.example:80' })).toBe(403)
        expect(await rawStatus(discovery, { origin: 'https://evil.example' })).toBe(403)
        expect((await api('GET', '/v1/health')).status).toBe(200)

        // --- Templates and workspaces are readable -------------------------
        const templates = await api<Array<{ name: string }>>('GET', '/v1/templates')
        expect(templates.json.map(t => t.name)).toContain('agent-mock')

        // --- The user's own session is out of reach ------------------------
        const denied = await api<{ error: { code: string } }>('POST', `/v1/sessions/${USER_SESSION_ID}/input`, { text: 'rm -rf /' })
        expect(denied.status).toBe(403)
        expect(denied.json.error.code).toBe('not_controlled')

        // --- Open: new folder + template + first prompt --------------------
        const opened = await api<{ session: ApiSession; createdWorkspace: boolean; terminalStarted: boolean; promptSent: boolean; note?: string }>(
            'POST', '/v1/sessions',
            { path: aiFolder, template: 'agent-mock', name: 'T15AISESS', prompt: 'hello world' }
        )
        expect(opened.status, JSON.stringify(opened.json)).toBe(200)
        expect(opened.json.createdWorkspace).toBe(true)
        expect(opened.json.terminalStarted).toBe(true)
        expect(opened.json.promptSent, opened.json.note).toBe(true)
        expect(opened.json.session.controlledBy).toBe('t15')
        const sessionId = opened.json.session.id

        // Sidebar: the session exists, in green, under the new workspace.
        await page.getByText(path.basename(aiFolder)).first().waitFor({ timeout: 15_000 })
        const aiRow = page.locator(`[data-session-item="${sessionId}"]`)
        await aiRow.waitFor({ timeout: 15_000 })
        await expect(aiRow).toContainText('T15AISESS')
        await expect(aiRow).toHaveClass(/emerald/)
        await expect(page.locator(`[data-session-item="${USER_SESSION_ID}"]`)).not.toHaveClass(/emerald/)

        // Persisted: the flag survives a restart.
        const stored = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
        const storedSession = stored.workspaces.flatMap((w: { sessions: Array<{ id: string; aiControl?: { client: string } }> }) => w.sessions)
            .find((s: { id: string }) => s.id === sessionId)
        expect(storedSession?.aiControl?.client).toBe('t15')

        // --- Wait: settles only after the agent finished -------------------
        const first = await api<{ lines: string[]; timedOut: boolean; session: ApiSession }>(
            'POST', `/v1/sessions/${sessionId}/wait`, { timeoutMs: 30_000 }
        )
        expect(first.json.timedOut).toBe(false)
        expect(first.json.session.state).toBe('idle')
        expect(first.json.lines.join('\n')).toContain('ANSWER[1]: hello world')

        // --- Busy is visible while the agent works -------------------------
        await api('POST', `/v1/sessions/${sessionId}/input`, { text: 'second prompt' })
        await expect.poll(
            async () => (await api<ApiSession>('GET', `/v1/sessions/${sessionId}`)).json.state,
            { timeout: 5_000, intervals: [100] }
        ).toBe('busy')
        const second = await api<{ lines: string[]; timedOut: boolean }>('POST', `/v1/sessions/${sessionId}/wait`, { timeoutMs: 30_000 })
        expect(second.json.timedOut).toBe(false)
        const secondScreen = second.json.lines.join('\n')
        expect(secondScreen).toContain('ANSWER[2]: second prompt')
        expect(secondScreen).not.toContain('esc to interrupt')

        // --- Multi-line text arrives as ONE prompt (bracketed paste) -------
        await api('POST', `/v1/sessions/${sessionId}/input`, { text: 'line one\nline two\nline three' })
        const paste = await api<{ lines: string[] }>('POST', `/v1/sessions/${sessionId}/wait`, { timeoutMs: 30_000 })
        expect(paste.json.lines.join('\n')).toContain('ANSWER[3]: lines=3')
        expect(paste.json.lines.join('\n')).not.toContain('ANSWER[4]')

        // --- A question is reported, and answered with a key ---------------
        await api('POST', `/v1/sessions/${sessionId}/input`, { text: 'ASK' })
        const asked = await api<{ session: ApiSession; lines: string[] }>('POST', `/v1/sessions/${sessionId}/wait`, { timeoutMs: 30_000 })
        expect(asked.json.session.awaitingInput).toBe(true)
        // Text now would hit Enter on the highlighted option, so it is refused.
        const blind = await api<{ error: { code: string } }>('POST', `/v1/sessions/${sessionId}/input`, { text: 'a new task' })
        expect(blind.status).toBe(409)
        expect(blind.json.error.code).toBe('awaiting_input')
        await api('POST', `/v1/sessions/${sessionId}/input`, { keys: ['1'] })
        const approved = await api<{ session: ApiSession; lines: string[] }>('POST', `/v1/sessions/${sessionId}/wait`, { timeoutMs: 30_000 })
        expect(approved.json.lines.join('\n')).toContain('APPROVED')
        expect(approved.json.session.awaitingInput).toBe(false)

        // --- MCP: handshake, tools, and the same access rule --------------
        const mcp = async (body: unknown): Promise<{ status: number; json: any }> => {
            const res = await fetch(discovery.mcpUrl, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${discovery.token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify(body)
            })
            const text = await res.text()
            return { status: res.status, json: text ? JSON.parse(text) : null }
        }
        const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't15', version: '1' } } })
        expect(init.json.result.protocolVersion).toBe('2025-06-18')
        expect(init.json.result.capabilities.tools).toBeTruthy()
        expect((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
        const tools = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        expect(tools.json.result.tools.map((t: { name: string }) => t.name)).toEqual(
            expect.arrayContaining(['open_session', 'send_input', 'wait_for_idle', 'read_output', 'close_session'])
        )
        const read = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_output', arguments: { session_id: sessionId, mode: 'tail', lines: 200 } } })
        expect(read.json.result.isError).toBeFalsy()
        expect(read.json.result.content[0].text).toContain('ANSWER[1]: hello world')
        const mcpDenied = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_output', arguments: { session_id: USER_SESSION_ID } } })
        expect(mcpDenied.json.result.isError).toBe(true)
        expect(mcpDenied.json.result.content[0].text).toContain('not_controlled')

        // --- The user takes the session back from the sidebar -------------
        await aiRow.click({ button: 'right' })
        await page.getByText('Disconnect AI').click()
        await expect(aiRow).not.toHaveClass(/emerald/, { timeout: 5_000 })
        const afterRelease = await api<{ error: { code: string } }>('POST', `/v1/sessions/${sessionId}/input`, { text: 'still there?' })
        expect(afterRelease.status).toBe(403)
        // Released, not closed: the terminal is still in the app.
        await expect(aiRow).toHaveCount(1)

        // --- A shell that exits on its own is reported as exited ----------
        const quitter = await api<{ session: ApiSession }>('POST', '/v1/sessions', { path: aiFolder, command: 'exit', name: 'T15EXIT' })
        await expect.poll(
            async () => (await api<ApiSession>('GET', `/v1/sessions/${quitter.json.session.id}`)).json.state,
            { timeout: 15_000 }
        ).toBe('exited')
        const toDead = await api<{ error: { code: string } }>('POST', `/v1/sessions/${quitter.json.session.id}/input`, { text: 'hello' })
        expect(toDead.status).toBe(409)
        expect(toDead.json.error.code).toBe('exited')

        // --- Close: a session the API opened can be removed by it ---------
        const temp = await api<{ session: ApiSession }>('POST', '/v1/sessions', { path: aiFolder, command: 'echo T15CLOSE', name: 'T15CLOSESESS', focus: true })
        expect(temp.status).toBe(200)
        const closeRow = page.locator(`[data-session-item="${temp.json.session.id}"]`)
        await closeRow.waitFor({ timeout: 15_000 })
        // focus: true selected it, so its terminal shows the AI badge.
        await expect(page.locator(`[data-ai-badge="${temp.json.session.id}"]`)).toBeVisible({ timeout: 5_000 })
        expect((await api('DELETE', `/v1/sessions/${temp.json.session.id}`)).status).toBe(200)
        await expect(closeRow).toHaveCount(0, { timeout: 5_000 })
        expect((await api('GET', `/v1/sessions/${temp.json.session.id}`)).status).toBe(404)

        expect(ctx.pageErrors).toEqual([])
    })
})

/** fetch() cannot forge Host; a raw request can, which is what a DNS-rebinding page effectively does. */
function rawStatus(discovery: Discovery, headers: { host?: string; origin?: string }): Promise<number> {
    const url = new URL(discovery.url)
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port,
                path: '/v1/health',
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${discovery.token}`,
                    ...(headers.host ? { Host: headers.host } : {}),
                    ...(headers.origin ? { Origin: headers.origin } : {})
                }
            },
            (res) => {
                res.resume()
                resolve(res.statusCode ?? 0)
            }
        )
        req.on('error', reject)
        req.end()
    })
}
