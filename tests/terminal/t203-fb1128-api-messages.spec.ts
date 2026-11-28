import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText, writeToTerminal } from './helpers'
import type { ConversationTurn } from '../../src/shared/conversation'
import { ApiInputLog, inputHash, markApiTurns, MATCH_WINDOW_MS, MAX_PER_SESSION, type ApiInputEntry } from '../../src/main/ApiInputLog'

/**
 * T203 — fb-1128 efa3932b: «Mine» leaves out what other sessions sent. The agent's record does not say who typed a
 * prompt; the app now keeps a hash of each message the Control API types (ApiInputLog) and marks the matching user
 * turn. Chat shows «From <session>» over it, and «Mine» hides it — the person's own words (typed in the terminal or
 * sent from the Chat) stay.
 *
 * T203_SHOTS=<dir> (+ T203_LABEL) saves captures before the checks.
 */

const LEAD = 't203-lead'
const WORKER = 't203-worker'
const CLAUDE_ID = '00000000-0000-4000-8000-00000000f203'
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const LABEL = process.env.T203_LABEL ?? 'run'
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

const at = (ms: number): string => new Date(ms).toISOString()
const user = (text: string, ms: number): ConversationTurn => ({ role: 'user', ts: at(ms), parts: [{ kind: 'text', text }] })
const reply = (ms: number): ConversationTurn => ({ role: 'assistant', ts: at(ms), parts: [{ kind: 'text', text: 'ok' }] })
const entry = (text: string, ms: number, extra: Partial<ApiInputEntry> = {}): ApiInputEntry => ({ h: inputHash(text), at: ms, ...extra })
const T0 = Date.parse('2026-11-28T09:00:00Z')

test.describe('T203 unit: which user turns the API typed', () => {
    test('an entry takes the first later turn with its words; the rest are the person\'s', () => {
        const turns = [user('ok', T0), reply(T0 + 1), user('ok', T0 + 60_000), reply(T0 + 60_001), user('ok', T0 + 120_000)]
        // the API sent «ok» once, at +50s: the person's «ok» before it and after it stay theirs
        const marked = markApiTurns(turns, [entry('ok', T0 + 50_000, { from: 'lead', client: 'clim' })], (id) => (id === 'lead' ? 'Event lead' : undefined))
        expect(marked.map((turn) => turn.via ?? null)).toEqual([null, null, { kind: 'api', from: 'Event lead', client: 'clim' }, null, null])
        // the turns given are not changed
        expect(turns.every((turn) => turn.via === undefined)).toBe(true)
    })
    test('a message typed while the agent works is recorded late: still matched within the window, not past it', () => {
        const late = [user('status please', T0 + 25 * 60_000)]
        expect(markApiTurns(late, [entry('status please', T0)])[0].via?.kind).toBe('api')
        const tooLate = [user('status please', T0 + MATCH_WINDOW_MS + 1)]
        expect(markApiTurns(tooLate, [entry('status please', T0)])[0].via).toBeUndefined()
    })
    test('spacing is not the words; a paste\'s lines match its one-line send; clock skew is allowed', () => {
        const turns = [user('line one\nline two', T0 - 5_000)]
        expect(markApiTurns(turns, [entry('  line one  line two ', T0)])[0].via?.kind).toBe('api')
        expect(markApiTurns([user('x', T0 - 60_000)], [entry('x', T0)])[0].via).toBeUndefined()
    })
    test('two sends of the same words take two turns, a third turn is the person\'s', () => {
        const turns = [user('go on', T0 + 1000), reply(T0 + 2000), user('go on', T0 + 3000), reply(T0 + 4000), user('go on', T0 + 5000)]
        const marked = markApiTurns(turns, [entry('go on', T0), entry('go on', T0 + 2500)])
        expect(marked.map((turn) => turn.via?.kind ?? '-')).toEqual(['api', '-', 'api', '-', '-'])
    })
    test('the name of the sending session is read now; the one kept at send time when it is gone; none without a sender', () => {
        const turns = [user('a', T0 + 1), user('b', T0 + 2), user('c', T0 + 3)]
        const marked = markApiTurns(turns, [entry('a', T0, { from: 'gone', fromName: 'Old lead' }), entry('b', T0, { from: 'live', fromName: 'Before rename' }), entry('c', T0, { client: 'autocron' })], (id) => (id === 'live' ? 'Renamed lead' : undefined))
        expect(marked.map((turn) => turn.via)).toEqual([{ kind: 'api', from: 'Old lead' }, { kind: 'api', from: 'Renamed lead' }, { kind: 'api', client: 'autocron' }])
    })
    test('the log keeps hashes only, survives a restart, caps each session, forgets closed sessions', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t203-unit-'))
        const file = path.join(dir, 'api-inputs.json')
        let now = T0
        const log = new ApiInputLog(file, () => now)
        log.note('s1', 'the secret plan words', { callerId: 'lead', callerName: 'Lead', client: 'clim' })
        log.note('s1', '   ')
        log.note('s1', 'echo', { callerId: 's1' })
        for (let i = 0; i < MAX_PER_SESSION + 5; i++) { now++; log.note('s2', `n${i}`) }
        log.flush()
        const text = fs.readFileSync(file, 'utf8')
        expect(text).not.toContain('secret plan')
        expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')
        const again = new ApiInputLog(file)
        expect(again.entries('s1')).toEqual([{ h: inputHash('the secret plan words'), at: T0, from: 'lead', fromName: 'Lead', client: 'clim' }, { h: inputHash('echo'), at: T0 }])
        expect(again.entries('s2')).toHaveLength(MAX_PER_SESSION)
        expect(again.entries('s2')[0].h).toBe(inputHash('n5'))
        again.forget('s1')
        again.prune(['s2', 's3'])
        again.flush()
        expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).sessions)).toEqual(['s2'])
        fs.rmSync(dir, { recursive: true, force: true })
    })
})

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T203_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

