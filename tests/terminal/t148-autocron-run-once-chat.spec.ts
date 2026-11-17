import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { REPO_ROOT, LaunchResult, closeApp, launchAppWithWorkspaces, openLoopWindow, waitForBufferText } from './helpers'

/**
 * T148 — Autocron «Save & run now» and Chat in the Loop window (backlog 2026-11-16).
 *
 * 1. A new job saved with «Save & run now» runs once (one manual run, the session answers the prompt),
 *    keeps its schedule, and the edit form has no such button. `POST /v1/crons` with `runNow: true`
 *    answers `{ cron, run }`; a non-boolean `runNow` is 400 and saves nothing.
 * 2. Chat in the Loop window: a job's run that opened a Claude session (chat-mock) → «Talk here» →
 *    the Chat view in the Loop window shows the conversation; a message sent there reaches the
 *    session's terminal and comes back as an answer. A run whose session is gone says so; a run in a
 *    plain shell says Chat isn't available.
 */

const AGENT_WORK_MS = 800
const TEMPLATE = {
    id: 'tpl-agent-mock',
    name: 'agent-mock',
    icon: 'terminal',
    description: 'Test agent',
    command: `node ${path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')} --work-ms ${AGENT_WORK_MS}`
}
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const CLAUDE_ID = '00000000-0000-4000-8000-00000000c142'
const CLAUDE_SESSION = 't148-claude'
const SHELL_SESSION = 't148-shell'
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

interface Discovery { url: string; token: string }

function apiFor(home: string) {
    const discovery = JSON.parse(fs.readFileSync(path.join(home, 'control-api.json'), 'utf-8')) as Discovery
    return async <T = any>(method: string, route: string, body?: unknown): Promise<{ status: number; json: T }> => {
        const res = await fetch(discovery.url + route, {
            method,
            headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't148' },
            body: body === undefined ? undefined : JSON.stringify(body)
        })
        const text = await res.text()
        return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
    }
}

async function openAutocron(ctx: LaunchResult): Promise<Page> {
    const loop = await openLoopWindow(ctx.app, ctx.page)
    await loop.getByTestId('loop-tab-autocron').click()
    return loop
}

