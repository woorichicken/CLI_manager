import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, resizeMainWindow, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T158 — queues through the Control API, end to end against the built app (fb-1123, decision 0014).
 *
 * `GET /v1/queues` returns the Status panel's report; `POST /v1/queues/:source/:item/:action` runs the
 * Settings action command only for a row the report offers that action on right now. The panel shows
 * which queues are read only and which can be managed. What ran is read from act.cjs's own log.
 *
 * Fails on the code before this change: `/v1/queues` answers 404 and the panel has no mode badge.
 */

const FIXTURES = path.join(REPO_ROOT, 'tests', 'terminal', 'fixtures', 'status-command')
const popover = (page: Page) => page.locator('div.fixed', { hasText: 'Uptime' }).last()

let ctx: LaunchResult | null = null
test.afterEach(async () => {
    if (ctx) await closeApp(ctx)
    ctx = null
})

test.describe('T158 queues API', () => {
    test('reads the queues, cancels only an offered row, and the panel tells read only from manageable', async () => {
        const state = fs.mkdtempSync(path.join(os.tmpdir(), 't158-state-'))
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 't158-home-'))
        const env = `STATUS_FIXTURE_STATE="${state}"`
        ctx = await launchAppWithWorkspaces(
            [{ id: 'w-t158', name: 'T158 queues', sessions: [{ id: 's158', name: 'T158 home' }] }],
            {
                settings: {
                    controlApi: { enabled: true, port: 0 },
                    statusCommand: `${env} "${process.execPath}" "${path.join(FIXTURES, 'report-actions.cjs')}"`,
                    statusActionCommand: `${env} "${process.execPath}" "${path.join(FIXTURES, 'act.cjs')}"`
                },
                env: { CLIMANAGER_HOME: home }
            }
        )
        const discoveryPath = path.join(home, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as { url: string; token: string }
        const api = async <T = Record<string, unknown>>(method: string, route: string): Promise<{ status: number; json: T }> => {
            const res = await fetch(discovery.url + route, { method, headers: { Authorization: `Bearer ${discovery.token}`, 'X-Client-Name': 't158' } })
            return { status: res.status, json: (await res.json()) as T }
        }
        const calls = (): string[][] => {
            const log = path.join(state, 'act.log')
            return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
        }

        // --- Read: every queue and row says what it offers ------------------
        expect((await fetch(discovery.url + '/v1/queues')).status).toBe(401)
        type Report = { actionsEnabled: boolean; report: { sources: Array<{ id: string; actions: Array<{ id: string }>; items: Array<{ id?: string; actions: string[] }> }> } }
        const read = await api<Report>('GET', '/v1/queues')
        expect(read.status, JSON.stringify(read.json)).toBe(200)
        expect(read.json.actionsEnabled).toBe(true)
        const [jobs, heavy] = read.json.report.sources
        expect(jobs.actions.map(a => a.id)).toEqual(['cancel'])
        expect(jobs.items.map(i => [i.id, i.actions])).toEqual([['q1', ['cancel']], ['fail', ['cancel']], ['r1', []], [undefined, []]])
        expect(heavy.actions).toEqual([])

        // --- Manage: refused rows run nothing --------------------------------
        expect((await api('POST', '/v1/queues/heavy/h1/cancel')).json).toMatchObject({ error: { code: 'action_not_offered' } })
        expect((await api('POST', '/v1/queues/jobs/r1/cancel')).status).toBe(409)
        expect((await api('POST', '/v1/queues/jobs/nope/cancel')).status).toBe(404)
        expect((await api('POST', `/v1/queues/jobs/${encodeURIComponent('q1;touch x')}/cancel`)).status).toBe(400)
        expect((await api('GET', '/v1/queues/jobs/q1/cancel')).status).toBe(404)   // reading never acts
        expect(calls()).toEqual([])

        const done = await api('POST', '/v1/queues/jobs/q1/cancel')
        expect(done.status, JSON.stringify(done.json)).toBe(200)
        expect(done.json).toMatchObject({ ok: true, source: 'jobs', item: 'q1', action: 'cancel', output: 'cancelled q1' })
        expect(calls()).toEqual([['jobs', 'q1', 'cancel']])
        expect((await api('POST', '/v1/queues/jobs/q1/cancel')).status).toBe(404)   // gone from the next report
        const failed = await api('POST', '/v1/queues/jobs/fail/cancel')
        expect(failed.status).toBe(502)
        expect(failed.json).toMatchObject({ error: { code: 'action_failed', message: 'exit 5 — queue refused: already started' } })

        // --- Panel: read only vs manageable ----------------------------------
        const { page, app } = ctx
        await resizeMainWindow(app, 1280, 800)
        await page.locator('[data-session-item="s158"]').click()
        await page.locator('button[title="System Monitor"]').click()
        const panel = page.locator('[data-status-panel]')
        await expect(panel.locator('[data-status-source="jobs"] [data-status-mode]')).toHaveAttribute('data-status-mode', 'manage', { timeout: 15_000 })
        await expect(panel.locator('[data-status-source="jobs"] [data-status-mode]')).toHaveText('Manage · Cancel')
        await expect(panel.locator('[data-status-source="heavy"] [data-status-mode]')).toHaveAttribute('data-status-mode', 'read')
        await expect(panel.locator('[data-status-source="heavy"] [data-status-mode]')).toHaveText('Read only')
        await panel.locator('[data-status-source="jobs"] button').first().click()
        await expect(panel.locator('[data-status-source="jobs"] [data-status-item-actions]')).toHaveCount(1)   // "fail" only — q1 is gone, r1 is running
        const shots = process.env.T158_SHOTS
        if (shots) {
            fs.mkdirSync(shots, { recursive: true })
            await popover(page).screenshot({ path: path.join(shots, 'queues-modes-1280.png') })
        }
    })

    test('without an action command every queue is read only and POST runs nothing', async () => {
        const state = fs.mkdtempSync(path.join(os.tmpdir(), 't158b-state-'))
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 't158b-home-'))
        ctx = await launchAppWithWorkspaces(
            [{ id: 'w-t158b', name: 'T158 read', sessions: [{ id: 's158b', name: 'T158 b' }] }],
            {
                settings: {
                    controlApi: { enabled: true, port: 0 },
                    statusCommand: `STATUS_FIXTURE_STATE="${state}" "${process.execPath}" "${path.join(FIXTURES, 'report-actions.cjs')}"`
                },
                env: { CLIMANAGER_HOME: home }
            }
        )
        const discoveryPath = path.join(home, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as { url: string; token: string }
        const headers = { Authorization: `Bearer ${discovery.token}` }
        const read = await (await fetch(discovery.url + '/v1/queues', { headers })).json()
        expect(read.actionsEnabled).toBe(false)
        const res = await fetch(discovery.url + '/v1/queues/jobs/q1/cancel', { method: 'POST', headers })
        expect(res.status).toBe(404)
        expect((await res.json()).error.code).toBe('actions_off')
        expect(fs.existsSync(path.join(state, 'act.log'))).toBe(false)

        const { page } = ctx
        await page.locator('[data-session-item="s158b"]').click()
        await page.locator('button[title="System Monitor"]').click()
        await expect(page.locator('[data-status-source="jobs"] [data-status-mode]')).toHaveAttribute('data-status-mode', 'read', { timeout: 15_000 })
    })
})