test('T203 efa3932b: a message another session sent is marked «From …», and «Mine» hides it', async () => {
    test.setTimeout(150_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t203-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t203', name: 'T203 project', path: project, sessions: [
            { id: WORKER, name: 'T203 Worker', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300` },
            { id: LEAD, name: 'T203 Event lead' }
        ] }],
        {
            settings: { controlApi: { enabled: true, port: 0 } },
            env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, 'codex'), CLIMANAGER_HOME: path.join(home, 'clim') }
        }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, WORKER, 'Claude Code (mock)', 20_000)
    const discoveryPath = path.join(home, 'clim', 'control-api.json')
    await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8')) as { url: string; token: string }
    const send = async (text: string): Promise<number> => {
        const res = await fetch(`${discovery.url}/v1/sessions/${WORKER}/input`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't203', 'X-Caller-Session': LEAD },
            body: JSON.stringify({ text })
        })
        return res.status
    }

    // the person types in the terminal, the event lead sends through the API, the person sends from the Chat
    await writeToTerminal(page, WORKER, 'typed by the person\r')
    await waitForBufferText(page, WORKER, 'ANSWER[1]: typed by the person', 10_000)
    await waitForBufferText(page, WORKER, 'Echo: typed by the person', 10_000)
    expect(await send('[Event lead] status please')).toBe(200)
    await waitForBufferText(page, WORKER, 'ANSWER[2]: [Event lead] status please', 10_000)
    await waitForBufferText(page, WORKER, 'Echo: [Event lead] status please', 10_000)

    await page.getByText('T203 Worker', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    const chat = page.locator('[data-testid="chat-view"][data-session-id]:visible')
    const composer = chat.getByTestId('chat-composer')
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill('sent from the chat')
    await composer.press('Enter')
    await waitForBufferText(page, WORKER, 'ANSWER[3]: sent from the chat', 10_000)

    const bubble = (words: string) => chat.locator('[data-testid="chat-turn"][data-role="user"]').filter({ hasText: words })
    await expect(bubble('sent from the chat')).toHaveCount(1, { timeout: 10_000 })
    await expect(bubble('[Event lead] status please')).toHaveCount(1)
    // off: everything shows; the API's message says who sent it, the person's say nothing
    await expect(bubble('[Event lead] status please').getByTestId('chat-api-mark')).toHaveText('From T203 Event lead')
    await expect(bubble('typed by the person').getByTestId('chat-api-mark')).toHaveCount(0)
    await expect(bubble('sent from the chat').getByTestId('chat-api-mark')).toHaveCount(0)
    await shot(page, 't203-1-all')

    // Mine: only the person's (before: the API's message stayed as one of «mine»)
    await chat.getByTestId('chat-only-mine').click()
    await expect(bubble('typed by the person')).toHaveCount(1)
    await expect(bubble('sent from the chat')).toHaveCount(1)
    await expect(bubble('[Event lead] status please')).toHaveCount(0)
    await expect(chat.locator('[data-testid="chat-turn"][data-role="assistant"]')).toHaveCount(0)
    await shot(page, 't203-2-mine')

    // the app keeps no words, only hashes
    const kept = path.join(result.userDataDir, 'api-inputs.json')
    await expect.poll(() => fs.existsSync(kept), { timeout: 5000 }).toBe(true)
    expect(fs.readFileSync(kept, 'utf8')).not.toContain('status please')
})
