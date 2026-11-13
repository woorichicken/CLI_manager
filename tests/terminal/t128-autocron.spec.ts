import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { REPO_ROOT, LaunchResult, closeApp, launchAppWithWorkspaces, openLoopWindow } from './helpers'

/**
 * T128 — Autocron end to end: the real app, the Loop window's Autocron tab and `/v1/crons`.
 *
 * 1. Missed while the app was closed: two seeded jobs whose time passed an hour ago.
 *    «once within 6 h» is caught up at start (a real session opens and the mock agent
 *    answers the prompt); «once within 30 min» is recorded as missed, nothing opens.
 * 2. The window: make a job with the form, «Run now», the run row with «Open session».
 * 3. The API: list, bad input (400 with the field), pause → the window shows «Resume».
 */

const AGENT_WORK_MS = 800
const TEMPLATE = {
    id: 'tpl-agent-mock',
    name: 'agent-mock',
    icon: 'terminal',
    description: 'Test agent',
    command: `node ${path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')} --work-ms ${AGENT_WORK_MS}`
}

interface Discovery { url: string; token: string }

test.describe('T128 autocron', () => {
    let ctx: LaunchResult | undefined
    const tempDirs: string[] = []
    const tempDir = (prefix: string) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        tempDirs.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('catches up a missed run at start, runs from the window, and answers the API', async () => {
        test.setTimeout(180_000)
        const home = tempDir('climanger-t128-home-')
        const jobFolder = tempDir('climanger-t128-job-')

        // A time an hour ago, as a daily schedule; the scheduler last looked three hours ago.
        const now = Date.now()
        const hourAgo = new Date(now - 60 * 60_000)
        const dailyAtHourAgo = `${hourAgo.getMinutes()} ${hourAgo.getHours()} * * *`
        const seeded = (id: string, name: string, withinMinutes: number, prompt: string) => ({
            id, name, enabled: true, schedule: dailyAtHourAgo, mode: 'new', template: 'agent-mock', cwd: jobFolder,
            prompt, missed: { policy: 'once', withinMinutes }, createdAt: now - 4 * 3600_000, updatedAt: now - 4 * 3600_000, createdBy: 'seed'
        })

        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-1', name: 'T128WS', path: jobFolder, sessions: [] }],
            {
                settings: { controlApi: { enabled: true, port: 0 } },
                customTemplates: [TEMPLATE],
                env: { CLIMANAGER_HOME: home },
                config: {
                    autocrons: [seeded('job-late', 'T128 late', 360, 'late hello'), seeded('job-expired', 'T128 expired', 30, 'never')],
                    autocronCheckedAt: { 'job-late': now - 3 * 3600_000, 'job-expired': now - 3 * 3600_000 }
                }
            }
        )
        const { app, page } = ctx

        const discoveryPath = path.join(home, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as Discovery
        const api = async <T = any>(method: string, route: string, body?: unknown): Promise<{ status: number; json: T }> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't128' },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
        }

        // --- 1. Missed while closed --------------------------------------------------
        await expect.poll(async () => (await api('GET', '/v1/crons/job-late')).json?.cron?.lastRun?.status, { timeout: 60_000 }).toBe('started')
        const late = (await api('GET', '/v1/crons/T128%20late')).json.cron
        expect(late.lastRun).toMatchObject({ trigger: 'caught-up', status: 'started' })
        expect(late.lastRun.plannedAt).toBe(new Date(hourAgo).setSeconds(0, 0))
        const lateSession = late.lastRun.sessionId as string
        await expect.poll(async () => (await api('GET', `/v1/sessions/${lateSession}/output?mode=tail&lines=100`)).json.lines?.join('\n') ?? '', { timeout: 30_000 })
            .toContain('ANSWER[1]: late hello')

        const expired = (await api('GET', '/v1/crons/job-expired')).json.cron
        expect(expired.lastRun).toMatchObject({ status: 'missed', trigger: 'scheduled' })
        expect(expired.lastRun.note).toContain('30 min late')
        expect(expired.lastRun.sessionId).toBeUndefined()

        // --- 2. The window -------------------------------------------------------------
        const loop = await openLoopWindow(app, page)
        await loop.getByTestId('loop-tab-autocron').click()
        await expect(loop.getByTestId('autocron-item')).toHaveCount(2)

        await loop.getByTestId('autocron-new').click()
        await loop.getByTestId('autocron-name').fill('T128 ui')
        await loop.getByTestId('autocron-form').locator('select').first().selectOption('template')
        await loop.getByPlaceholder('Template name').fill('agent-mock')
        await loop.getByTestId('autocron-cwd').fill(jobFolder)
        await loop.getByTestId('autocron-prompt').fill('ui hello')
        await loop.getByTestId('autocron-schedule').fill('0 8 * * 0')
        await expect(loop.getByTestId('autocron-schedule-preview')).toContainText('Next:')
        await loop.getByTestId('autocron-schedule').fill('0 8 * *')
        await expect(loop.getByTestId('autocron-schedule-preview')).toContainText('five fields')
        await loop.getByTestId('autocron-schedule').fill('0 8 * * 0')
        await loop.getByTestId('autocron-save').click()

        await expect(loop.getByTestId('autocron-detail')).toContainText('T128 ui')
        await expect(loop.getByTestId('autocron-item')).toHaveCount(3)
        await loop.getByTestId('autocron-run-now').click()
        await expect(loop.getByTestId('autocron-runs')).toContainText('ran', { timeout: 60_000 })
        await expect(loop.getByTestId('autocron-runs')).toContainText('manual')
        await loop.getByTestId('autocron-open-session').first().click()

        const ui = (await api('GET', '/v1/crons/T128%20ui')).json.cron
        expect(ui).toMatchObject({ createdBy: 'app', mode: 'new', template: 'agent-mock', schedule: '0 8 * * 0' })
        await expect.poll(async () => (await api('GET', `/v1/sessions/${ui.lastRun.sessionId}/output?mode=tail&lines=100`)).json.lines?.join('\n') ?? '', { timeout: 30_000 })
            .toContain('ANSWER[1]: ui hello')

        // --- 3. The API ----------------------------------------------------------------
        const list = (await api('GET', '/v1/crons')).json
        expect(list.crons.map((c: { name: string }) => c.name).sort()).toEqual(['T128 expired', 'T128 late', 'T128 ui'])

        const bad = await api('POST', '/v1/crons', { name: 'x', schedule: '61 8 * * *', agent: 'claude', cwd: jobFolder, prompt: 'p' })
        expect(bad.status).toBe(400)
        expect(bad.json.error.message).toContain('minute')

        const made = await api('POST', '/v1/crons', { name: 'T128 api', schedule: '*/30 * * * *', agent: 'claude', cwd: jobFolder, prompt: 'p', missed: { policy: 'notify' } })
        expect(made.status).toBe(201)
        expect(made.json.cron).toMatchObject({ createdBy: 't128', missed: { policy: 'notify', withinMinutes: 360 } })

        // names are decoded once: «100% report» is found, «foo%20bar» is not read as «foo bar»
        expect((await api('POST', '/v1/crons', { name: '100% report', schedule: '@daily', agent: 'claude', cwd: jobFolder, prompt: 'p' })).status).toBe(201)
        expect((await api('GET', `/v1/crons/${encodeURIComponent('100% report')}`)).json.cron.name).toBe('100% report')
        expect((await api('GET', `/v1/crons/${encodeURIComponent('T128%20ui')}`)).status).toBe(404)
        expect((await api('DELETE', `/v1/crons/${encodeURIComponent('100% report')}`)).json.removed).toBe(true)

        const paused = await api('POST', '/v1/crons/T128%20ui/pause')
        expect(paused.json.cron.enabled).toBe(false)
        await expect(loop.getByTestId('autocron-toggle')).toContainText('Resume')
        await expect(loop.getByTestId('autocron-next')).toContainText('paused')

        expect((await api('GET', '/v1/crons/nope')).status).toBe(404)
        expect((await api('DELETE', '/v1/crons/T128%20api')).json.removed).toBe(true)
        expect(ctx.pageErrors).toEqual([])
    })
})
