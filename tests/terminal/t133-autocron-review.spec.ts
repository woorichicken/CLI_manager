import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { REPO_ROOT, LaunchResult, closeApp, launchAppForLoop, launchAppWithWorkspaces, openLoopWindow, termState, termText, writeToTerminal } from './helpers'
import type { CronRun, CronView } from '../../src/shared/autocron'

/**
 * T133 — the 2026-11-14 Autocron review fixes in the real app (T132 covers them with fakes).
 *
 * 1. Control API off: a seeded job a client made over the API waits — no session at start-up,
 *    the Autocron tab says why — while a job made in the window is caught up as before.
 * 2. attach on a real loop with a Claude-style input box (agent-mock --box):
 *    the CLI drops the first Enter → it is pressed again and the agent answers once;
 *    a person left a draft in the box → nothing is typed, the run fails, the draft stays.
 */

const AGENT_MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')
const TEMPLATE = {
    id: 'tpl-agent-mock',
    name: 'agent-mock',
    icon: 'terminal',
    description: 'Test agent',
    command: `node ${AGENT_MOCK} --work-ms 500`
}
const PROJECT = 'lp-t133'
const TERM = 'term-t133-loop'

async function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
    const result = await page.evaluate(
        ([name, rest]) => (window as unknown as { api: Record<string, (...a: unknown[]) => Promise<unknown>> }).api[name as string](...(rest as unknown[])),
        [method, args] as [string, unknown[]]
    ) as { success: boolean; data?: T; error?: string }
    if (!result.success) throw new Error(`${method}: ${result.error}`)
    return result.data as T
}

test.describe('T133 autocron review fixes', () => {
    let ctx: LaunchResult | undefined
    const tempDirs: string[] = []

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('with the Control API off, an API-made job waits and the window says why', async () => {
        test.setTimeout(120_000)
        const jobFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t133-job-'))
        tempDirs.push(jobFolder)
        const now = Date.now()
        const hourAgo = new Date(now - 60 * 60_000)
        const seeded = (id: string, name: string, createdBy: string) => ({
            id, name, enabled: true, schedule: `${hourAgo.getMinutes()} ${hourAgo.getHours()} * * *`, mode: 'new', template: 'agent-mock',
            cwd: jobFolder, prompt: `${id} hello`, missed: { policy: 'once', withinMinutes: 360 },
            createdAt: now - 4 * 3600_000, updatedAt: now - 4 * 3600_000, createdBy
        })
        ctx = await launchAppWithWorkspaces([{ id: 'ws-1', name: 'T133WS', path: jobFolder, sessions: [] }], {
            settings: { controlApi: { enabled: false } },
            customTemplates: [TEMPLATE],
            config: {
                autocrons: [seeded('job-window', 'T133 window', 'app'), seeded('job-api', 'T133 api', 'mcp')],
                autocronCheckedAt: { 'job-window': now - 3 * 3600_000, 'job-api': now - 3 * 3600_000 }
            }
        })
        const loop = await openLoopWindow(ctx.app, ctx.page)
        const byId = async (id: string) => (await call<{ crons: CronView[] }>(loop, 'listCrons')).crons.find((c) => c.id === id)!

        await expect.poll(async () => (await byId('job-window')).lastRun?.status ?? '', { timeout: 60_000 }).toBe('started')
        const api = await byId('job-api')
        expect(api.lastRun).toBeNull()
        expect(api.nextRunAt).toBeNull()
        expect(api.problem).toContain('Control API is off')

        await loop.getByTestId('loop-tab-autocron').click()
        await loop.getByTestId('autocron-item').filter({ hasText: 'T133 api' }).click()
        await expect(loop.getByTestId('autocron-problem')).toContainText('Control API is off')
        await expect(loop.getByTestId('autocron-made-by')).toContainText('mcp')
        await expect(loop.getByTestId('autocron-item').filter({ hasText: 'T133 api' })).toContainText('waits for the Control API')
        // «Run now» in the window does not get around it
        await loop.getByTestId('autocron-run-now').click()
        await expect.poll(async () => (await byId('job-api')).lastRun?.note ?? '', { timeout: 15_000 }).toContain('Control API is off')
        expect((await byId('job-api')).lastRun?.sessionId).toBeUndefined()
        expect(ctx.pageErrors).toEqual([])
    })

    test('attach into a boxed loop: a dropped Enter is pressed again; a person\'s draft is left alone', async () => {
        test.setTimeout(180_000)
        ctx = await launchAppForLoop({
            loopProjects: [{ id: PROJECT, name: 'T133Loop', path: REPO_ROOT }],
            loopSessions: [{ id: 'ls-t133', loopProjectId: PROJECT, terminalId: TERM }]
        })
        const loop = await openLoopWindow(ctx.app, ctx.page)
        await expect.poll(() => termState(loop, TERM), { timeout: 30_000 }).not.toBeNull()
        const job = await call<CronView>(loop, 'createCron', { name: 'T133 nudge', schedule: '0 3 * * *', mode: 'attach', loopProjectId: PROJECT, prompt: 'hello box' })
        const run = (id: string) => call<CronRun>(loop, 'runCron', id)

        await writeToTerminal(loop, TERM, `node ${AGENT_MOCK} --work-ms 300 --box --drop-enters 1\r`)
        await expect.poll(() => termText(loop, TERM), { timeout: 30_000 }).toContain('agent-mock ready')

        // 1. the first Enter is swallowed: the run still lands, once
        await expect.poll(async () => (await run(job.id)).status, { timeout: 30_000 }).toBe('started')
        await expect.poll(() => termText(loop, TERM), { timeout: 20_000 }).toContain('ANSWER[1]: hello box')
        await expect.poll(() => termText(loop, TERM), { timeout: 15_000 }).toContain('❯')

        // 2. a person is halfway through a line: nothing is typed after it, nothing is sent
        await writeToTerminal(loop, TERM, 'my own draft')
        await expect.poll(() => termText(loop, TERM), { timeout: 15_000 }).toContain('❯ my own draft')
        const refused = await run(job.id)
        expect(refused).toMatchObject({ status: 'failed', note: expect.stringContaining('already has text') })
        await loop.waitForTimeout(1500)
        const screen = await termText(loop, TERM)
        expect(screen).toContain('❯ my own draft')
        expect(screen).not.toContain('hello boxmy')
        expect(screen).not.toContain('my own drafthello')
        expect(screen).not.toContain('ANSWER[2]')
        expect(ctx.pageErrors).toEqual([])
    })
})
