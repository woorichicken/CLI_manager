import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'

/**
 * T22 — Orchestrator ("master") sessions.
 *
 * An agent running in session A opens session B through the Control API and
 * says who it is with X-Caller-Session, taking the value from the
 * CLIMANAGER_SESSION_ID variable its terminal was started with. A then shows
 * as the master (rose row + crown) and B records openedBy = A. A request
 * without the header, or with an id that is malformed or names no session,
 * changes nothing. When A's shell exits, the mark goes away.
 *
 * Judged at the ends: the variable from what the shell printed, the marks from
 * the API and the sidebar DOM.
 */

const MASTER_ID = 's-master'

interface Discovery {
    url: string
    mcpUrl: string
    token: string
}

interface ApiSession {
    id: string
    aiControlled: boolean
    orchestrator: { since: string; lastSeen: string; client: string; openedCount: number } | null
    openedBy: string | null
}

test.describe('T22 Control API master session', () => {
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

    test('a session that opens others is marked as master until its shell exits', async () => {
        const climanagerHome = tempDir('climanger-t22-home-')
        const folder = tempDir('climanger-t22-ws-')

        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-t22', name: 'T22WS', path: folder, sessions: [{ id: MASTER_ID, name: 'T22MASTER' }] }],
            {
                settings: { controlApi: { enabled: true, port: 0 } },
                env: { CLIMANAGER_HOME: climanagerHome }
            }
        )
        const { page } = ctx

        const discoveryPath = path.join(climanagerHome, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as Discovery

        const api = async <T = unknown>(
            method: string,
            route: string,
            body?: unknown,
            caller?: string
        ): Promise<{ status: number; json: T }> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: {
                    Authorization: `Bearer ${discovery.token}`,
                    'Content-Type': 'application/json',
                    'X-Client-Name': 't22',
                    ...(caller !== undefined ? { 'X-Caller-Session': caller } : {})
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
        }
        const masterRow = page.locator(`[data-session-item="${MASTER_ID}"]`)
        await masterRow.waitFor({ timeout: 15_000 })

        // --- The terminal carries its own session id ------------------------
        expect((await api('POST', `/v1/sessions/${MASTER_ID}/input`, { text: 'echo "SID=[$CLIMANAGER_SESSION_ID]"' })).status).toBe(200)
        const echoed = await api<{ lines: string[] }>('POST', `/v1/sessions/${MASTER_ID}/wait`, { timeoutMs: 30_000 })
        const sid = /SID=\[([^\]]*)\]/.exec(echoed.json.lines.filter((l) => !l.includes('echo')).join('\n'))?.[1]
        expect(sid).toBe(MASTER_ID)
        // Touching it made it an AI session — green, not yet master.
        await expect(masterRow).toHaveAttribute('data-session-role', 'ai', { timeout: 5_000 })

        // --- No header, or a header that names nothing: no change -----------
        const noHeader = await api<{ session: ApiSession }>('POST', '/v1/sessions', { path: folder, name: 'T22NOHEADER' })
        expect(noHeader.status, JSON.stringify(noHeader.json)).toBe(200)
        expect(noHeader.json.session.openedBy).toBeNull()
        for (const bogus of ['no-such-session', '../../etc/passwd', '']) {
            const r = await api<{ session: ApiSession }>('POST', '/v1/sessions', { path: folder, name: 'T22BOGUS' }, bogus)
            expect(r.status, `${bogus}: ${JSON.stringify(r.json)}`).toBe(200)
            expect(r.json.session.openedBy).toBeNull()
        }
        expect((await api<ApiSession>('GET', `/v1/sessions/${MASTER_ID}`)).json.orchestrator).toBeNull()
        await expect(masterRow).toHaveAttribute('data-session-role', 'ai')

        // --- With the real id: A becomes master, B records who opened it ----
        const opened = await api<{ session: ApiSession }>('POST', '/v1/sessions', { path: folder, name: 'T22CHILD' }, sid)
        expect(opened.status, JSON.stringify(opened.json)).toBe(200)
        const childId = opened.json.session.id
        expect(opened.json.session.openedBy).toBe(MASTER_ID)

        const master = (await api<ApiSession>('GET', `/v1/sessions/${MASTER_ID}`)).json
        expect(master.orchestrator?.openedCount).toBe(1)
        expect(master.orchestrator?.client).toBe('t22')

        await expect(masterRow).toHaveAttribute('data-session-role', 'master', { timeout: 5_000 })
        await expect(masterRow).toHaveClass(/rose/)
        await expect(masterRow.locator('[data-master-icon]')).toHaveAttribute('title', /opened 1 AI session/)
        const childRow = page.locator(`[data-session-item="${childId}"]`)
        await expect(childRow).toHaveAttribute('data-session-role', 'ai')
        await expect(childRow).toHaveClass(/emerald/)

        // --- MCP: the header works there too, and list_sessions shows both --
        const mcp = async (body: unknown): Promise<any> => {
            const res = await fetch(discovery.mcpUrl, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${discovery.token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'X-Client-Name': 't22-mcp',
                    'X-Caller-Session': MASTER_ID
                },
                body: JSON.stringify(body)
            })
            const text = await res.text()
            return text ? JSON.parse(text) : null
        }
        await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't22', version: '1' } } })
        const mcpOpened = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'open_session', arguments: { path: folder, name: 'T22MCPCHILD' } } })
        expect(mcpOpened.result.isError, mcpOpened.result.content?.[0]?.text).toBeFalsy()
        expect(JSON.parse(mcpOpened.result.content[0].text).session.openedBy).toBe(MASTER_ID)
        const mcpList = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_sessions', arguments: { scope: 'all' } } })
        const listed = JSON.parse(mcpList.result.content[0].text) as ApiSession[]
        expect(listed.find((s) => s.id === MASTER_ID)?.orchestrator?.openedCount).toBe(2)
        expect(listed.find((s) => s.id === childId)?.openedBy).toBe(MASTER_ID)
        const restList = (await api<ApiSession[]>('GET', '/v1/sessions?scope=all')).json
        expect(restList.filter((s) => s.openedBy === MASTER_ID)).toHaveLength(2)
        await expect(masterRow.locator('[data-master-icon]')).toHaveAttribute('title', /opened 2 AI sessions/, { timeout: 5_000 })

        await page.screenshot({ path: test.info().outputPath('t22-sidebar-master.png') })

        // --- A's shell exits: the mark goes away ---------------------------
        await api('POST', `/v1/sessions/${MASTER_ID}/input`, { text: 'exit' })
        await expect.poll(
            async () => (await api<ApiSession>('GET', `/v1/sessions/${MASTER_ID}`)).json.orchestrator,
            { timeout: 15_000 }
        ).toBeNull()
        await expect(masterRow).toHaveAttribute('data-session-role', 'ai', { timeout: 5_000 })
        await expect(masterRow).not.toHaveClass(/rose/)
        await expect(masterRow.locator('[data-master-icon]')).toHaveCount(0)
    })
})
