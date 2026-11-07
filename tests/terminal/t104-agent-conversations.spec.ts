import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
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

function reviewRollout(x: ReturnType<typeof reviewHome>, id: string, cwd = x.project): void {
    const at = new Date()
    const dir = path.join(x.codex, 'sessions', String(at.getFullYear()), String(at.getMonth() + 1).padStart(2, '0'), String(at.getDate()).padStart(2, '0'))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `rollout-${id}.jsonl`), [
        { type: 'session_meta', payload: { id, timestamp: at.toISOString(), cwd, source: 'vscode', originator: 'codex-tui' } },
        { type: 'event_msg', payload: { type: 'user_message', message: `Review2 ${id}` } }
    ].map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function reviewAgent(x: ReturnType<typeof reviewHome>, name = 'codex'): string {
    const dir = path.join(x.root, 'agents'); fs.mkdirSync(dir, { recursive: true })
    const bin = path.join(dir, name)
    execFileSync('/usr/bin/cc', ['-O0', path.join(__dirname, 'fixtures/agent-process.c'), '-o', bin])
    return bin
}

test('T104 fix3: Connect never submits a prepared command or executes unobserved shell text', async () => {
    const x = reviewHome()
    const native = reviewAgent(x)
    fs.appendFileSync(path.join(x.env.HOME, '.zshrc'), 'HISTSIZE=100\n')
    const names = ['paste-newline', 'paste-two', 'hist-verify', 'widget', 'menu-select', 'cmdand', 'custom-ps2']
    const ids = names.map((_, i) => `00000000-0000-4000-8000-${String(106000 + i).padStart(12, '0')}`)
    ids.forEach((id) => reviewRollout(x, id))
    result = await launchAppWithWorkspaces([{ id: 'draft-only', name: 'Prepared only', path: x.project, sessions: names.map((id) => ({ id, name: id, cliToolName: 'codex', cliCommand: native })) }], { env: x.env })
    const { page } = result
    const write = (id: string, data: string) => page.evaluate(([id, data]) => window.api.writeTerminal(id, data), [id, data])
    const type = async (id: string, data: string) => { for (const character of data) await write(id, character) }
    for (const [i, name] of names.entries()) {
        await waitForBufferText(page, name, 'READY>', 5000)
        const marker = 'M_' + name
        if (name.startsWith('paste')) {
            await page.getByText(name, { exact: true }).first().click()
            await page.locator(`[data-session-id="${name}"] .xterm-helper-textarea`).evaluate((element, text) => {
                const data = new DataTransfer(); data.setData('text/plain', text)
                element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
            }, name === 'paste-newline' ? `touch ${marker}\n` : `touch ${marker}\ntouch ${marker}.2\n`)
        } else if (name === 'hist-verify') {
            await write(name, 'setopt hist_verify\r')
            await write(name, `touch ${marker}; true\r`)
            await expect.poll(() => fs.existsSync(path.join(x.project, marker))).toBe(true)
            fs.unlinkSync(path.join(x.project, marker))
            await type(name, '!!\r')
        } else if (name === 'menu-select') {
            fs.writeFileSync(path.join(x.project, marker + '-a'), 'a'); fs.writeFileSync(path.join(x.project, marker + '-b'), 'b')
            await write(name, "zmodload zsh/complist; autoload -U compinit; compinit -u -D; zstyle ':completion:*' menu select; zstyle ':completion:*' list-prompt ''\r")
            await page.waitForTimeout(800)
            await type(name, `rm ${marker}-`)
            for (let n = 0; n < 3; n++) { await write(name, '\t'); await page.waitForTimeout(200) }
            await write(name, '\r')
            expect(fs.existsSync(path.join(x.project, marker + '-a'))).toBe(true)
            expect(fs.existsSync(path.join(x.project, marker + '-b'))).toBe(true)
        } else if (name === 'widget') {
            await write(name, `fake-pick() { local k; read -k1 k </dev/tty; BUFFER='touch ${marker}; true'; CURSOR=$#BUFFER; zle reset-prompt }; zle -N fake-pick; bindkey '^R' fake-pick\r`)
            await page.waitForTimeout(200)
            await write(name, '\x12'); await page.waitForTimeout(100); await write(name, '\r')
        } else {
            if (name === 'custom-ps2') await write(name, "PROMPT2='∙ '\r")
            await write(name, `touch ${marker} &&\r`)
        }
        await page.waitForTimeout(200)
        expect(fs.existsSync(path.join(x.project, marker))).toBe(false)
        const response = await page.evaluate(([id, conversation]) => window.api.connectAgentConversation(id, { agent: 'codex', id: conversation, resume: true }), [name, ids[i]])
        if (!('error' in response)) expect(response).toMatchObject({ typed: true, resumed: false })
        await page.waitForTimeout(200)
        expect(fs.existsSync(path.join(x.project, marker)), name).toBe(false)
        expect(fs.existsSync(path.join(x.project, marker + '.2')), name).toBe(false)
        if (name === 'menu-select') {
            expect(fs.existsSync(path.join(x.project, marker + '-a'))).toBe(true)
            expect(fs.existsSync(path.join(x.project, marker + '-b'))).toBe(true)
        }
    }
})