test.describe('T148 autocron run once and chat', () => {
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

    test('Save & run now runs a new job once; the API takes runNow', async () => {
        test.setTimeout(180_000)
        const home = tempDir('climanger-t148-home-')
        const jobFolder = tempDir('climanger-t148-job-')
        ctx = await launchAppWithWorkspaces([{ id: 'ws-1', name: 'T148WS', path: jobFolder, sessions: [] }], {
            settings: { controlApi: { enabled: true, port: 0 } },
            customTemplates: [TEMPLATE],
            env: { CLIMANAGER_HOME: home }
        })
        await expect.poll(() => fs.existsSync(path.join(home, 'control-api.json')), { timeout: 15_000 }).toBe(true)
        const api = apiFor(home)
        const loop = await openAutocron(ctx)

        // --- the form: Save & run now ----------------------------------------------------
        await loop.getByTestId('autocron-new').click()
        await loop.getByTestId('autocron-name').fill('T148 ui')
        await loop.getByTestId('autocron-form').locator('select').first().selectOption('template')
        await loop.getByPlaceholder('Template name').fill('agent-mock')
        await loop.getByTestId('autocron-cwd').fill(jobFolder)
        await loop.getByTestId('autocron-prompt').fill('first hello')
        await loop.getByTestId('autocron-schedule').fill('0 8 * * 0')
        await loop.getByTestId('autocron-save-run').click()

        await expect(loop.getByTestId('autocron-detail')).toContainText('T148 ui')
        await expect(loop.getByTestId('autocron-runs')).toContainText('ran', { timeout: 60_000 })
        await expect(loop.getByTestId('autocron-runs')).toContainText('manual')
        const ui = (await api('GET', '/v1/crons/T148%20ui')).json.cron
        expect(ui).toMatchObject({ createdBy: 'app', enabled: true, lastRun: { trigger: 'manual', status: 'started' } })
        expect(ui.nextRunAt).not.toBeNull()
        await expect.poll(async () => (await api('GET', `/v1/sessions/${ui.lastRun.sessionId}/output?mode=tail&lines=100`)).json.lines?.join('\n') ?? '', { timeout: 30_000 })
            .toContain('ANSWER[1]: first hello')
        // one run, not two (the effect that starts it must not fire twice)
        await loop.waitForTimeout(2000)
        expect((await api('GET', '/v1/crons/T148%20ui/runs')).json.runs).toHaveLength(1)

        // editing is Save only
        await loop.getByRole('button', { name: 'Edit' }).click()
        await expect(loop.getByTestId('autocron-form')).toBeVisible()
        await expect(loop.getByTestId('autocron-save-run')).toHaveCount(0)
        await expect(loop.getByTestId('autocron-save')).toBeVisible()

        // --- the API: runNow ----------------------------------------------------------
        const bad = await api('POST', '/v1/crons', { name: 'T148 bad', schedule: '@daily', template: 'agent-mock', cwd: jobFolder, prompt: 'p', runNow: 'yes' })
        expect(bad.status).toBe(400)
        expect(bad.json.error.message).toContain('runNow')
        expect((await api('GET', '/v1/crons/T148%20bad')).status).toBe(404)

        const made = await api('POST', '/v1/crons', { name: 'T148 api', schedule: '@daily', template: 'agent-mock', cwd: jobFolder, prompt: 'api hello', runNow: true })
        expect(made.status).toBe(201)
        expect(made.json.run).toMatchObject({ trigger: 'manual', status: 'started' })
        expect(made.json.cron.lastRun).toMatchObject({ trigger: 'manual', status: 'started' })
        await expect.poll(async () => (await api('GET', `/v1/sessions/${made.json.run.sessionId}/output?mode=tail&lines=100`)).json.lines?.join('\n') ?? '', { timeout: 30_000 })
            .toContain('ANSWER[1]: api hello')
        expect(ctx.pageErrors).toEqual([])
    })

    test('talks to a run session from the Loop window', async () => {
        test.setTimeout(180_000)
        const home = tempDir('climanger-t148-chat-')
        const project = path.join(home, 'project')
        fs.mkdirSync(project)
        const claudeDir = path.join(home, 'claude')
        const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${CLAUDE_ID}.jsonl`)
        fs.mkdirSync(path.dirname(transcript), { recursive: true })
        fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)

        const now = Date.now()
        const job = {
            id: 'job-chat', name: 'T148 chat', enabled: true, schedule: '0 8 * * 0', mode: 'new', template: 'chat', cwd: project,
            prompt: 'p', missed: { policy: 'once', withinMinutes: 360 }, createdAt: now - 3600_000, updatedAt: now - 3600_000, createdBy: 'app'
        }
        const run = (id: string, minutesAgo: number, sessionId: string) => ({
            id, cronId: 'job-chat', plannedAt: now - minutesAgo * 60_000, at: now - minutesAgo * 60_000, trigger: 'manual', status: 'started', missedCount: 0, sessionId
        })
        ctx = await launchAppWithWorkspaces(
            [{
                id: 'ws-chat', name: 'T148 project', path: project,
                sessions: [
                    { id: CLAUDE_SESSION, name: 'T148 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 400 --continue` },
                    { id: SHELL_SESSION, name: 'T148 Shell' }
                ]
            }],
            {
                env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, 'codex'), CLIMANAGER_HOME: path.join(home, 'clim') },
                config: {
                    autocrons: [job],
                    // newest first, as the store keeps them. The newest run's session is closed, so Chat
                    // opens on the next one that is still open — the Claude run
                    autocronRuns: [run('run-gone', 2, 't148-gone'), run('run-claude', 5, CLAUDE_SESSION), run('run-shell', 10, SHELL_SESSION)],
                    autocronCheckedAt: { 'job-chat': now }
                }
            }
        )
        await waitForBufferText(ctx.page, CLAUDE_SESSION, 'Claude Code (mock)', 20_000)
        const loop = await openAutocron(ctx)
        await expect(loop.getByTestId('autocron-detail')).toContainText('T148 chat')
        await expect(loop.getByTestId('autocron-talk-here')).toHaveCount(3)

        // the Chat tab opens on the newest run whose session is still open (not the closed newest one)
        await loop.getByTestId('autocron-view-chat').click()
        const chat = loop.getByTestId('autocron-chat')
        await expect(chat).toHaveAttribute('data-session-id', CLAUDE_SESSION)
        await expect(loop.getByTestId('autocron-chat-name')).toHaveText('T148 Claude')
        await expect(chat.locator('[data-testid="chat-turn"]').first()).toBeVisible({ timeout: 15_000 })

        // sent here → typed into the session's terminal → answered here
        const composer = chat.getByTestId('chat-composer')
        await composer.fill('hello from the loop window')
        await composer.press('Enter')
        await waitForBufferText(ctx.page, CLAUDE_SESSION, 'ANSWER[1]: hello from the loop window', 15_000)
        await expect(chat.locator('[data-testid="chat-answer"]', { hasText: 'Echo: hello from the loop window' })).toBeVisible({ timeout: 15_000 })
        expect(fs.readFileSync(transcript, 'utf8')).toContain('hello from the loop window')

        // a command only the terminal shows, sent from the Loop window while the main window has that
        // session on Chat: the main window switches it to its terminal with «Back to Chat»
        await chat.getByTestId('autocron-chat-open-main').click()
        const main = ctx.page
        await expect(main.getByTestId('view-toggle')).toBeVisible({ timeout: 10_000 })
        await main.getByTestId('view-toggle-chat').click()
        await expect(main.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'chat')
        await composer.fill('/conf')
        await expect(chat.locator('[data-testid="chat-complete-row"]', { hasText: '/config' }).first()).toBeVisible()
        await composer.press('Enter')
        await expect(composer).toHaveValue('/config ')
        await composer.press('Enter')
        await waitForBufferText(main, CLAUDE_SESSION, 'PANEL: /config', 15_000)
        await expect(main.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal', { timeout: 10_000 })
        await expect(main.getByTestId('chat-peek-bar')).toContainText('/config')
        // the picker's arrows and Enter go to that terminal without a click
        await expect.poll(() => main.evaluate((id) => {
            const el = document.activeElement
            return !!el && el.classList.contains('xterm-helper-textarea')
                && el.closest('[data-session-id]')?.getAttribute('data-session-id') === id
        }, CLAUDE_SESSION), { timeout: 5_000 }).toBe(true)

        // a closed session (pinned with «Talk here» it still says so) and a plain shell
        await loop.getByTestId('autocron-view-details').click()
        await loop.getByTestId('autocron-talk-here').nth(0).click()
        await expect(loop.getByTestId('autocron-chat-notice')).toContainText('This session was closed')
        await loop.getByTestId('autocron-view-details').click()
        await loop.getByTestId('autocron-talk-here').nth(2).click()
        await expect(loop.getByTestId('autocron-chat-notice')).toContainText("Chat isn't available")

        const shots = process.env.T148_SHOTS
        if (shots) {
            fs.mkdirSync(shots, { recursive: true })
            await loop.getByTestId('autocron-view-details').click()
            await loop.getByTestId('autocron-talk-here').nth(1).click()
            await loop.waitForTimeout(500)
            await loop.screenshot({ path: path.join(shots, 'loop-chat-1200.png') })
        }
        expect(ctx.pageErrors).toEqual([])
    })
})
