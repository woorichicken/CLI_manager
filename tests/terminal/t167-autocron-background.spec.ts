import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { REPO_ROOT, LaunchResult, closeApp, launchAppWithWorkspaces, openLoopWindow } from './helpers'

/**
 * T167 — Autocron's background sessions in the app (2026-11-24):
 *
 * 1. A run opens its session hidden: config.json has `hidden: true`, the sidebar (All sessions) has no row
 *    for it, and the agent still answers the prompt. «Open session» in the Loop window clears the flag and
 *    the row appears.
 * 2. Done and idle (test timing: idle close 15 s): the session is closed, the run keeps the conversation
 *    (closedAt · conversation.id = the id ClaudeSessionSync found) and its button reads «Resume»; Resume opens a new,
 *    listed session that runs `<the agent's own command> --resume <id>`, and the run names the new session.
 *
 * The agent is chat-mock behind an executable named `claude` (so the app reads it as Claude and the
 * resume keeps that command); `--copy-transcript` registers a real-looking conversation in the isolated
 * CLAUDE_CONFIG_DIR, which is how ClaudeSessionSync learns its id.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const SEEDED = 't167-person'

interface Discovery { url: string; token: string }

function apiFor(home: string) {
    const discovery = JSON.parse(fs.readFileSync(path.join(home, 'control-api.json'), 'utf-8')) as Discovery
    return async <T = any>(method: string, route: string, body?: unknown): Promise<{ status: number; json: T }> => {
        const res = await fetch(discovery.url + route, {
            method,
            headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't167' },
            body: body === undefined ? undefined : JSON.stringify(body)
        })
        const text = await res.text()
        return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
    }
}

interface StoredSession { id: string; hidden?: boolean; initialCommand?: string; cliSessionId?: string }
function sessionsIn(userDataDir: string): StoredSession[] {
    const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
    return (config.workspaces ?? []).flatMap((w: { sessions?: StoredSession[] }) => w.sessions ?? [])
}
function runsIn(userDataDir: string): Array<{ id: string; sessionId?: string; closedAt?: number; conversation?: { id: string; agent: string; command?: string } }> {
    return JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).autocronRuns ?? []
}

const sidebarRow = (page: Page, id: string) => page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${id}"]`)

test.describe('T167 autocron background sessions', () => {
    let ctx: LaunchResult | undefined
    const tempDirs: string[] = []
    const tempDir = (prefix: string) => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
        tempDirs.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    async function launch(idleCloseMs: number, seeded = true) {
        const home = tempDir('climanger-t167-home-')
        const jobFolder = tempDir('climanger-t167-job-')
        const claudeDir = tempDir('climanger-t167-claude-')
        const bin = tempDir('climanger-t167-bin-')
        const transcripts = path.join(claudeDir, 'projects', jobFolder.replace(/[^A-Za-z0-9]/g, '-'))
        fs.mkdirSync(transcripts, { recursive: true })
        const agent = path.join(bin, 'claude')
        fs.writeFileSync(agent, `#!/bin/sh\nexec node ${MOCK} --transcript ${path.join(transcripts, 'seed.jsonl')} --copy-transcript --show-args --work-ms 500 "$@"\n`, { mode: 0o755 })
        ctx = await launchAppWithWorkspaces([{ id: 'ws-1', name: 'T167WS', path: jobFolder, sessions: seeded ? [{ id: SEEDED, name: 'Person' }] : [] }], {
            settings: { controlApi: { enabled: true, port: 0 } },
            env: { CLIMANAGER_HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CLIMANAGER_TEST_CRON_TIMING: `1000,${idleCloseMs}` }
        })
        await expect.poll(() => fs.existsSync(path.join(home, 'control-api.json')), { timeout: 15_000 }).toBe(true)
        const api = apiFor(home)
        const made = await api('POST', '/v1/crons', { name: 'T167 bg', schedule: '0 8 * * 0', agent, cwd: jobFolder, prompt: 'hello background', runNow: true })
        expect(made.status).toBe(201)
        expect(made.json.run).toMatchObject({ status: 'started' })
        const sessionId = made.json.run.sessionId as string
        await ctx.page.getByTestId('sidebar-view-toggle').click()
        return { api, agent, sessionId, ctx }
    }

    async function openJob(c: LaunchResult): Promise<Page> {
        const loop = await openLoopWindow(c.app, c.page)
        await loop.getByTestId('loop-tab-autocron').click()
        await loop.getByTestId('autocron-item').filter({ hasText: 'T167 bg' }).click()
        await expect(loop.getByTestId('autocron-runs')).toContainText('ran')
        return loop
    }

    test('a run opens hidden — no sidebar row — and «Open session» brings it into the list', async () => {
        test.setTimeout(180_000)
        const { api, sessionId, ctx: c } = await launch(600_000)

        expect(sessionsIn(c.userDataDir).find((s) => s.id === sessionId)).toMatchObject({ hidden: true })
        await expect.poll(async () => (await api('GET', `/v1/sessions/${sessionId}/output?mode=tail&lines=100`)).json.lines?.join('\n') ?? '', { timeout: 60_000 })
            .toContain('hello background')
        await expect(sidebarRow(c.page, SEEDED)).toBeVisible()
        await expect(sidebarRow(c.page, sessionId)).toHaveCount(0)
        // still hidden a few ticks later (it is working / recently active)
        await c.page.waitForTimeout(3000)
        await expect(sidebarRow(c.page, sessionId)).toHaveCount(0)

        const loop = await openJob(c)
        await expect(loop.getByTestId('autocron-open-session')).toHaveText(/Open session/)
        await loop.getByTestId('autocron-open-session').click()
        await expect.poll(() => sessionsIn(c.userDataDir).find((s) => s.id === sessionId)?.hidden ?? false).toBe(false)
        await expect(sidebarRow(c.page, sessionId)).toBeVisible()
        await expect(c.page.locator(`[data-session-id="${sessionId}"] .xterm`)).toBeVisible()
    })

    test('with no other session in the window, the background session is not picked as the one on screen', async () => {
        test.setTimeout(120_000)
        const { api, sessionId, ctx: c } = await launch(600_000, false)
        await expect.poll(async () => (await api('GET', `/v1/sessions/${sessionId}/output?mode=tail&lines=100`)).json.lines?.join('\n') ?? '', { timeout: 60_000 })
            .toContain('hello background')
        await c.page.waitForTimeout(3000)
        expect(sessionsIn(c.userDataDir).find((s) => s.id === sessionId)).toMatchObject({ hidden: true })
        await expect(sidebarRow(c.page, sessionId)).toHaveCount(0)
    })

    test('done and idle → closed with its conversation kept; Resume opens it again in a listed session', async () => {
        test.setTimeout(240_000)
        const { agent, sessionId, ctx: c } = await launch(15_000)

        // the session carries a conversation id while it is still hidden (the injected --session-id first; the mock
        // then registers its own, which ClaudeSessionSync's 10 s sweep picks up — the id kept is the last one)
        await expect.poll(() => sessionsIn(c.userDataDir).find((s) => s.id === sessionId)?.cliSessionId ?? '', { timeout: 40_000 })
            .toMatch(/^[0-9a-f-]{36}$/)
        await expect(sidebarRow(c.page, sessionId)).toHaveCount(0)
        let lastSeenId = ''
        await expect.poll(() => {
            const session = sessionsIn(c.userDataDir).find((s) => s.id === sessionId)
            if (session?.cliSessionId) lastSeenId = session.cliSessionId
            return session !== undefined
        }, { timeout: 90_000 }).toBe(false)
        const closed = runsIn(c.userDataDir).find((r) => r.sessionId === sessionId)!
        expect(closed.closedAt).toEqual(expect.any(Number))
        expect(closed.conversation).toMatchObject({ agent: 'claude', id: lastSeenId })
        const conversationId = closed.conversation!.id

        const loop = await openJob(c)
        await expect(loop.getByTestId('autocron-runs')).toContainText('closed when done')
        await expect(loop.getByTestId('autocron-open-session')).toHaveText(/Resume/)
        await loop.getByTestId('autocron-open-session').click()

        await expect.poll(() => runsIn(c.userDataDir).find((r) => r.id === closed.id)?.sessionId, { timeout: 30_000 }).not.toBe(sessionId)
        const resumed = runsIn(c.userDataDir).find((r) => r.id === closed.id)!
        expect(resumed.closedAt).toBeUndefined()
        const session = sessionsIn(c.userDataDir).find((s) => s.id === resumed.sessionId)!
        expect(session.hidden).toBeUndefined()
        expect(session.initialCommand).toContain(`--resume ${conversationId}`)
        expect(session.initialCommand).toContain(agent)
        await expect(sidebarRow(c.page, session.id)).toBeVisible()
        const argsLine = async () => (await c.page.evaluate((id) => document.querySelector(`[data-session-id="${id}"] .xterm-rows`)?.textContent ?? '', session.id))
            .match(/ARGS:[^\n]*?(?=\s{2,}|$)/)?.[0] ?? ''
        await expect.poll(argsLine, { timeout: 30_000 }).toContain(`ARGS: --resume ${conversationId}`)
        // nothing else rides along — a real Claude refuses --session-id next to --resume (CLISessionTracker skips it)
        expect(await argsLine()).not.toContain('--session-id')
    })
})