test('T104 fix3 N13 N14: pending restore blocks Connect and leaves early user text unsubmitted', async () => {
    const x = reviewHome()
    const native = reviewAgent(x)
    fs.appendFileSync(path.join(x.env.HOME, '.zshrc'), 'zmodload zsh/zselect\nzselect -t 500\n')
    const ids = [0, 1, 2].map((i) => `00000000-0000-4000-8000-${String(106100 + i).padStart(12, '0')}`)
    ids.forEach((id) => reviewRollout(x, id))
    const log = path.join(x.root, 'args.jsonl')
    result = await launchAppWithWorkspaces([{ id: 'restoring', name: 'Restore race', path: x.project, sessions: ['draft', 'pending'].map((id, i) => ({ id, name: id, cliToolName: 'codex', cliSessionId: ids[i], cliCommand: native })) }], { env: { ...x.env, D4_AGENT_ARGS_LOG: log, D4_AGENT_LIFETIME_SECONDS: '30' } })
    for (const character of 'touch DRAFT') await result.page.evaluate((data) => window.api.writeTerminal('draft', data), character)
    const blocked = await result.page.evaluate((id) => window.api.connectAgentConversation('pending', { agent: 'codex', id, resume: true }), ids[2])
    expect(blocked).toMatchObject({ error: { code: 'input_busy' } })
    await expect(result.page.getByText('Your text is still on the line — resume was not typed', { exact: true })).toBeVisible({ timeout: 10000 })
    await expect.poll(() => fs.existsSync(log)).toBe(true)
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((row) => JSON.parse(row).argv.slice(1))
    expect(calls).toEqual([['resume', ids[1]]])
    expect(fs.readdirSync(x.project)).toEqual([])
    expect(await termText(result.page, 'draft')).toContain('touch DRAFT')
})

test('T104 fix3 N15: Diff text enters the same input tracker', async () => {
    const x = reviewHome()
    reviewRollout(x, ID)
    result = await launchAppWithWorkspaces([{ id: 'diff-input', name: 'Diff input', path: x.project, sessions: [{ id: 'diff-input', name: 'Diff', cliToolName: 'codex', cliCommand: '/missing/codex' }] }], { env: x.env })
    await waitForBufferText(result.page, 'diff-input', 'READY>', 5000)
    expect(await result.page.evaluate(() => window.api.sendTextToTerminal('diff-input', 'touch M_diff; true '))).toMatchObject({ success: true })
    const response = await result.page.evaluate((id) => window.api.connectAgentConversation('diff-input', { agent: 'codex', id, resume: true }), ID)
    expect(response).toMatchObject({ error: { code: 'input_busy' } })
    expect(fs.existsSync(path.join(x.project, 'M_diff'))).toBe(false)
})

