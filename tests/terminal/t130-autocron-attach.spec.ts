import { test, expect, Page } from '@playwright/test'
import path from 'path'
import { REPO_ROOT, LaunchResult, closeApp, launchAppForLoop, openLoopWindow, termState, termText, writeToTerminal } from './helpers'
import type { CronRun, CronView } from '../../src/shared/autocron'

/**
 * T130 — Autocron «attach» on a real loop terminal (T127/T129 drive it with fakes).
 *
 * The guard that decides whether a prompt may be typed (index.ts `loopRefusal`) reads the
 * real terminal: the foreground program (ps) and the mirrored screen. Here a seeded loop
 * session runs a real shell, then the mock agent:
 *   1. only the shell is running        → the run fails «only the shell is left», nothing typed
 *   2. the agent waits at its prompt     → the text and Enter arrive; the agent answers once
 *   3. the agent shows a question        → the next run fails, and the question is not answered
 *   4. after answering, a new prompt     → typed again; the agent quits → back to case 1
 */

const AGENT_MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')
const PROJECT = 'lp-t130'
const TERM = 'term-t130-loop'

async function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
    const result = await page.evaluate(
        ([name, rest]) => (window as unknown as { api: Record<string, (...a: unknown[]) => Promise<unknown>> }).api[name as string](...(rest as unknown[])),
        [method, args] as [string, unknown[]]
    ) as { success: boolean; data?: T; error?: string }
    if (!result.success) throw new Error(`${method}: ${result.error}`)
    return result.data as T
}

test.describe('T130 autocron attach', () => {
    let ctx: LaunchResult | undefined

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
    })

    test('types into a real loop only when its agent waits at the prompt', async () => {
        test.setTimeout(180_000)
        ctx = await launchAppForLoop({
            loopProjects: [{ id: PROJECT, name: 'T130Loop', path: REPO_ROOT }],
            loopSessions: [{ id: 'ls-t130', loopProjectId: PROJECT, terminalId: TERM }]
        })
        const loop = await openLoopWindow(ctx.app, ctx.page)
        await expect.poll(() => termState(loop, TERM), { timeout: 30_000 }).not.toBeNull()

        const job = await call<CronView>(loop, 'createCron', { name: 'T130 nudge', schedule: '0 3 * * *', mode: 'attach', loopProjectId: PROJECT, prompt: 'hello loop' })
        const ask = await call<CronView>(loop, 'createCron', { name: 'T130 ask', schedule: '0 3 * * *', mode: 'attach', loopProjectId: PROJECT, prompt: 'ASK' })
        const run = (id: string) => call<CronRun>(loop, 'runCron', id)

        // 1. only the shell (wait for it to settle: during start-up ps may still see the login shell's children)
        await expect.poll(async () => (await run(job.id)).note ?? '', { timeout: 30_000 })
            .toContain('only the shell is left')
        expect(await termText(loop, TERM)).not.toContain('hello loop')

        // 2. the agent waits at its prompt
        await writeToTerminal(loop, TERM, `node ${AGENT_MOCK} --work-ms 300\r`)
        await expect.poll(() => termText(loop, TERM), { timeout: 30_000 }).toContain('agent-mock ready')
        await expect.poll(async () => (await run(job.id)).status, { timeout: 30_000 }).toBe('started')
        await expect.poll(() => termText(loop, TERM), { timeout: 15_000 }).toContain('ANSWER[1]: hello loop')

        // 3. a question on screen: the run fails and does not press Enter on «1. Yes»
        expect((await run(ask.id)).status).toBe('started')
        await expect.poll(() => termText(loop, TERM), { timeout: 15_000 }).toContain('Do you want to proceed?')
        const refused = await run(job.id)
        expect(refused).toMatchObject({ status: 'failed', note: expect.stringContaining('question or menu') })
        await loop.waitForTimeout(1000)
        const screen = await termText(loop, TERM)
        expect(screen).not.toContain('APPROVED')
        expect(screen).not.toContain('ANSWER[3]')

        // 4. answered by hand, the next run types again; then the agent quits and the guard sees the shell
        await writeToTerminal(loop, TERM, '2')
        await expect.poll(() => termText(loop, TERM), { timeout: 15_000 }).toContain('DENIED')
        expect((await run(job.id)).status).toBe('started')
        await expect.poll(() => termText(loop, TERM), { timeout: 15_000 }).toContain('ANSWER[3]: hello loop')
        await writeToTerminal(loop, TERM, '\x03')
        await expect.poll(() => termText(loop, TERM), { timeout: 15_000 }).toContain('Bye!')
        await expect.poll(async () => (await run(job.id)).note ?? '', { timeout: 15_000 }).toContain('only the shell is left')

        // the window's run list shows what happened, newest first
        const state = await call<{ runs: CronRun[] }>(loop, 'listCrons')
        const mine = state.runs.filter((r) => r.cronId === job.id)
        expect(mine[0]).toMatchObject({ status: 'failed', trigger: 'manual' })
        expect(mine.filter((r) => r.status === 'started').length).toBe(2)
        expect(ctx.pageErrors).toEqual([])
    })
})
