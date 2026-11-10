import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T118 — where the phone's «Reading the conversation…» time goes (fb-1110 91e1b27e · 1e556f10). Opt-in
 * (`PHONE_READ_PERF=1`): it measures, it does not guard. `PHONE_READ_TRANSCRIPT=<jsonl>` is a Claude
 * transcript of a real size (an anonymised copy — every word replaced, same shape and bytes); without it
 * the test makes one from repeated turns. `PHONE_READ_LABEL` names the result file
 * (tests/terminal/results/<label>/t118-*.json), so the old and the new code are compared run to run.
 *
 * Each case opens the phone page on the session (CDP 390×844, scale 3) under a phone-like CPU (4× slower)
 * and network (Tailscale over Wi-Fi / LTE), and splits the wait: the conversation request (server + wire),
 * its bytes, and the main-thread time from the response to the turns on screen (JSON + React render).
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const AGENT = 't118-claude'
const CONVERSATION = '00000000-0000-4000-8000-0000000c1180'
const OWNER = 'owner-t118@example.com'
const PORT = 47918
const LABEL = process.env.PHONE_READ_LABEL ?? 'run'
const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

/** CPU slowdown and network of the cases: a mid phone, then on Wi-Fi and on LTE through a Tailscale relay */
const CASES = [
    { name: 'mac-speed', cpu: 1, net: null },
    { name: 'phone-wifi', cpu: 4, net: { latency: 40, down: 2_500_000, up: 1_000_000 } },
    { name: 'phone-lte-relay', cpu: 4, net: { latency: 120, down: 500_000, up: 250_000 } }
] as const

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result).catch(() => result?.app.process().kill('SIGKILL'))
    result = null
})

/** A transcript without a real one: 120 turns of a person, tool calls and markdown answers. */
function syntheticTranscript(file: string, project: string): void {
    let parent: string | null = null
    let counter = 0
    const lines: string[] = []
    const entry = (type: string, message: unknown): void => {
        const uuid = `11800000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
        lines.push(JSON.stringify({ type, message, uuid, parentUuid: parent, timestamp: new Date(Date.UTC(2026, 10, 10, 0, 0, counter)).toISOString(), sessionId: 'seed', cwd: project }))
        parent = uuid
    }
    const usage = { input_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 }
    for (let turn = 0; turn < 120; turn++) {
        entry('user', { role: 'user', content: `질문 ${turn}: 이 부분을 확인해 주세요. `.repeat(4) })
        for (let tool = 0; tool < 4; tool++) {
            const id = `toolu_${turn}_${tool}`
            entry('assistant', { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `grep -rn "pattern${tool}" src | head -50`, description: `Search ${tool}` } }], stop_reason: 'tool_use', usage })
            entry('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: Array.from({ length: 40 }, (_, row) => `src/file${row}.ts:${row}: const value${row} = compute(${row})`).join('\n') }] })
        }
        const answer = [`## 결과 ${turn}`, '', '| 항목 | 상태 | 비고 |', '|---|---|---|', ...Array.from({ length: 8 }, (_, row) => `| item ${row} | 완료 | \`src/file${row}.ts:${row}\` |`), '', '```ts', ...Array.from({ length: 12 }, (_, row) => `const x${row} = await load(${row})`), '```', '', '정리하면 위와 같습니다. '.repeat(10)].join('\n')
        entry('assistant', { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage })
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

async function launch(): Promise<{ app: ElectronApplication; base: string; bytes: number }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t118-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const claudeDir = path.join(home, 'claude')
    const folder = path.join(claudeDir, 'projects', slug(project))
    fs.mkdirSync(folder, { recursive: true })
    const transcript = path.join(folder, `${CONVERSATION}.jsonl`)
    if (process.env.PHONE_READ_TRANSCRIPT) fs.copyFileSync(process.env.PHONE_READ_TRANSCRIPT, transcript)
    else syntheticTranscript(transcript, project)
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t118', name: 'T118 project', path: project, sessions: [{ id: AGENT, name: 'T118 Claude', cliSessionId: CONVERSATION, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --continue` }] }],
        { settings: { phone: { enabled: true, port: PORT } }, env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, AGENT, 'Claude Code (mock)', 30_000)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    return { app, base: `http://127.0.0.1:${state.port}`, bytes: fs.statSync(transcript).size }
}

async function openPhone(app: ElectronApplication, base: string): Promise<Page> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition(o.partition)
        jar.webRequest.onBeforeSendHeaders((details, callback) => {
            callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.login, 'X-Forwarded-For': '100.101.102.103' } })
        })
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url: `${base}/`, partition: 't118', login: OWNER })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    return phone
}