test('T104 fix2 N3: empty input accepts prompt themes and OSC precmd; uncertain edits explain recovery', async () => {
    const x = reviewHome()
    const bin = path.join(x.root, 'bin'); fs.mkdirSync(bin)
    const executable = path.join(bin, 'codex')
    fs.writeFileSync(executable, `#!${process.execPath}\nconsole.log('PROMPT-RESUME-READY');setTimeout(()=>{},30000)\n`, { mode: 0o755 })
    const themes = ["PROMPT='➜  project git:(main) '", "PROMPT='λ '", "PROMPT='~/p on main [\\$!] ❯ '", "PROMPT='~/a#b %# '", "PROMPT='READY> '; precmd() { printf '\\e]11;?\\a' }"]
    const names = themes.map((_, i) => `theme${i}`).concat('recover')
    const ids = names.map((_, i) => `00000000-0000-4000-8000-${String(105000 + i).padStart(12, '0')}`)
    ids.forEach((id) => reviewRollout(x, id))
    result = await launchAppWithWorkspaces([{ id: 'themes', name: 'Prompt themes', path: x.project, sessions: names.map((id) => ({ id, name: id, cliToolName: 'codex', cliCommand: executable })) }], { env: x.env })
    const { page } = result
    for (const name of names) await waitForBufferText(page, name, 'READY>', 5000)
    for (let i = 0; i < themes.length; i++) {
        await page.evaluate(([id, data]) => window.api.writeTerminal(id, data), [names[i], themes[i] + '\r'])
        const response = await page.evaluate(([id, conversation]) => window.api.connectAgentConversation(id, { agent: 'codex', id: conversation, resume: true }), [names[i], ids[i]])
        expect(response, themes[i]).toMatchObject({ status: 'connected', typed: true })
    }
    await page.evaluate(() => window.api.writeTerminal('recover', '\x15'))
    const blocked = await page.evaluate((id) => window.api.connectAgentConversation('recover', { agent: 'codex', id, resume: true }), ids.at(-1)!)
    expect(blocked).toMatchObject({ error: { code: 'input_busy' } })
    if ('error' in blocked) expect(blocked.error.message).toContain('Enter or Ctrl+C')
    await page.evaluate(() => window.api.writeTerminal('recover', '\x03'))
    expect(await page.evaluate((id) => window.api.connectAgentConversation('recover', { agent: 'codex', id, resume: true }), ids.at(-1)!)).toMatchObject({ status: 'connected' })
})

