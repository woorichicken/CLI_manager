import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'
import { dockOpenRequest, openInDock } from '../../src/main/dockOpen'

/**
 * T140 — fc98b340: a web page named in the Chat opened in Chrome and closed again, every click.
 *
 * `shell.openPath` asks Chrome for a new tab; Artifact Dock, already holding that page, closes the new tab as a
 * duplicate (and its focus guard leaves the old tab where it was). The fix asks the Dock itself (`open` · `activate`)
 * when it is there and keeps `shell.openPath` for a Mac without it.
 *
 *  units: the request line · ok → opened · refusal / no socket / hang-up / silence → unavailable
 *  app: a fake Dock socket (`ARTIFACT_DOCK_SOCKET`) gets the click, `shell.openPath` does not; the Dock refusing → the Mac's opener
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const CLAUDE = 't140-claude'
const CLAUDE_ID = '00000000-0000-4000-8000-0000000c1400'

interface FakeDock {
    socketPath: string
    lines: string[]
    reply: (line: string) => string | null
    close(): Promise<void>
}

/** A Unix socket that answers one JSON line per request, like the Dock host. `reply` returning null hangs up. */
async function fakeDock(dir: string, reply: (line: string) => string | null): Promise<FakeDock> {
    const socketPath = path.join(dir, 'dock.sock')
    const dock: FakeDock = { socketPath, lines: [], reply, close: async () => {} }
    const server = net.createServer((socket) => {
        let buffer = ''
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8')
            const end = buffer.indexOf('\n')
            if (end === -1) return
            const line = buffer.slice(0, end)
            dock.lines.push(line)
            const answer = dock.reply(line)
            if (answer === null) socket.destroy()
            else socket.end(`${answer}\n`)
        })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    dock.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
    return dock
}

test.describe('T140 units', () => {
    let dir = ''
    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 't140-'))
    })
    test.afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    test('the request is the one artifact-open sends: open · file URL · activate · session', () => {
        const file = '/Users/me/보고서 1/report.html'
        expect(JSON.parse(dockOpenRequest(file, 'abc-123'))).toEqual({ cmd: 'open', url: pathToFileURL(file).href, activate: true, sessionId: 'abc-123' })
        expect(dockOpenRequest(file).endsWith('\n')).toBe(true)
        expect(JSON.parse(dockOpenRequest(file, 'bad id; rm')), 'an odd session id is left out').not.toHaveProperty('sessionId')
    })

    test('ok → opened; a refusal, no socket, a hang-up or silence → unavailable', async () => {
        const dock = await fakeDock(dir, () => JSON.stringify({ ok: true, reused: true }))
        expect(await openInDock(dock.socketPath, '/tmp/a.html', 's1')).toBe('opened')
        expect(JSON.parse(dock.lines[0])).toMatchObject({ cmd: 'open', url: 'file:///tmp/a.html', activate: true, sessionId: 's1' })
        dock.reply = () => JSON.stringify({ ok: false, error: 'no' })
        expect(await openInDock(dock.socketPath, '/tmp/a.html')).toBe('unavailable')
        dock.reply = () => 'not json'
        expect(await openInDock(dock.socketPath, '/tmp/a.html')).toBe('unavailable')
        dock.reply = () => null
        expect(await openInDock(dock.socketPath, '/tmp/a.html')).toBe('unavailable')
        await dock.close()
        expect(await openInDock(path.join(dir, 'missing.sock'), '/tmp/a.html')).toBe('unavailable')
        expect(await openInDock(null, '/tmp/a.html')).toBe('unavailable')
        // a host that never answers: the Mac's opener takes over after the timeout
        const silent = net.createServer(() => {})
        const silentPath = path.join(dir, 'silent.sock')
        await new Promise<void>((resolve) => silent.listen(silentPath, resolve))
        const started = Date.now()
        expect(await openInDock(silentPath, '/tmp/a.html', undefined, 300)).toBe('unavailable')
        expect(Date.now() - started).toBeLessThan(2_000)
        await new Promise<void>((resolve) => silent.close(() => resolve()))
    })
})

let result: LaunchResult | null = null
let dock: FakeDock | null = null
test.afterEach(async () => {
    if (dock) await dock.close()
    dock = null
    if (result) await closeApp(result)
    result = null
})

const chat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:visible')

async function launch(dir: string): Promise<{ page: Page; report: string; opened: () => Promise<string[]> }> {
    const project = path.join(dir, 'project')
    fs.mkdirSync(project, { recursive: true })
    const report = path.join(project, 'report.html')
    fs.writeFileSync(report, '<!doctype html>\n<html><head><title>T140</title></head><body>T140</body></html>\n')
    const claudeDir = path.join(dir, 'claude')
    const transcript = path.join(claudeDir, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    const ts = (n: number): string => new Date(Date.UTC(2026, 10, 14, 1, 0, n)).toISOString()
    fs.writeFileSync(transcript, [
        { type: 'user', uuid: '00000000-0000-4000-8000-000000000001', timestamp: ts(1), message: { role: 'user', content: '보고서 어디 있어?' } },
        { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000002', timestamp: ts(2), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The page is report.html — open it.' }] } }
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t140', name: 'T140 project', path: project, sessions: [{ id: CLAUDE, name: 'T140 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --continue --mode-row none` }] }],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, ARTIFACT_DOCK_SOCKET: path.join(dir, 'dock.sock') } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await app.evaluate(({ shell }) => {
        const opened: string[] = []
        ;(globalThis as unknown as { __opened: string[] }).__opened = opened
        shell.openPath = async (target: string) => {
            opened.push(target)
            return ''
        }
    })
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)
    await page.getByText('T140 Claude', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page).getByTestId('chat-composer')).toBeVisible()
    return { page, report, opened: () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened) }
}

test('T140 Mac Chat: a web page goes to Artifact Dock, not to a Chrome tab the Dock closes (fc98b340)', async () => {
    test.setTimeout(120_000)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't140-app-'))
    dock = await fakeDock(dir, () => JSON.stringify({ ok: true, reused: true }))
    const { page, report, opened } = await launch(dir)
    const link = chat(page).getByRole('button', { name: 'report.html', exact: true }).first()
    await link.click()
    await expect.poll(() => dock!.lines.length).toBe(1)
    expect(JSON.parse(dock.lines[0])).toEqual({ cmd: 'open', url: pathToFileURL(report).href, activate: true, sessionId: CLAUDE })
    // clicking again asks the Dock again — never a second Chrome tab
    await link.click()
    await expect.poll(() => dock!.lines.length).toBe(2)
    await page.waitForTimeout(500)
    expect(await opened()).toEqual([])
    await expect(page.getByTestId('chat-file-preview')).toHaveCount(0)
})

test('T140 Mac Chat: when the Dock cannot open it, the Mac\'s own opener does (fc98b340)', async () => {
    test.setTimeout(120_000)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't140-app-'))
    dock = await fakeDock(dir, () => JSON.stringify({ ok: false, error: 'host not ready' }))
    const { page, report, opened } = await launch(dir)
    await chat(page).getByRole('button', { name: 'report.html', exact: true }).first().click()
    await expect.poll(opened).toEqual([report])
    expect(dock.lines.length).toBe(1)
})
