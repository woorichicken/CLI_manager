import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T194 — agent-sent UI in the app (decision 0016). A session sends a card through `POST /v1/ui`
 * (and MCP `show_ui`); the inbox draws it under the request with the A2UI renderer; a button
 * press types one fixed line into that session through the Chat view's send — it reaches the
 * mock agent (`ANSWER[n]`), a question on the agent's screen refuses it and the card stays open,
 * an answered card locks, the request stays unread, the session gets no AI mark. A card for
 * another session than the caller, or one outside the allowlist, is refused.
 *
 * T194_SHOTS=<dir> + T194_LABEL saves captures (1280 and 390) before the checks. T194_BEFORE=1 only
 * captures the same request sent as a plain inbox request (what an agent can do without show_ui) —
 * the review's "before", runnable on the old build.
 */

const CLAUDE = 's-t194-claude'
const SHELL = 's-t194-shell'
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const LABEL = process.env.T194_LABEL ?? 'run'
const PREFIX = '[CLI Manager card]'

let result: LaunchResult | null = null
const temps: string[] = []
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    temps.push(dir)
    return dir
}

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T194_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; home: string }> {
    const home = tempDir('climanager-t194-')
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const transcript = path.join(home, 'claude', 'projects', 'x', '00000000-0000-4000-8000-0000000c1940.jsonl')
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t194',
            name: 'T194 project',
            path: project,
            sessions: [
                {
                    id: CLAUDE,
                    name: 'T194 Claude',
                    cliSessionId: '00000000-0000-4000-8000-0000000c1940',
                    cliToolName: 'claude',
                    cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300`
                },
                { id: SHELL, name: 'T194 Shell' }
            ]
        }],
        {
            settings: { controlApi: { enabled: true, port: 0 }, showHomeWorkspace: false },
            env: { CLIMANAGER_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude') }
        }
    )
    await resizeMainWindow(result.app, 1280, 800)
    return { app: result.app, page: result.page, home }
}

interface Discovery { url: string; token: string }

async function apiFor(home: string) {
    const discoveryPath = path.join(home, 'control-api.json')
    await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as Discovery
    return async (method: string, route: string, body: unknown, caller?: string): Promise<{ status: number; json: any }> => {
        const headers: Record<string, string> = { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't194' }
        if (caller) headers['X-Caller-Session'] = caller
        const res = await fetch(discovery.url + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
        const text = await res.text()
        return { status: res.status, json: text ? JSON.parse(text) : null }
    }
}

const terminalLines = (page: Page, id: string): Promise<string> =>
    page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId).then((c) => (c.terminal?.recentLines ?? []).join('\n')), id)

const sessionRole = (page: Page, id: string) =>
    page.locator(`[data-session-item="${id}"][data-session-role]`).first().getAttribute('data-session-role')

/** The card from the brand smoke (client.jsx): a title, a note, approve / hold. */
function approvalCard(pr: number) {
    return {
        kind: 'question',
        text: `Merge PR #${pr}?`,
        components: [
            { id: 'root', component: 'Card', child: 'col' },
            { id: 'col', component: 'Column', children: ['title', 'body', 'note', 'row'] },
            { id: 'title', component: 'Text', text: { '@path': '/title' } },
            { id: 'body', component: 'Text', text: { '@path': '/body' }, variant: 'caption' },
            { id: 'note', component: 'TextField', label: 'Note', value: { '@path': '/note' } },
            { id: 'row', component: 'Row', children: ['ok', 'no'] },
            { id: 'okL', component: 'Text', text: 'Approve' },
            { id: 'noL', component: 'Text', text: 'Hold' },
            { id: 'ok', component: 'Button', child: 'okL', variant: 'primary', action: { event: { name: 'approve', context: { pr, note: { '@path': '/note' } } } } },
            { id: 'no', component: 'Button', child: 'noL', action: { event: { name: 'hold', context: { pr } } } }
        ],
        data: { title: `PR #${pr} — merge?`, body: 'docs(backlog) · 1 file · tests pass', note: '' }
    }
}

test('T194: an agent card in the inbox — drawn, a button types one line into the session, a question refuses it, answered locks', async () => {
    test.setTimeout(180_000)
    const { page, home } = await launch()
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)
    const api = await apiFor(home)

    if (process.env.T194_BEFORE === '1') {
        expect((await api('POST', '/v1/inbox', { kind: 'question', text: 'Merge PR #324? (docs(backlog) · 1 file · tests pass) — reply approve or hold' }, CLAUDE)).status).toBe(200)
        await page.locator('[data-testid="inbox-button"]:visible').first().click()
        await expect(page.getByTestId('inbox-popover')).toBeVisible()
        await shot(page, 't194-card-1280')
        await page.keyboard.press('Escape')
        await resizeMainWindow(result!.app, 390, 800)
        await page.locator('[data-testid="inbox-button"]:visible').first().click()
        await expect(page.getByTestId('inbox-popover')).toBeVisible()
        await shot(page, 't194-card-390')
        return
    }

    // --- The API: what is refused, what goes in -----------------------------
    const bad = await api('POST', '/v1/ui', { text: 'x', components: [{ id: 'root', component: 'Image', url: 'https://example.com/a.png' }] }, CLAUDE)
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('bad_ui')
    const openUrl = approvalCard(1)
    ;(openUrl.components[8] as Record<string, unknown>).action = { functionCall: { call: 'openUrl', args: { url: 'https://example.com' } } }
    expect((await api('POST', '/v1/ui', openUrl, CLAUDE)).status).toBe(400)
    const foreign = await api('POST', '/v1/ui', { ...approvalCard(2), sessionId: SHELL }, CLAUDE)
    expect(foreign.status).toBe(403)
    expect(foreign.json.error.code).toBe('not_your_session')
    expect((await api('POST', '/v1/ui', approvalCard(3))).json.error.code).toBe('session_required')
    // Only from the session itself: naming a session without being it is refused too.
    expect((await api('POST', '/v1/ui', { ...approvalCard(4), sessionId: CLAUDE })).json.error.code).toBe('session_required')
    // Data a bound part cannot show (an object where text goes) is refused before it reaches the renderer.
    const badData = await api('POST', '/v1/ui', { ...approvalCard(5), data: { title: { toString: 'oops' }, body: '', note: '' } }, CLAUDE)
    expect(badData.status).toBe(400)
    expect(badData.json.error.message).toMatch(/data at \/title/)

    const sent = await api('POST', '/v1/ui', approvalCard(324), CLAUDE)
    expect(sent.status).toBe(201)
    expect(sent.json.request.ui.components).toHaveLength(10)
    // MCP lists the tool and sends the same way (the shell session's card, from that session).
    const mcp = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(mcp.json.result.tools.map((t: { name: string }) => t.name)).toContain('show_ui')
    const viaMcp = await api('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'show_ui', arguments: approvalCard(77) } }, SHELL)
    expect(viaMcp.json.result.isError ?? false).toBe(false)

    // --- Drawn under the request -------------------------------------------
    const bell = page.locator('[data-testid="inbox-button"][data-inbox-placement="sidebar"]')
    await expect(bell).toHaveAttribute('data-unread', '2', { timeout: 10_000 })
    const roleBefore = await sessionRole(page, CLAUDE)
    await bell.click()
    const popover = page.getByTestId('inbox-popover')
    await expect(popover).toBeVisible()
    const claudeItem = popover.locator('li').filter({ has: page.locator('[data-inbox-request]', { hasText: 'Merge PR #324' }) })
    const card = claudeItem.getByTestId('agent-ui-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('PR #324 — merge?', { timeout: 10_000 })
    await expect(card).toContainText('docs(backlog) · 1 file · tests pass')
    const approve = card.getByRole('button', { name: 'Approve' })
    await expect(approve).toBeVisible()
    // The shell session has no agent to read an answer: its card is drawn but inert, and says why.
    const shellCard = popover.locator('li').filter({ has: page.locator('[data-inbox-request]', { hasText: 'Merge PR #77' }) }).getByTestId('agent-ui-card')
    await expect(shellCard).toHaveAttribute('data-state', 'disabled')
    await expect(shellCard.getByTestId('agent-ui-status')).toContainText(/no agent/i)
    await shot(page, 't194-card-1280')

    // --- A question on the agent's screen refuses the press; the card stays open --------------
    expect(await page.evaluate((id) => window.api.sendChatMessage(id, 'ASK').then((r) => r.status), CLAUDE)).toMatch(/^(sent|queued)$/)
    await expect.poll(() => terminalLines(page, CLAUDE), { timeout: 10_000 }).toContain('Do you want to proceed?')
    await approve.click()
    await expect(card).toHaveAttribute('data-state', 'rejected', { timeout: 10_000 })
    await expect(card.getByTestId('agent-ui-status')).toContainText('asking a question')
    expect(await terminalLines(page, CLAUDE)).not.toContain(PREFIX)
    await shot(page, 't194-refused-1280')
    // Answer the question in the terminal (Enter takes "1. Yes"), then press again.
    await page.evaluate((id) => window.api.writeTerminal(id, '\r'), CLAUDE)
    await expect.poll(() => terminalLines(page, CLAUDE), { timeout: 10_000 }).toContain('CHOSE:')

    // --- Type a note, press Approve: one line reaches the agent ------------
    const note = card.getByRole('textbox')
    await note.click()
    await page.keyboard.type('tests pass')
    // Esc in the field stays in the card: the popover does not close under the person's typing.
    await page.keyboard.press('Escape')
    await expect(popover).toBeVisible()
    await approve.click()
    await expect(card).toHaveAttribute('data-state', 'answered', { timeout: 10_000 })
    await expect.poll(() => terminalLines(page, CLAUDE), { timeout: 10_000 }).toContain(`ANSWER[`)
    const lines = await terminalLines(page, CLAUDE)
    expect(lines).toMatch(/ANSWER\[\d+\]: \[CLI Manager card\] approve \{"pr":324,"note":"tests pass"\}/)
    await shot(page, 't194-answered-1280')

    // Locked: another press sends nothing; the request is still unread; no AI mark.
    const firstRev = sent.json.request.ui.rev as string
    const again = await page.evaluate(({ id, rev }) => window.api.answerInboxUi(id, rev, 'no', {}), { id: sent.json.request.id, rev: firstRev })
    expect(again).toMatchObject({ status: 'rejected', reason: 'answered' })
    // One answer reached the agent (the terminal also echoes the typed line, so count the agent's ANSWER lines).
    expect((await terminalLines(page, CLAUDE)).match(/ANSWER\[\d+\]: \[CLI Manager card\]/g)?.length).toBe(1)
    await expect(claudeItem.locator('[data-inbox-request]')).toHaveAttribute('data-read', 'false')
    await expect(bell).toHaveAttribute('data-unread', '2')
    expect(await sessionRole(page, CLAUDE)).toBe(roleBefore)
    const listed = await api('GET', '/v1/inbox', undefined)
    const stored = listed.json.requests.find((r: { id: string }) => r.id === sent.json.request.id)
    expect(stored.ui.answered).toMatchObject({ action: 'approve', status: expect.stringMatching(/^(sent|queued)$/) })
    // The renderer cannot name something that is not a button.
    // The agent replaces the card with different content while the popover is open.
    const changed = approvalCard(999)
    changed.text = 'Merge PR #324?'
    const repeat = await api('POST', '/v1/ui', changed, CLAUDE)
    expect(repeat.status).toBe(200)
    expect(repeat.json.request.ui.rev).not.toBe(firstRev)
    // A press still aimed at the old card (drawn before the repeat) is refused — it would answer for PR 999.
    expect(await page.evaluate(({ id, rev }) => window.api.answerInboxUi(id, rev, 'ok', { note: 'x' }), { id: sent.json.request.id, rev: firstRev })).toMatchObject({ status: 'rejected', reason: 'replaced' })
    // With the popover still open, the repeat's card starts fresh: unlocked, the note empty again.
    await expect(card).not.toHaveAttribute('data-state', 'answered', { timeout: 10_000 })
    await expect(card.getByRole('textbox')).toHaveValue('')
    await expect(card).toContainText('PR #999 — merge?')
    await expect(card.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(await page.evaluate(({ id, rev }) => window.api.answerInboxUi(id, rev, 'note', {}), { id: sent.json.request.id, rev: repeat.json.request.ui.rev })).toMatchObject({ status: 'rejected', reason: 'not_a_button' })

    // --- 390 wide: the card fits the popover -------------------------------
    await page.keyboard.press('Escape')
    await resizeMainWindow(result!.app, 390, 800)
    // Narrow, the bell may sit in the main header instead of the sidebar.
    await page.locator('[data-testid="inbox-button"]:visible').first().click()
    const narrowCard = page.getByTestId('inbox-popover').getByTestId('agent-ui-card').first()
    await expect(narrowCard).toBeVisible()
    const box = await narrowCard.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    await shot(page, 't194-card-390')
    // The repeat replaced the card unanswered: Hold sends the other event.
    await narrowCard.getByRole('button', { name: 'Hold' }).click()
    await expect(narrowCard).toHaveAttribute('data-state', 'answered', { timeout: 10_000 })
    await expect.poll(() => terminalLines(page, CLAUDE), { timeout: 10_000 }).toMatch(/ANSWER\[\d+\]: \[CLI Manager card\] hold \{"pr":999\}/)
    await shot(page, 't194-answered-390')
})