test('T104 fix2 N5: stray files do not disable stale Claude id validation', async () => {
    const x = reviewHome()
    fs.mkdirSync(path.join(x.claude, 'projects', 'p'), { recursive: true })
    fs.writeFileSync(path.join(x.claude, 'projects', '.DS_Store'), 'fixture')
    result = await launchAppWithWorkspaces([{ id: 'stray', name: 'Stray file', path: x.project, sessions: [{ id: 'stale', name: 'Stale', cliSessionId: ID, cliToolName: 'claude', cliCommand: '/usr/bin/true' }] }], { env: x.env })
    const saved = JSON.parse(fs.readFileSync(path.join(result.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'stray').sessions[0]
    expect(saved.cliSessionId).toBeUndefined()
})

test('T104 fix2 N2: restart preserves stored option values and applies read-only input decisions', async () => {
    const x = reviewHome()
    const native = reviewAgent(x, 'claude')
    const log = path.join(x.root, 'args.jsonl')
    const projects = path.join(x.claude, 'projects', 'p'); fs.mkdirSync(projects, { recursive: true })
    fs.writeFileSync(path.join(projects, `${ID}.jsonl`), '{}\n')
    const command = `${native} --fallback-model sonnet --dangerously-skip-permissions`
    result = await launchAppWithWorkspaces([{ id: 'options', name: 'Saved options', path: x.project, sessions: [{ id: 'options', name: 'Options', cliSessionId: ID, cliToolName: 'claude', cliCommand: command }] }], { env: { ...x.env, D4_AGENT_ARGS_LOG: log, D4_AGENT_LIFETIME_SECONDS: '30' } })
    await expect.poll(() => fs.existsSync(log), { timeout: 10000 }).toBe(true)
    const argv = JSON.parse(fs.readFileSync(log, 'utf8').trim()).argv
    expect(argv.slice(1)).toEqual(['--fallback-model', 'sonnet', '--dangerously-skip-permissions', '--resume', ID])
    const saved = JSON.parse(fs.readFileSync(path.join(result.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'options').sessions[0]
    expect(saved.cliCommand).toBe(command)
    for (const [raw, input] of [
        [`${native} --future-option human-value`, `claude --resume ${ID}`],
        [`${native} "do not resend this prompt"`, `${native} --resume ${ID}`]
    ]) {
        await result.page.evaluate(([id, value]) => window.api.updateSessionCliInfo('options', 'options', id, 'claude', value), [ID, raw])
        expect(await result.page.evaluate(() => window.api.getSessionResumeCommand('options'))).toBe(input)
        const retained = JSON.parse(fs.readFileSync(path.join(result.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'options').sessions[0]
        expect(retained.cliCommand).toBe(raw)
    }
})

test('T104 fix2 N4: a slow alias profile does not delay the first window', async () => {
    const x = reviewHome()
    fs.appendFileSync(path.join(x.env.HOME, '.zshrc'), 'sleep 6\n')
    const userDataDir = path.join(x.root, 'user-data'); fs.mkdirSync(userDataDir)
    const started = Date.now()
    const app = await electron.launch({ args: [path.join(REPO_ROOT, 'out/main/index.js')], env: { ...process.env, ...x.env, CLIMANGER_TEST_USERDATA: userDataDir, CLIMANGER_TEST_HEADLESS: '1' } as Record<string, string> })
    const page = await app.firstWindow()
    result = { app, page, userDataDir, pageErrors: [], consoleErrors: [] }
    expect(Date.now() - started).toBeLessThan(5000)
    // Let the owned profile process finish before closing the test app.
    await page.waitForTimeout(6500)
})

test('T104 fix2 N1: Codex behind a thirteen-second setup is eventually linked', async () => {
    const x = reviewHome()
    const bin = path.join(x.root, 'bin'); fs.mkdirSync(bin)
    const executable = path.join(bin, 'codex')
    const log = path.join(x.root, 'started.txt')
    fs.writeFileSync(executable, `#!${process.execPath}\nconst fs=require('fs'),path=require('path'),at=new Date(),id='${ID}',p=n=>String(n).padStart(2,'0'),dir=path.join(process.env.CODEX_HOME,'sessions',String(at.getFullYear()),p(at.getMonth()+1),p(at.getDate()));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'rollout-'+id+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id,timestamp:at.toISOString(),cwd:process.cwd(),source:'vscode',originator:'codex-tui'}})+'\\n');fs.writeFileSync(${JSON.stringify(log)},id);setTimeout(()=>{},60000)\n`, { mode: 0o755 })
    result = await launchAppWithWorkspaces([{ id: 'slow', name: 'Slow Codex', path: x.project, sessions: [{ id: 'slow', name: 'Slow', initialCommand: `sleep 13; ${executable}` }] }], { env: x.env })
    await expect.poll(() => fs.existsSync(log), { timeout: 20000 }).toBe(true)
    const saved = () => JSON.parse(fs.readFileSync(path.join(result!.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'slow').sessions[0]
    await expect.poll(saved, { timeout: 25000 }).toMatchObject({ cliToolName: 'codex', cliSessionId: ID })
})

test('T104 fix2 N6: typed, pasted and chunked npm launchers and native names link after process confirmation', async () => {
    const x = reviewHome()
    const bin = path.join(x.root, 'bin'); fs.mkdirSync(bin)
    const launcher = path.join(bin, 'codex')
    fs.writeFileSync(launcher, `#!${process.execPath}\nconsole.log('D4_NODE_READY');setTimeout(()=>{},60000)\n`, { mode: 0o755 })
    const native = reviewAgent(x, 'codex-aarch64-apple-darwin')
    const names = ['node-typed', 'node-pasted', 'node-chunk', 'native']
    const ids = names.map((_, i) => `00000000-0000-4000-8000-${String(105100 + i).padStart(12, '0')}`)
    ids.forEach((id) => reviewRollout(x, id))
    result = await launchAppWithWorkspaces([{ id: 'npm', name: 'Launcher shapes', path: x.project, sessions: names.map((id) => ({ id, name: id })) }], { env: { ...x.env, D4_AGENT_LIFETIME_SECONDS: '60' } })
    const { page } = result
    const write = (id: string, data: string) => page.evaluate(([id, data]) => window.api.writeTerminal(id, data), [id, data])
    const type = async (id: string, data: string) => { for (const character of data) await write(id, character) }
    for (const name of names) await waitForBufferText(page, name, 'READY>', 5000)
    const node = `${process.execPath} ${launcher}`
    await type(names[0], `${node} resume ${ids[0]}\r`)
    await type(names[1], `${node} resume `); await write(names[1], ids[1]); await write(names[1], '\r')
    await write(names[2], `${node} resume ${ids[2]}\r`)
    await write(names[3], `${native} resume ${ids[3]}\r`)
    const saved = (id: string) => JSON.parse(fs.readFileSync(path.join(result!.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'npm').sessions.find((s: any) => s.id === id)
    for (const [i, name] of names.entries()) await expect.poll(() => saved(name), { timeout: 6500 }).toMatchObject({ cliToolName: 'codex', cliSessionId: ids[i] })
})

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
    expect(connected).toMatchObject({ status: 'connected', typed: true, resumed: false })
    expect(await termText(result.page, 'right')).not.toContain('RIGHT-PROMPT-RESUME')
    await result.page.evaluate(() => window.api.writeTerminal('right', '\r'))
    await waitForBufferText(result.page, 'right', 'RIGHT-PROMPT-RESUME', 5000)
})

test('T104 review A1: missing Claude storage is unknown while stale Codex ids are checked', async () => {
    const x = reviewHome()
    const standin = reviewAgent(x, 'claude')
    result = await launchAppWithWorkspaces([{ id: 'review', name: 'Review project', path: x.project, sessions: [
        { id: 'claude-missing', name: 'Claude missing', cliSessionId: ID, cliToolName: 'claude', cliCommand: standin },
        { id: 'codex-stale', name: 'Codex stale', cliSessionId: ID, cliToolName: 'codex', cliCommand: '/usr/bin/true' }
    ] }], { env: x.env })
    const sessions = JSON.parse(fs.readFileSync(path.join(result.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'review').sessions
    expect(sessions.find((s: any) => s.id === 'claude-missing')).toMatchObject({ cliSessionId: ID, cliToolName: 'claude', cliCommand: standin })
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
    expect(await connect('plain')).toMatchObject({ status: 200, body: { status: 'connected', typed: true, resumed: false } })
    expect(fs.existsSync(starts)).toBe(false)
    await api('/v1/sessions/plain/input', { keys: ['enter'] })
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
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('draft-handoff-notice')).toContainText('Press Enter in the terminal to resume.')
    await expect(page.locator('[data-session-id=plain] .xterm-helper-textarea')).toBeFocused()
    await shot('after-unconfirmed-resume.png')
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
    expect(rpc.body.result.tools.find((tool: any) => tool.name === 'connect_agent_conversation').description).toContain('without Enter')
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
    await expect(page.getByTestId('draft-handoff-notice')).toContainText('Press Enter in the terminal to resume.')
    await expect(page.locator(`[data-session-id="${SESSION}"] .xterm-helper-textarea`)).toBeFocused()
    expect(fs.existsSync(starts)).toBe(false)
    await page.keyboard.press('Enter')
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
test('T104 fix2 N7: initial preparation survives agent registry synchronization', async () => {
    const x = reviewHome()
    const bin = path.join(x.root, 'bin'); fs.mkdirSync(bin)
    const executable = path.join(bin, 'claude')
    fs.writeFileSync(executable, `#!${process.execPath}\nconst fs=require('fs'),path=require('path'),dir=path.join(process.env.CLAUDE_CONFIG_DIR,'sessions');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,process.pid+'.json'),JSON.stringify({pid:process.pid,sessionId:'${ID}',startedAt:Date.now()}));console.log('N7_REGISTRY_READY');setTimeout(()=>{},30000)\n`, { mode: 0o755 })
    const command = `FOO=$(printf warm) ${executable} --model opus`
    result = await launchAppWithWorkspaces([{ id: 'n7', name: 'N7 preparation', path: x.project, sessions: [{ id: 'n7', name: 'N7', initialCommand: command }] }], { env: { ...x.env, CLIMANAGER_CLAUDE_SYNC_MS: '100' } })
    await waitForBufferText(result.page, 'n7', 'N7_REGISTRY_READY', 5000)
    const saved = () => JSON.parse(fs.readFileSync(path.join(result!.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'n7').sessions[0]
    await expect.poll(saved, { timeout: 5000 }).toMatchObject({ cliToolName: 'claude', cliSessionId: ID, cliCommand: command })
})

test('T104 fix2 N9: Enter recovers after cat Ctrl+D and less q without erasing input', async () => {
    const x = reviewHome()
    const native = reviewAgent(x)
    const names = ['cat-exit', 'less-exit']
    const ids = names.map((_, i) => `00000000-0000-4000-8000-${String(105200 + i).padStart(12, '0')}`)
    ids.forEach((id) => reviewRollout(x, id))
    const note = path.join(x.root, 'page.txt'); fs.writeFileSync(note, Array.from({ length: 200 }, (_, i) => 'line ' + i).join('\n'))
    result = await launchAppWithWorkspaces([{ id: 'recovery', name: 'Input recovery', path: x.project, sessions: names.map((id) => ({ id, name: id, cliToolName: 'codex', cliCommand: native })) }], { env: { ...x.env, D4_AGENT_LIFETIME_SECONDS: '30' } })
    const { page } = result
    const write = (id: string, data: string) => page.evaluate(([id, data]) => window.api.writeTerminal(id, data), [id, data])
    const front = async (id: string) => { const value = await page.evaluate((id) => window.api.listAgentConversations(id), id); return 'error' in value ? 'unknown' : value.front.kind }
    for (const [i, name] of names.entries()) {
        await waitForBufferText(page, name, 'READY>', 5000)
        await write(name, i ? `less ${note}\r` : 'cat\r')
        await expect.poll(() => front(name)).toBe('other')
        await write(name, i ? 'q' : '\x04')
        await expect.poll(() => front(name)).toBe('shell')
        const blocked = await page.evaluate(([id, conversation]) => window.api.connectAgentConversation(id, { agent: 'codex', id: conversation, resume: true }), [name, ids[i]])
        expect(blocked).toMatchObject({ error: { code: 'input_busy' } })
        if ('error' in blocked) expect(blocked.error.message).toContain('Enter or Ctrl+C')
        await write(name, '\r')
        expect(await page.evaluate(([id, conversation]) => window.api.connectAgentConversation(id, { agent: 'codex', id: conversation, resume: true }), [name, ids[i]])).toMatchObject({ status: 'connected', typed: true })
    }
})

test('T104 fix2 N2: restored input never rewrites remembered options through manual observation', async () => {
    const x = reviewHome()
    const native = path.join(x.root, 'codex-bin')
    fs.mkdirSync(native)
    const executable = path.join(native, 'codex')
    execFileSync('/usr/bin/cc', ['-O0', path.join(__dirname, 'fixtures/agent-process.c'), '-o', executable])
    fs.appendFileSync(path.join(x.env.HOME, '.zshrc'), `export PATH='${native}':$PATH\n`)
    const ids = ['00000000-0000-4000-8000-000000105301', '00000000-0000-4000-8000-000000105302']
    ids.forEach((id) => reviewRollout(x, id))
    const commands = [`${executable} --future-option human-value`, `${executable} "DO_NOT_REPLAY"`]
    const log = path.join(x.root, 'args.jsonl')
    result = await launchAppWithWorkspaces([{ id: 'readonly', name: 'Read-only restart', path: x.project, sessions: commands.map((command, i) => ({ id: 'restore'+i, name: 'Restore'+i, cliToolName: 'codex', cliSessionId: ids[i], cliCommand: command })) }], { env: { ...x.env, D4_AGENT_ARGS_LOG: log, D4_AGENT_LIFETIME_SECONDS: '30' } })
    await expect.poll(() => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0, { timeout: 8000 }).toBe(2)
    await result.page.waitForTimeout(4500)
    const saved = JSON.parse(fs.readFileSync(path.join(result.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'readonly').sessions
    for (const [i, session] of saved.entries()) expect(session.cliCommand).toBe(commands[i])
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((row) => JSON.parse(row).argv.slice(1))
    expect(calls).toEqual(expect.arrayContaining(ids.map((id) => ['resume', id])))
})
