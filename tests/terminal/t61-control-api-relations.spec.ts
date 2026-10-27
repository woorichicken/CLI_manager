import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'

/**
 * T61 — Related sessions through the Control API: reading a session's pairs,
 * handing them to a successor when it closes (`DELETE …?handTo=`), and the
 * memo pages on every session.
 */

interface Discovery {
    url: string
    mcpUrl: string
    token: string
}
interface Relation {
    sessionId: string
    name: string
    workspaceName: string
    kind: 'opened' | 'connected' | 'manual'
    direction: 'outgoing' | 'incoming'
    at: string
}

const LEAD = 's-lead'
const OLD = 's-old'
const HEIR = 's-heir'
const PEER = 's-peer'
const HIDDEN = 's-hidden'
const OTHER = 's-other'

test.describe('T61 Control API relations', () => {
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

    test('relations are read with kind and direction; handTo passes them on and a refused call closes nothing', async () => {
        const home = dir('climanger-t61-home-')
        const folder = dir('climanger-t61-ws-')
        const names = [LEAD, OLD, HEIR, PEER, HIDDEN, OTHER]
        ctx = await launchAppWithWorkspaces(
            [
                {
                    id: 'ws-t61',
                    name: 'T61WS',
                    path: folder,
                    sessions: [
                        ...names.map((id) => ({ id, name: id.toUpperCase() })),
                        { id: 's-memo', name: 'MEMO', memo: 'page one', memoPages: ['page two', 'page three'] },
                        { id: 's-nomemo', name: 'NOMEMO' }
                    ]
                }
            ],
            {
                settings: { showHomeWorkspace: false, controlApi: { enabled: true, port: 0 } },
                env: { CLIMANAGER_HOME: home },
                config: {
                    sessionRelations: [
                        { from: LEAD, to: OLD, kind: 'opened', at: 1000 },
                        { from: OLD, to: PEER, kind: 'manual', at: 2000 },
                        { from: OLD, to: HIDDEN, kind: 'manual', at: 3000, dismissed: true },
                        // The heir already knows the lead (added by hand), so that pair is not copied.
                        { from: LEAD, to: HEIR, kind: 'manual', at: 500 }
                    ]
                }
            }
        )
        const { page, userDataDir } = ctx
        const discoveryPath = path.join(home, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as Discovery
        const api = async <T = any>(method: string, route: string, body?: unknown, caller?: string): Promise<{ status: number; json: T }> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: {
                    Authorization: `Bearer ${discovery.token}`,
                    'Content-Type': 'application/json',
                    'X-Client-Name': 't61',
                    ...(caller ? { 'X-Caller-Session': caller } : {})
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
        }
        const relationsOf = async (id: string): Promise<Relation[]> => (await api<{ relations: Relation[] }>('GET', `/v1/sessions/${id}/relations`)).json.relations
        const disk = (): Array<{ from: string; to: string; kind: string; at: number; dismissed?: boolean }> =>
            JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).sessionRelations ?? []
        await page.locator(`[data-session-item="${OLD}"]`).waitFor({ timeout: 15_000 })

        // --- memo pages: always one or more, the first is `memo` --------------
        const memo = (await api('GET', '/v1/sessions/s-memo')).json
        expect(memo.memoPages).toEqual(['page one', 'page two', 'page three'])
        expect(memo.memo).toBe('page one')
        expect((await api('GET', '/v1/sessions/s-nomemo')).json.memoPages).toEqual([''])

        // --- an API open and a first read add two more pairs to OLD ------------
        const child = await api<{ session: { id: string } }>('POST', '/v1/sessions', { path: folder, name: 'T61CHILD' }, OLD)
        expect(child.status, JSON.stringify(child.json)).toBe(200)
        expect((await api('GET', `/v1/sessions/${OTHER}/output`, undefined, OLD)).status).toBe(200)

        // --- read: kind, direction, no removed pair -----------------------------
        const old = await relationsOf(OLD)
        const key = (r: Relation): string => `${r.direction}:${r.kind}:${r.sessionId}`
        expect(old.map(key).sort()).toEqual(
            [`incoming:opened:${LEAD}`, `outgoing:manual:${PEER}`, `outgoing:opened:${child.json.session.id}`, `outgoing:connected:${OTHER}`].sort()
        )
        expect(old.find((r) => r.sessionId === PEER)).toMatchObject({ name: 'S-PEER', workspaceName: 'T61WS', at: new Date(2000).toISOString() })
        expect((await relationsOf(PEER)).map(key)).toEqual([`incoming:manual:${OLD}`])
        expect(await relationsOf(HIDDEN)).toEqual([])
        expect((await api('GET', '/v1/sessions/nope/relations')).status).toBe(404)
        expect((await api<any>('GET', `/v1/sessions/${OLD}`)).json.openedBy).toBeNull()

        // --- refused handovers close nothing ---------------------------------------
        const missing = await api('DELETE', `/v1/sessions/${OLD}?handTo=no-such`)
        expect(missing.status).toBe(404)
        const self = await api('DELETE', `/v1/sessions/${OLD}?handTo=${OLD}`)
        expect(self.status).toBe(400)
        expect((await api('GET', `/v1/sessions/${OLD}`)).status).toBe(200)
        await expect(page.locator(`[data-session-item="${OLD}"]`)).toBeVisible()
        expect((await relationsOf(OLD)).length).toBe(4)

        // --- hand over: three copied, the lead (already known) and the removed pair skipped ----
        const closed = await api('DELETE', `/v1/sessions/${OLD}?handTo=${HEIR}`)
        expect(closed.json).toMatchObject({ ok: true, handedOver: 3 })
        await expect(page.locator(`[data-session-item="${OLD}"]`)).toHaveCount(0, { timeout: 10_000 })
        expect((await api('GET', `/v1/sessions/${OLD}`)).status).toBe(404)
        const heir = await relationsOf(HEIR)
        expect(heir.map(key).sort()).toEqual(
            [`incoming:manual:${LEAD}`, `outgoing:manual:${PEER}`, `outgoing:opened:${child.json.session.id}`, `outgoing:connected:${OTHER}`].sort()
        )
        expect(heir.find((r) => r.sessionId === PEER)?.at).toBe(new Date(2000).toISOString())
        expect(disk().some((r) => r.from === OLD || r.to === OLD)).toBe(false)
        expect(disk().find((r) => r.from === LEAD && r.to === HEIR)).toMatchObject({ kind: 'manual', at: 500 })

        // --- MCP -----------------------------------------------------------------
        const rpc = async (name: string, args: Record<string, unknown>): Promise<any> => {
            const res = await fetch(discovery.mcpUrl, {
                method: 'POST',
                headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Client-Name': 't61-mcp' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
            })
            return JSON.parse(await res.text()).result
        }
        const listed = JSON.parse((await rpc('list_session_relations', { session_id: PEER })).content[0].text)
        expect(listed.relations.map(key)).toEqual([`incoming:manual:${HEIR}`])
        expect((await rpc('close_session', { session_id: PEER, hand_to: 'no-such' })).isError).toBe(true)
        expect((await api('GET', `/v1/sessions/${PEER}`)).status).toBe(200)
        expect((await rpc('close_session', { session_id: PEER, hand_to: 's-nomemo' })).content[0].text).toContain('1 Related pair')
        expect((await relationsOf('s-nomemo')).map(key)).toEqual([`incoming:manual:${HEIR}`])
    })
})