interface Measure {
    case: string
    /** from asking for the session's chat to its turns on screen */
    totalMs: number
    /** the conversation request: request start → last byte (server read + wire) */
    requestMs: number
    /** waiting on the first byte (server read + one round trip) */
    firstByteMs: number
    bodyKB: number
    /** what crossed the wire (compressed when the server compresses) */
    wireKB: number
    /** from the last byte to the turns on screen: JSON, React, layout */
    renderMs: number
    /** how many conversation requests the opening made */
    requests: number
    turnsShown: number
}

test('T118 phone «Reading the conversation…» — request, bytes and render, per network', async () => {
    test.skip(process.env.PHONE_READ_PERF !== '1', 'opt-in measurement: PHONE_READ_PERF=1')
    test.setTimeout(600_000)
    const { app, base, bytes } = await launch()
    const phone = await openPhone(app, base)
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
    await cdp.send('Network.enable')
    const results: Measure[] = []
    for (const one of CASES) {
        for (let run = 0; run < 3; run++) {
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
            await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
            await phone.goto(`${base}/`)
            await phone.waitForLoadState('networkidle')
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: one.cpu })
            if (one.net) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: one.net.latency, downloadThroughput: one.net.down, uploadThroughput: one.net.up })
            let requests = 0
            const counter = (request: { url: () => string }): void => {
                if (/\/conversation(\?|$)/.test(request.url())) requests++
            }
            phone.on('request', counter)
            const started = Date.now()
            // the same way a person opens it: the session's chat in the page, «Reading…» until the turns come
            await phone.evaluate((id) => {
                performance.clearResourceTimings()
                const probe = window as unknown as { __t118: { asked: number; shown: number | null } }
                probe.__t118 = { asked: performance.now(), shown: null }
                // the first frame with a turn on screen, timed in the page (Playwright's polling is coarser)
                const look = (): void => {
                    if (document.querySelector('[data-testid="chat-answer"]')) probe.__t118.shown = performance.now()
                    else requestAnimationFrame(look)
                }
                requestAnimationFrame(look)
                history.pushState(null, '', `/?session=${id}&view=chat`)
                window.dispatchEvent(new PopStateEvent('popstate'))
            }, AGENT)
            await expect(phone.getByTestId('chat-answer').first()).toBeVisible({ timeout: 120_000 })
            await phone.waitForTimeout(4000)
            phone.off('request', counter)
            const timing = await phone.evaluate(() => {
                const entry = performance.getEntriesByType('resource').find((item) => /\/conversation(\?|$)/.test(item.name)) as PerformanceResourceTiming | undefined
                const probe = (window as unknown as { __t118: { asked: number; shown: number | null } }).__t118
                return entry ? { start: entry.startTime, responseStart: entry.responseStart, end: entry.responseEnd, body: entry.decodedBodySize, wire: entry.encodedBodySize, asked: probe.asked, shown: probe.shown } : null
            })
            expect(timing, 'the conversation request was made').not.toBeNull()
            expect(timing!.shown, 'the turns were seen on screen').not.toBeNull()
            void started
            results.push({
                case: one.name,
                totalMs: Math.round(timing!.shown! - timing!.asked),
                requestMs: Math.round(timing!.end - timing!.start),
                firstByteMs: Math.round(timing!.responseStart - timing!.start),
                bodyKB: Math.round(timing!.body / 1024),
                wireKB: Math.round(timing!.wire / 1024),
                renderMs: Math.round(timing!.shown! - timing!.end),
                requests,
                turnsShown: await phone.getByTestId('chat-answer').count()
            })
        }
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const dir = path.join(REPO_ROOT, 'tests/terminal/results', LABEL)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 't118-phone-read.json'), JSON.stringify({ transcriptMB: +(bytes / 1048576).toFixed(1), results }, null, 2))
    console.log(JSON.stringify({ transcriptMB: +(bytes / 1048576).toFixed(1), results }))
})
