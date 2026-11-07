import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, termText, waitForBufferText } from './helpers'

const ID = '00000000-0000-4000-8000-00000000d104'
const SESSION = 'd104-shell'
const REVIEW = process.env.D104_SHOTS_DIR || path.join(REPO_ROOT, 'tests/terminal/results/d104-review')
let result: LaunchResult | null = null
test.afterEach(async () => { if (result) await closeApp(result); result = null })

function reviewHome() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-d104-review-')))
    const home = path.join(root, 'home')
    const project = path.join(root, 'project')
    const codex = path.join(root, 'codex')
    const claude = path.join(root, 'claude')
    const manager = path.join(root, 'manager')
    for (const dir of [home, project, codex, claude, manager]) fs.mkdirSync(dir)
    fs.writeFileSync(path.join(home, '.zshrc'), "PROMPT='READY> '\nunset HISTFILE\n")
    return { root, project, codex, claude, manager, env: { HOME: home, ZDOTDIR: home, SHELL: '/bin/zsh', CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, CLIMANAGER_HOME: manager } }
}

test('T104 review shell right prompt is display text, not an entered draft', async () => {
    const x = reviewHome()
    fs.appendFileSync(path.join(x.env.HOME, '.zshrc'), "RPROMPT='D104 right status'\n")
    const now = new Date()
    const folder = path.join(x.codex, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, `rollout-${ID}.jsonl`), [
        { type: 'session_meta', payload: { id: ID, timestamp: now.toISOString(), cwd: x.project, source: 'cli', originator: 'codex-tui' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Right prompt test' } }
    ].map((r) => JSON.stringify(r)).join('\n') + '\n')
    const binDir = path.join(x.root, 'bin'); fs.mkdirSync(binDir)
    const bin = path.join(binDir, 'codex')
    fs.writeFileSync(bin, '#!/bin/sh\necho RIGHT-PROMPT-RESUME\n', { mode: 0o755 })
    result = await launchAppWithWorkspaces([{ id: 'right', name: 'Right prompt', path: x.project, sessions: [{ id: 'right', name: 'Right', cliToolName: 'codex', cliCommand: bin }] }], { env: x.env })
    await waitForBufferText(result.page, 'right', 'D104 right status', 5000)
    const connected = await result.page.evaluate((id) => window.api.connectAgentConversation('right', { agent: 'codex', id, resume: true }), ID)
    expect(connected).toMatchObject({ status: 'connected', typed: true })
    await waitForBufferText(result.page, 'right', 'RIGHT-PROMPT-RESUME', 5000)
})

test('T104 review A1: missing Claude storage is unknown while stale Codex ids are checked', async () => {
    const x = reviewHome()
    result = await launchAppWithWorkspaces([{ id: 'review', name: 'Review project', path: x.project, sessions: [
        { id: 'claude-missing', name: 'Claude missing', cliSessionId: ID, cliToolName: 'claude', cliCommand: '/usr/bin/true' },
        { id: 'codex-stale', name: 'Codex stale', cliSessionId: ID, cliToolName: 'codex', cliCommand: '/usr/bin/true' }
    ] }], { env: x.env })
    const sessions = JSON.parse(fs.readFileSync(path.join(result.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'review').sessions
    expect(sessions.find((s: any) => s.id === 'claude-missing')).toMatchObject({ cliSessionId: ID, cliToolName: 'claude', cliCommand: '/usr/bin/true' })
    expect(sessions.find((s: any) => s.id === 'codex-stale').cliSessionId).toBeUndefined()
})

test('T104 review A2-A6: resume preserves shell drafts/questions and records API input truthfully', async () => {
    const x = reviewHome()
    const now = new Date()
    const folder = path.join(x.codex, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    fs.mkdirSync(folder, { recursive: true })
    const names = ['draft', 'read', 'quote', 'bash', 'plain', 'caller']
    const ids = names.map((_, i) => `00000000-0000-4000-8000-${String(104000 + i).padStart(12, '0')}`)
    for (const id of ids) fs.writeFileSync(path.join(folder, `rollout-${id}.jsonl`), [
        { type: 'session_meta', payload: { id, timestamp: now.toISOString(), cwd: x.project, source: 'cli', originator: 'codex-tui' } },
        { type: 'event_msg', payload: { type: 'user_message', message: `First ${id}` } }
    ].map((r) => JSON.stringify(r)).join('\n') + '\n')
    const binDir = path.join(x.root, 'bin'); fs.mkdirSync(binDir)
    const bin = path.join(binDir, 'codex')
    const starts = path.join(x.root, 'starts.txt')
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${starts}'\necho D104-COMMAND-EXITED\n`, { mode: 0o755 })
    result = await launchAppWithWorkspaces([{ id: 'review', name: 'Review project', path: x.project, sessions: names.map((name) => ({ id: name, name, cliToolName: 'codex', cliCommand: bin })) }], { env: x.env, settings: { controlApi: { enabled: true, port: 0 } } })
    const { page } = result
    const saved = (id: string) => JSON.parse(fs.readFileSync(path.join(result!.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'review').sessions.find((s: any) => s.id === id)
    const discovery = JSON.parse(fs.readFileSync(path.join(x.manager, 'control-api.json'), 'utf8'))
    const api = async (route: string, body?: unknown) => {
        const response = await fetch(discovery.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 'd104-review', 'X-Caller-Session': 'caller' }, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: response.status, body: await response.json() as any }
    }
    const type = async (id: string, text: string) => { for (const character of text) await page.evaluate(([sid, data]) => window.api.writeTerminal(sid, data), [id, character]) }
    const connect = (id: string) => api(`/v1/sessions/${id}/conversation`, { agent: 'codex', id: ids[names.indexOf(id)], resume: true })
    for (const name of names) await waitForBufferText(page, name, 'READY>', 15_000)
    await type('draft', 'git commit -m "half written message')
    await waitForBufferText(page, 'draft', 'half written message', 5000)
    expect(await connect('draft')).toMatchObject({ status: 409, body: { error: { code: 'input_busy' } } })
    expect(await termText(page, 'draft')).toContain('half written message')
    expect(saved('draft').cliSessionId).toBeUndefined()
    await page.evaluate(() => window.api.writeTerminal('read', 'read "x?Do you want to proceed? "; echo "ANSWER=[$x]"\r'))
    await waitForBufferText(page, 'read', 'Do you want to proceed?', 5000)
    expect(await connect('read')).toMatchObject({ status: 409, body: { error: { code: 'awaiting_input' } } })
    expect(saved('read').cliSessionId).toBeUndefined()
    expect(await termText(page, 'read')).not.toContain('ANSWER=[resume')
    await page.evaluate(() => window.api.writeTerminal('quote', 'echo "\r'))
    await waitForBufferText(page, 'quote', 'dquote>', 5000)
    expect(await connect('quote')).toMatchObject({ status: 409, body: { error: { code: 'input_busy' } } })
    expect(saved('quote').cliSessionId).toBeUndefined()
    await page.evaluate(() => window.api.writeTerminal('bash', 'exec /bin/bash --norc --noprofile\r'))
    await waitForBufferText(page, 'bash', 'bash-', 5000)
    await type('bash', 'foo bar')
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.api.writeTerminal('bash', '\x1b[D'))
    expect(await connect('bash')).toMatchObject({ status: 409, body: { error: { code: 'input_busy' } } })
    expect(await termText(page, 'bash')).toContain('foo bar')
    expect(saved('bash').cliSessionId).toBeUndefined()
    expect(fs.existsSync(starts)).toBe(false)
    expect(await connect('plain')).toMatchObject({ status: 200, body: { status: 'connected', typed: true } })
    expect(saved('plain').aiControl).toMatchObject({ client: 'd104-review' })
    await waitForBufferText(page, 'plain', 'D104-COMMAND-EXITED', 5000)
    expect(fs.readFileSync(starts, 'utf8').trim()).toBe(`resume ${ids[4]}`)
    const relations = await api('/v1/sessions/plain/relations')
    expect(JSON.stringify(relations.body)).toContain('caller')
    const openDialog = async (name: string) => {
        await page.getByText(name, { exact: true }).first().click()
        await page.getByText(name, { exact: true }).first().click({ button: 'right' })
        await page.getByTestId('connect-agent-conversation').click()
        return page.getByTestId('connect-conversation-dialog')
    }
    const shot = async (name: string) => {
        if (process.env.D104_SHOTS) { fs.mkdirSync(REVIEW, { recursive: true }); await page.screenshot({ path: path.join(REVIEW, name) }) }
    }
    for (const [name, message, filename] of [['draft', 'Finish or cancel', 'after-input-busy.png'], ['read', 'Answer the question', 'after-awaiting-input.png']]) {
        const dialog = await openDialog(name)
        await dialog.getByTestId('conversation-connect').click()
        await expect(dialog.getByTestId('conversation-error')).toContainText(message)
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
        await expect(dialog.locator('[aria-busy=true]')).toHaveCount(0)
        await shot(filename)
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(dialog).toHaveCount(0)
    }
    // A quickly exiting stand-in may legitimately be observed. Fail before launching it instead.
    await page.evaluate(([id, command]) => window.api.updateSessionCliInfo('review', 'plain', id, 'codex', command), [ids[4], `false && ${bin}`])
    const dialog = await openDialog('plain')
    await dialog.getByTestId('conversation-connect').click()
    await expect(dialog.getByTestId('conversation-resume-pending')).toContainText('has not started')
    await expect(dialog.getByTestId('conversation-connect')).toHaveCount(0)
    await shot('after-unconfirmed-resume.png')
    await dialog.getByRole('button', { name: 'Refresh conversations' }).click()
    await expect(dialog.getByTestId('conversation-connect')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
})

test('T104 menu connects, persists options, shows Chat and resumes once after restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-d104-'))
    const project = path.join(root, 'project')
    const codexHome = path.join(root, 'codex')
    const claudeConfig = path.join(root, 'claude')
    fs.mkdirSync(project)
    const date = new Date()
    const rollout = path.join(codexHome, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'), `rollout-test-${ID}.jsonl`)
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    fs.mkdirSync(claudeConfig)
    const records = fs.readFileSync(path.join(__dirname, 'fixtures/transcripts/codex/rollout-2026-11-03T10-00-00-00000000-0000-4000-8000-0000000000c1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    records[0].payload = { ...records[0].payload, id: ID, cwd: project, timestamp: date.toISOString(), source: 'vscode', originator: 'codex-tui' }
    fs.writeFileSync(rollout, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    const mock = path.join(root, 'codex') + '-bin'
    fs.mkdirSync(mock)
    const executable = path.join(mock, 'codex')
    const starts = path.join(root, 'starts.txt')
    const titleBootstrap = path.join(root, 'title.cjs')
    fs.writeFileSync(titleBootstrap, "const i = process.argv.indexOf('resume'); process.title = 'codex resume ' + process.argv[i + 1];")
    fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${starts}'\nexec '${process.execPath}' --require '${titleBootstrap}' '${path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')}' --agent codex --transcript '${rollout}' --continue --work-ms 100 \"$@\"\n`, { mode: 0o755 })
    const command = `${executable} --model gpt-test --dangerously-bypass-approvals-and-sandbox`
    const home = path.join(root, 'home'); fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, '.zshrc'), "PROMPT='READY> '\nunset HISTFILE\n")
    const env = { HOME: home, ZDOTDIR: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeConfig, CLIMANAGER_HOME: path.join(root, 'manager') }
    result = await launchAppWithWorkspaces([{ id: 'd104', name: 'D104 project', path: project, sessions: [{ id: SESSION, name: 'D104 Shell', cliToolName: 'codex', cliCommand: command }, { id: 'd104-other', name: 'D104 Other' }] }], { env, settings: { controlApi: { enabled: true, port: 0 } } })
    const discoveryFile = path.join(env.CLIMANAGER_HOME, 'control-api.json')
    await expect.poll(() => fs.existsSync(discoveryFile)).toBe(true)
    const discovery = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'))
    const api = async (route: string, body?: unknown) => {
        const response = await fetch(discovery.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: response.status, body: await response.json() as any }
    }
    const listed = await api(`/v1/sessions/${SESSION}/conversations`)
    expect(listed).toMatchObject({ status: 200, body: { front: { kind: 'shell' }, items: [{ id: ID, agent: 'codex' }] } })
    expect(JSON.stringify(listed.body)).not.toContain(rollout)
    expect(await api(`/v1/sessions/${SESSION}/conversation`, { agent: 'codex', id: 'invalid; touch /tmp/oops' })).toMatchObject({ status: 400, body: { error: { code: 'invalid_id' } } })
    expect(await api('/v1/sessions/absent/conversations')).toMatchObject({ status: 404, body: { error: { code: 'unknown_session' } } })
    const rpc = await api('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(rpc.body.result.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(['list_agent_conversations', 'connect_agent_conversation']))
    const rpcInvalid = await api('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'connect_agent_conversation', arguments: { session_id: SESSION, agent: 'codex', id: 'invalid' } } })
    expect(rpcInvalid.body.result).toMatchObject({ isError: true })
    expect(rpcInvalid.body.result.content[0].text).toContain('invalid_id')
    let { page } = result
    await resizeMainWindow(result.app, 1280, 800)
    await page.getByText('D104 Shell', { exact: true }).first().click()
    await page.getByText('D104 Shell', { exact: true }).first().click({ button: 'right' })
    fs.mkdirSync(REVIEW, { recursive: true })
    if (process.env.D104_SHOTS) await page.screenshot({ path: path.join(REVIEW, `${process.env.D104_LABEL || 'after'}-menu.png`) })
    await expect(page.getByTestId('connect-agent-conversation')).toBeVisible({ timeout: 3000 })
    await page.getByTestId('connect-agent-conversation').click()
    const dialog = page.getByTestId('connect-conversation-dialog')
    await expect(dialog).toContainText('In front: shell')
    await expect(dialog).toContainText('List the files')
    if (process.env.D104_SHOTS) await page.screenshot({ path: path.join(REVIEW, 'after-shell-dialog.png') })
    await dialog.locator(`[data-conversation-id="${ID}"]`).click()
    await expect(dialog.getByTestId('conversation-connect')).toHaveText('Connect & resume')
    await dialog.getByTestId('conversation-connect').click()
    await expect(dialog).toHaveCount(0)
    await waitForBufferText(page, SESSION, 'OpenAI Codex (mock)', 15_000)
    const saved = () => JSON.parse(fs.readFileSync(path.join(result!.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'd104').sessions[0]
    await expect.poll(saved).toMatchObject({ cliSessionId: ID, cliToolName: 'codex', cliCommand: command })
    expect(await api('/v1/sessions/d104-other/conversation', { agent: 'codex', id: ID })).toMatchObject({ status: 409, body: { error: { code: 'linked_elsewhere', linkedTo: { sessionId: SESSION, name: 'D104 Shell' } } } })
    await page.getByTestId('view-toggle-chat').click()
    await expect(page.getByTestId('chat-view')).toContainText('List the files')
    if (process.env.D104_SHOTS) await page.screenshot({ path: path.join(REVIEW, 'after-connected-chat.png') })
    expect(fs.readFileSync(starts, 'utf8').trim().split('\n')).toEqual([`--model gpt-test --dangerously-bypass-approvals-and-sandbox resume ${ID}`])

    // A renderer reload attaches to the live PTY; a real app restart creates one resume.
    await page.reload()
    await page.getByText('D104 Shell', { exact: true }).first().click()
    await expect(page.getByTestId('view-toggle')).toBeVisible()
    expect(fs.readFileSync(starts, 'utf8').trim().split('\n')).toHaveLength(1)
    const userDataDir = result.userDataDir
    await result.app.close()
    const app = await electron.launch({ args: [path.join(REPO_ROOT, 'out/main/index.js')], env: { ...process.env, ...env, CLIMANGER_TEST_USERDATA: userDataDir, CLIMANGER_TERM_DEBUG: '1', CLIMANGER_TEST_HEADLESS: '1' } as Record<string, string> })
    page = await app.firstWindow()
    result = { app, page, userDataDir, pageErrors: [], consoleErrors: [] }
    await page.waitForFunction(() => !!(window as any).__termDebug?.ids().includes('d104-shell'))
    await page.getByText('D104 Shell', { exact: true }).first().click()
    await waitForBufferText(page, SESSION, 'OpenAI Codex (mock)', 20_000)
    await expect.poll(() => fs.readFileSync(starts, 'utf8').trim().split('\n').length).toBe(2)
    await page.reload()
    await page.getByText('D104 Shell', { exact: true }).first().click()
    await expect(page.getByTestId('view-toggle')).toBeVisible()
    expect(fs.readFileSync(starts, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(await termText(page, SESSION)).toContain('OpenAI Codex (mock)')
})

test('T104 foreground policy: Claude, held Codex, unheld Codex and other programs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-d104-front-'))
    const cwd = path.join(root, 'project')
    const codexHome = path.join(root, 'codex')
    const claudeDir = path.join(root, 'claude')
    fs.mkdirSync(cwd)
    const ids = ['00000000-0000-4000-8000-00000000d141', '00000000-0000-4000-8000-00000000d142']
    const day = new Date().toISOString().slice(0, 10).split('-')
    const folder = path.join(codexHome, 'sessions', ...day)
    fs.mkdirSync(folder, { recursive: true })
    const rollouts = ids.map((id, i) => {
        const file = path.join(folder, `rollout-test-${id}.jsonl`)
        const at = new Date(Date.now() + (i ? -60_000 : 0)).toISOString()
        fs.writeFileSync(file, [
            { timestamp: at, type: 'session_meta', payload: { id, timestamp: at, cwd, source: 'cli', originator: 'codex-tui' } },
            { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: `D104 candidate ${i + 1}`, kind: 'plain' } }
        ].map((record) => JSON.stringify(record)).join('\n') + '\n')
        return file
    })
    const claudeId = '00000000-0000-4000-8000-00000000d143'
    const projectDir = path.join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    const claudeFile = path.join(projectDir, `${claudeId}.jsonl`)
    fs.writeFileSync(claudeFile, JSON.stringify({ type: 'user', uuid: 'user1', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'D104 Claude candidate' } }) + '\n')
    // Name real foreground processes and optionally hold a file, without using installed agents.
    const bootstrap = path.join(root, 'foreground.cjs')
    fs.writeFileSync(bootstrap, `const fs = require('fs'); process.title = process.env.D104_FRONT;
if (process.env.D104_HOLD) fs.openSync(process.env.D104_HOLD, 'r');
if (process.env.D104_TOUCH_META) { const file = process.env.D104_TOUCH_META; const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\\n'); const meta = JSON.parse(lines[0]); meta.payload.timestamp = new Date().toISOString(); lines[0] = JSON.stringify(meta); fs.writeFileSync(file, lines.join('\\n') + '\\n'); }
if (process.env.D104_FRONT === 'claude') { fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR + '/sessions', {recursive:true}); fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/sessions/' + process.pid + '.json', JSON.stringify({pid:process.pid, sessionId:'${claudeId}', cwd:process.cwd(), startedAt:Date.now()})); }
`)
    const run = (kind: string, agent: string, transcript: string, held = '') => `D104_FRONT=${kind} D104_HOLD='${held}' D104_TOUCH_META='${kind === 'codex' && !held ? transcript : ''}' '${process.execPath}' --require '${bootstrap}' '${path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')}' --agent ${agent} --transcript '${transcript}' --continue`
    const sessions = [
        { id: 'd104-claude', name: 'D104 Claude', initialCommand: run('claude', 'claude', claudeFile) },
        { id: 'd104-held', name: 'D104 Held', initialCommand: run('codex', 'codex', rollouts[0], rollouts[0]) },
        { id: 'd104-unheld', name: 'D104 Unheld', initialCommand: run('codex', 'codex', rollouts[0]) },
        { id: 'd104-program', name: 'D104 Program', initialCommand: run('d104program', 'codex', rollouts[0]) }
    ]
    const home = path.join(root, 'home'); fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, '.zshrc'), "PROMPT='READY> '\nunset HISTFILE\n")
    result = await launchAppWithWorkspaces([{ id: 'd104-front', name: 'D104 foreground', path: cwd, sessions }], { env: { HOME: home, ZDOTDIR: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeDir, CLIMANAGER_HOME: path.join(root, 'manager'), CLIMANAGER_CLAUDE_SYNC_MS: '3600000' } })
    const { page } = result
    await resizeMainWindow(result.app, 1280, 800)
    const shot = async (name: string) => {
        if (process.env.D104_SHOTS) { fs.mkdirSync(REVIEW, { recursive: true }); await page.screenshot({ path: path.join(REVIEW, name) }) }
    }
    for (const session of sessions) {
        await waitForBufferText(page, session.id, session.id === 'd104-claude' ? 'Claude Code (mock)' : 'OpenAI Codex (mock)', 15_000)
        await page.getByText(session.name, { exact: true }).first().click()
        await page.getByText(session.name, { exact: true }).first().click({ button: 'right' })
        await page.getByTestId('connect-agent-conversation').click()
        const dialog = page.getByTestId('connect-conversation-dialog')
        const row = (id: string) => dialog.locator(`[data-conversation-id="${id}"]`)
        if (session.id === 'd104-claude') {
            await expect(dialog).toContainText('Exit Claude first')
            await expect(dialog.getByTestId('conversation-connect')).toHaveCount(0)
            const denied = await page.evaluate(([id, conversation]) => window.api.connectAgentConversation(id, { agent: 'codex', id: conversation, force: true }), [session.id, ids[1]])
            expect(denied).toMatchObject({ error: { code: 'agent_running', runningId: claudeId } })
            for (const character of `codex resume ${ids[1]}\r`) await page.evaluate(([id, data]) => window.api.writeTerminal(id, data), [session.id, character])
            await waitForBufferText(page, session.id, 'ANSWER[1]', 5000)
            const saved = JSON.parse(fs.readFileSync(path.join(result!.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'd104-front').sessions.find((s: any) => s.id === session.id)
            expect(saved.cliToolName).not.toBe('codex')
        } else if (session.id === 'd104-held') {
            await expect(row(ids[0])).toContainText('Running here')
            await expect(row(ids[1]).locator('input')).toBeDisabled()
        } else if (session.id === 'd104-unheld') {
            await expect(row(claudeId).locator('input')).toBeDisabled()
            await expect(row(ids[0])).toContainText('Started here')
            await row(ids[1]).click()
            await expect(dialog.getByTestId('conversation-connect')).toHaveText('Connect anyway')
            const denied = await page.evaluate(([id, conversation]) => window.api.connectAgentConversation(id, { agent: 'codex', id: conversation }), [session.id, ids[1]])
            expect(denied).toMatchObject({ error: { code: 'not_started_here' } })
        } else {
            await expect(dialog.getByTestId('conversation-front')).toHaveText('In front: other')
            await expect(dialog.getByTestId('conversation-connect')).toHaveText('Connect')
        }
        await shot(`after-${session.id}-dialog.png`)
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
    }
    // Exercise transport states without depending on filesystem errors or machine speed.
    const list = await page.evaluate(() => window.api.listAgentConversations('d104-program'))
    if ('error' in list) throw new Error(list.error.message)
    await result.app.evaluate(({ ipcMain }, snapshot) => {
        ipcMain.removeHandler('agent-conversations-list')
        ipcMain.handle('agent-conversations-list', () => ({ ...snapshot, items: [], truncated: false }))
    }, list)
    const reopen = async () => {
        await page.getByText('D104 Program', { exact: true }).first().click({ button: 'right' })
        await page.getByTestId('connect-agent-conversation').click()
        return page.getByTestId('connect-conversation-dialog')
    }
    let dialog = await reopen()
    await expect(dialog).toContainText('No conversations')
    await expect(dialog.getByTestId('conversation-connect')).toBeDisabled()
    await shot('after-empty-dialog.png')
    await page.keyboard.press('Escape')
    await result.app.evaluate(({ ipcMain }, snapshot) => {
        ipcMain.removeHandler('agent-conversations-list')
        ipcMain.handle('agent-conversations-list', async () => {
            await new Promise(resolve => setTimeout(resolve, 2000))
            return { ...snapshot, truncated: true, items: snapshot.items.map((item, i) => i ? item : { ...item, linkedTo: { sessionId: 'another', name: 'Other terminal' } }) }
        })
    }, list)
    dialog = await reopen()
    await expect(dialog).toContainText('Loading conversations')
    await shot('after-loading-dialog.png')
    await expect(dialog).toContainText('Showing recent conversations only')
    await expect(dialog).toContainText('Linked: Other terminal')
    await shot('after-truncated-linked-dialog.png')
    await page.keyboard.press('Escape')
    await result.app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('agent-conversations-list')
        ipcMain.handle('agent-conversations-list', () => ({ error: { code: 'unknown_session', message: 'The terminal session no longer exists.' } }))
    })
    dialog = await reopen()
    await expect(dialog.getByTestId('conversation-error')).toHaveText('The terminal session no longer exists.')
    await shot('after-error-dialog.png')
    await page.keyboard.press('Escape')
    await result.app.evaluate(({ ipcMain }, snapshot) => {
        ipcMain.removeHandler('agent-conversations-list')
        ipcMain.handle('agent-conversations-list', () => ({ ...snapshot, front: { kind: 'unknown', runningId: null, startedAt: null } }))
    }, list)
    dialog = await reopen()
    await expect(dialog).toContainText('Could not inspect')
    await expect(dialog.getByTestId('conversation-connect')).toBeDisabled()
    await shot('after-foreground-unknown.png')
    expect(result.pageErrors).toEqual([])
})

test('T104 review R7: pasted resume is process-confirmed and enforces file, cwd and unique links', async () => {
    const x = reviewHome()
    const ids = [1, 2, 3].map((i) => `00000000-0000-4000-8000-${String(104700 + i).padStart(12, '0')}`)
    const now = new Date()
    const dir = path.join(x.codex, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    fs.mkdirSync(dir, { recursive: true })
    for (const [i, id] of ids.entries()) fs.writeFileSync(path.join(dir, `rollout-${id}.jsonl`), [
        { type: 'session_meta', payload: { id, cwd: i === 1 ? x.root : x.project, source: 'cli', originator: 'codex-tui', timestamp: now.toISOString() } },
        { type: 'event_msg', payload: { type: 'user_message', message: `Pasted resume ${i}` } }
    ].map((record) => JSON.stringify(record)).join('\n') + '\n')
    const script = path.join(x.root, 'standin.cjs')
    fs.writeFileSync(script, "process.title = 'codex resume ' + process.argv.at(-1); console.log('D104-RESUME-READY'); setInterval(() => {}, 1000); process.stdin.resume();")
    const binDir = path.join(x.root, 'bin'); fs.mkdirSync(binDir)
    const executable = path.join(binDir, 'codex')
    fs.writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 })
    const sessions = ['valid', 'missing', 'mismatch', 'duplicate']
    result = await launchAppWithWorkspaces([{ id: 'paste', name: 'Pasted resume', path: x.project, sessions: sessions.map((id) => ({ id, name: id })) }], { env: x.env })
    const { page } = result
    const saved = (id: string) => JSON.parse(fs.readFileSync(path.join(result!.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'paste').sessions.find((s: any) => s.id === id)
    const attempt = async (id: string, conversation: string) => {
        await waitForBufferText(page, id, 'READY>', 5000)
        await page.evaluate(([id, data]) => window.api.writeTerminal(id, data), [id, `${executable} --model gpt-test resume ${conversation}\r`])
        await waitForBufferText(page, id, 'D104-RESUME-READY', 5000)
    }
    await attempt('valid', ids[0])
    await expect.poll(() => saved('valid'), { timeout: 6000 }).toMatchObject({ cliToolName: 'codex', cliSessionId: ids[0], cliCommand: `${executable} --model gpt-test` })
    await attempt('missing', '00000000-0000-4000-8000-000000999999')
    await attempt('mismatch', ids[1])
    await attempt('duplicate', ids[0])
    // All stand-ins have reached their final argv; no further shell-to-agent transition is pending.
    await page.waitForTimeout(500)
    for (const id of ['missing', 'mismatch', 'duplicate']) expect(saved(id).cliSessionId).toBeUndefined()
})
