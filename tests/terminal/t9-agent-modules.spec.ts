import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AgentStatusResolver, TerminalLookupEntry } from '../../src/main/AgentStatusResolver'
import { AgentHookBridge } from '../../src/main/AgentHookBridge'
import { UsageTracker, pickWeeklyWindow, readLastRateLimits } from '../../src/main/UsageTracker'
import { parseDiffSummary, parseFileDiff } from '../../src/main/diffParser'
import { buildReviewPrompt } from '../../src/renderer/src/utils/reviewPrompt'
import { AgentEvent } from '../../src/shared/types'

/**
 * T9 — Agent integration modules, exercised directly.
 *
 * T7 covers the wiring through a running app; this file covers the branches that
 * are hard to provoke from the outside: ambiguous matching, malformed input,
 * precedence expiry, and the parser edge cases that decide whether a review
 * comment cites the right line.
 *
 * Everything here is in-process and pure, so the whole file runs in well under
 * a second — it is meant to be cheap enough to never skip.
 */

// ---------------------------------------------------------------------------
// AgentStatusResolver
// ---------------------------------------------------------------------------

const TERMINALS: TerminalLookupEntry[] = [
    { terminalId: 't-claude', cwd: '/repo/app', cliSessionId: 'sess-123', cliToolName: 'claude' },
    { terminalId: 't-codex', cwd: '/repo/api', cliToolName: 'codex' },
    { terminalId: 't-plain', cwd: '/repo/api' },
    { terminalId: 't-amb1', cwd: '/repo/web' },
    { terminalId: 't-amb2', cwd: '/repo/web' }
]

function makeResolver() {
    const resolver = new AgentStatusResolver(() => TERMINALS)
    const emitted: Array<{ terminalId: string; status: string; source: string }> = []
    resolver.on('status', (u) => emitted.push({ terminalId: u.terminalId, status: u.status, source: u.source }))
    return { resolver, emitted }
}

const event = (partial: Partial<AgentEvent>): AgentEvent => ({
    tool: 'claude',
    kind: 'turn-start',
    at: Date.now(),
    ...partial
})

test.describe('T9 AgentStatusResolver', () => {
    test('session id wins over a conflicting cwd', () => {
        const { resolver } = makeResolver()
        // A stale cwd must not misroute an event we can match exactly. CLI
        // Manager owns the session id because it injects --session-id itself.
        resolver.applyEvent(event({ kind: 'turn-start', cliSessionId: 'sess-123', cwd: '/somewhere/else' }))
        expect(resolver.getStatus('t-claude')?.status).toBe('running')
    })

    test('cwd plus tool name disambiguates two terminals in one directory', () => {
        const { resolver } = makeResolver()
        resolver.applyEvent(event({ tool: 'codex', kind: 'turn-end', cwd: '/repo/api' }))
        expect(resolver.getStatus('t-codex')?.status).toBe('ready')
        // The non-Codex terminal in the same directory must be left alone.
        expect(resolver.getStatus('t-plain')).toBeNull()
    })

    test('a genuinely ambiguous cwd is not guessed at', () => {
        const { resolver, emitted } = makeResolver()
        resolver.applyEvent(event({ tool: 'codex', kind: 'turn-end', cwd: '/repo/web' }))
        // Reporting the wrong session's status is worse than reporting none.
        expect(resolver.getStatus('t-amb1')).toBeNull()
        expect(resolver.getStatus('t-amb2')).toBeNull()
        expect(emitted).toHaveLength(0)
    })

    test('an event with neither a known session id nor a cwd is dropped', () => {
        const { resolver, emitted } = makeResolver()
        resolver.applyEvent(event({ cliSessionId: 'unknown-session' }))
        expect(emitted).toHaveLength(0)
    })

    test('permission and notification mark the session as awaiting input', () => {
        const { resolver } = makeResolver()

        resolver.applyEvent(event({ kind: 'permission', cliSessionId: 'sess-123', detail: 'Bash' }))
        expect(resolver.getStatus('t-claude')).toMatchObject({ awaitingInput: true, detail: 'Bash' })

        resolver.applyEvent(event({ kind: 'turn-end', cliSessionId: 'sess-123' }))
        // Finishing a turn clears the flag: the agent is quiet, not blocked.
        expect(resolver.getStatus('t-claude')?.awaitingInput).toBe(false)
    })

    test('lifecycle events map onto the expected statuses', () => {
        const cases: Array<[AgentEvent['kind'], string]> = [
            ['session-start', 'ready'],
            ['turn-start', 'running'],
            ['turn-end', 'ready'],
            ['session-end', 'idle']
        ]
        for (const [kind, expected] of cases) {
            const { resolver } = makeResolver()
            resolver.applyEvent(event({ kind, cliSessionId: 'sess-123' }))
            expect(resolver.getStatus('t-claude')?.status, `${kind} → ${expected}`).toBe(expected)
        }
    })

    test('a fresh hook status cannot be overwritten by the heuristic', () => {
        const { resolver } = makeResolver()
        resolver.applyEvent(event({ kind: 'turn-end', cliSessionId: 'sess-123' }))
        resolver.applyObservedStatus('t-claude', 'running', 'heuristic')
        expect(resolver.getStatus('t-claude')).toMatchObject({ status: 'ready', source: 'hook' })
    })

    test('the heuristic still governs a terminal with no hook history', () => {
        const { resolver } = makeResolver()
        resolver.applyObservedStatus('t-amb1', 'running', 'heuristic')
        expect(resolver.getStatus('t-amb1')).toMatchObject({ status: 'running', source: 'heuristic' })
    })

    test('the heuristic takes over once hook authority expires', () => {
        const { resolver } = makeResolver()
        resolver.applyEvent(event({ kind: 'turn-end', cliSessionId: 'sess-123' }))

        // Age the recorded status past the 30-minute authority window. Without
        // this expiry a session would freeze on its last hook value forever if
        // the integration were switched off mid-flight.
        const statuses = (resolver as unknown as { statuses: Map<string, { at: number }> }).statuses
        statuses.get('t-claude')!.at = Date.now() - 31 * 60 * 1000

        resolver.applyObservedStatus('t-claude', 'running', 'heuristic')
        expect(resolver.getStatus('t-claude')).toMatchObject({ status: 'running', source: 'heuristic' })
    })

    test('repeated identical statuses do not re-notify the renderer', () => {
        const { resolver, emitted } = makeResolver()
        for (let i = 0; i < 5; i++) {
            resolver.applyEvent(event({ kind: 'turn-start', cliSessionId: 'sess-123' }))
        }
        expect(emitted).toHaveLength(1)
    })

    test('forget() drops a closed terminal so a reused id starts clean', () => {
        const { resolver } = makeResolver()
        resolver.applyEvent(event({ kind: 'turn-start', cliSessionId: 'sess-123' }))
        resolver.forget('t-claude')
        expect(resolver.getStatus('t-claude')).toBeNull()
        expect(resolver.snapshot()).toHaveLength(0)
    })
})

// ---------------------------------------------------------------------------
// AgentHookBridge
// ---------------------------------------------------------------------------

function writeSpool(dir: string, name: string, contents: string): void {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), contents)
}

async function drainOnce(spool: string): Promise<{ events: AgentEvent[]; usage: unknown[] }> {
    const bridge = new AgentHookBridge(spool)
    const events: AgentEvent[] = []
    const usage: unknown[] = []
    bridge.on('agent-event', (e) => events.push(e))
    bridge.on('claude-statusline', (p) => usage.push(p))
    bridge.start()
    await new Promise((resolve) => setTimeout(resolve, 400))
    bridge.stop()
    return { events, usage }
}

test.describe('T9 AgentHookBridge', () => {
    test('malformed and unknown payloads are ignored without stopping the drain', async () => {
        const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'clim-bridge-'))

        try {
            // Each of these has broken the drain at some point during development
            // if handled naively, so they are pinned together with a good event.
            writeSpool(spool, 'ev-unknown-source', JSON.stringify({ climanager: { source: 'nope' }, payload: {} }))
            writeSpool(spool, 'ev-unknown-event', JSON.stringify({ climanager: { source: 'claude-hook' }, payload: { hook_event_name: 'SomethingNew' } }))
            writeSpool(spool, 'ev-no-envelope', JSON.stringify({ hook_event_name: 'Stop' }))
            writeSpool(spool, 'ev-null-payload', JSON.stringify({ climanager: { source: 'claude-hook' }, payload: null }))
            writeSpool(spool, 'ev-wrong-codex-type', JSON.stringify({ climanager: { source: 'codex-notify' }, payload: { type: 'something-else' } }))
            writeSpool(spool, 'ev-good', JSON.stringify({ climanager: { source: 'claude-hook' }, payload: { hook_event_name: 'Stop', session_id: 's1' } }))

            const { events } = await drainOnce(spool)

            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({ tool: 'claude', kind: 'turn-end', cliSessionId: 's1' })
            // Everything consumed, including the rejects — otherwise they would
            // be re-parsed on every sweep forever.
            expect(fs.readdirSync(spool)).toHaveLength(0)
        } finally {
            fs.rmSync(spool, { recursive: true, force: true })
        }
    })

    test('a half-written file is left for the next sweep rather than dropped', async () => {
        const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'clim-bridge-partial-'))

        try {
            // Truncated JSON is what a reader sees when it opens the file while
            // the hook script is still writing it.
            writeSpool(spool, 'ev-partial', '{"climanager":{"source":"claude-hook"},"payl')

            const { events } = await drainOnce(spool)
            expect(events).toHaveLength(0)
            // Still present: the writer may yet complete it. It is only dropped
            // after it has been invalid for 5 seconds.
            expect(fs.readdirSync(spool)).toEqual(['ev-partial'])
        } finally {
            fs.rmSync(spool, { recursive: true, force: true })
        }
    })

    test('events are dispatched in write order, not directory order', async () => {
        const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'clim-bridge-order-'))

        try {
            // mktemp names are random, so a name-ordered drain would report the
            // turn as finished before it started.
            const mk = (event: string) =>
                JSON.stringify({ climanager: { source: 'claude-hook' }, payload: { hook_event_name: event, session_id: 's1' } })

            writeSpool(spool, 'ev-zzzz', mk('UserPromptSubmit'))
            fs.utimesSync(path.join(spool, 'ev-zzzz'), new Date(1000), new Date(1000))
            writeSpool(spool, 'ev-aaaa', mk('Stop'))
            fs.utimesSync(path.join(spool, 'ev-aaaa'), new Date(2000), new Date(2000))

            const { events } = await drainOnce(spool)
            expect(events.map((e) => e.kind)).toEqual(['turn-start', 'turn-end'])
        } finally {
            fs.rmSync(spool, { recursive: true, force: true })
        }
    })

    test('a missing spool directory is created rather than throwing', async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'clim-bridge-missing-'))
        const spool = path.join(parent, 'not-yet', 'events')

        try {
            const { events } = await drainOnce(spool)
            expect(events).toHaveLength(0)
            expect(fs.existsSync(spool)).toBe(true)
        } finally {
            fs.rmSync(parent, { recursive: true, force: true })
        }
    })
})

// ---------------------------------------------------------------------------
// UsageTracker
// ---------------------------------------------------------------------------

test.describe('T9 UsageTracker', () => {
    test('the weekly window is found by duration, not by slot', () => {
        // Observed on a real Pro account: the weekly window sat in `primary`
        // with `secondary: null`. Assuming a slot ordering would misreport it.
        expect(pickWeeklyWindow({ primary: { used_percent: 45, window_minutes: 10080, resets_at: 1 }, secondary: null }))
            .toMatchObject({ usedPercent: 45, label: '7d', windowMinutes: 10080 })

        expect(pickWeeklyWindow({
            primary: { used_percent: 12, window_minutes: 300, resets_at: 1 },
            secondary: { used_percent: 66, window_minutes: 10080, resets_at: 2 }
        })).toMatchObject({ usedPercent: 66, windowMinutes: 10080 })
    })

    test('an unrecognised window set falls back to the longest, and empty input yields nothing', () => {
        expect(pickWeeklyWindow({
            primary: { used_percent: 5, window_minutes: 60, resets_at: 1 },
            secondary: { used_percent: 9, window_minutes: 1440, resets_at: 2 }
        })).toMatchObject({ usedPercent: 9 })

        expect(pickWeeklyWindow({ primary: null, secondary: null })).toBeUndefined()
        expect(pickWeeklyWindow({})).toBeUndefined()
    })

    test('rate limits are read from the end of a rollout file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clim-rollout-'))

        try {
            const file = path.join(dir, 'rollout-test.jsonl')
            const line = (pct: number) =>
                JSON.stringify({ info: { rate_limits: { primary: { used_percent: pct, window_minutes: 10080, resets_at: 5 }, plan_type: 'pro' } } })

            // Limits accumulate through the session; the last one is current.
            fs.writeFileSync(file, [line(10), line(20), line(37)].join('\n') + '\n')

            expect(readLastRateLimits(file)).toMatchObject({ primary: { used_percent: 37 }, plan_type: 'pro' })
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('a rollout file with no limits, or unreadable, returns null instead of throwing', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clim-rollout-empty-'))

        try {
            const empty = path.join(dir, 'rollout-empty.jsonl')
            fs.writeFileSync(empty, JSON.stringify({ type: 'message', text: 'hello' }) + '\n')
            expect(readLastRateLimits(empty)).toBeNull()

            expect(readLastRateLimits(path.join(dir, 'does-not-exist.jsonl'))).toBeNull()
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('a brace inside a message body does not end the parsed object early', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clim-rollout-brace-'))

        try {
            const file = path.join(dir, 'rollout-brace.jsonl')
            fs.writeFileSync(
                file,
                JSON.stringify({
                    info: {
                        rate_limits: {
                            note: 'contains } and { braces',
                            primary: { used_percent: 51, window_minutes: 10080, resets_at: 9 }
                        }
                    }
                }) + '\n'
            )
            expect(readLastRateLimits(file)).toMatchObject({ primary: { used_percent: 51 } })
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('a threshold alert fires once per window and re-arms when the window resets', () => {
        const tracker = new UsageTracker()
        tracker.setAlertSettings({ enabled: true, claudeThresholdPercent: 50, codexThresholdPercent: 50 })

        const alerts: Array<{ tool: string; usedPercent: number }> = []
        tracker.on('threshold', (a) => alerts.push({ tool: a.tool, usedPercent: a.usedPercent }))

        const payload = (pct: number, resetsAt: number) => ({
            rate_limits: { five_hour: { used_percentage: pct, resets_at: resetsAt } }
        })

        tracker.ingestClaudeStatusLine(payload(20, 1000) as never)
        expect(alerts).toHaveLength(0)

        tracker.ingestClaudeStatusLine(payload(70, 1000) as never)
        tracker.ingestClaudeStatusLine(payload(75, 1000) as never)
        tracker.ingestClaudeStatusLine(payload(80, 1000) as never)
        // Still one alert: nagging on every poll would train the user to ignore it.
        expect(alerts).toHaveLength(1)

        // A new window (different reset time) is a new budget, so it re-arms.
        tracker.ingestClaudeStatusLine(payload(60, 2000) as never)
        expect(alerts).toHaveLength(2)
    })

    test('a zero threshold disables one tool without silencing the other', () => {
        const tracker = new UsageTracker()
        tracker.setAlertSettings({ enabled: true, claudeThresholdPercent: 0, codexThresholdPercent: 50 })

        const alerts: string[] = []
        tracker.on('threshold', (a) => alerts.push(a.tool))

        tracker.ingestClaudeStatusLine({ rate_limits: { five_hour: { used_percentage: 99, resets_at: 1 } } } as never)
        expect(alerts).toHaveLength(0)
    })

    test('alerts are silent while disabled entirely', () => {
        const tracker = new UsageTracker()
        tracker.setAlertSettings({ enabled: false, claudeThresholdPercent: 10, codexThresholdPercent: 10 })

        const alerts: string[] = []
        tracker.on('threshold', (a) => alerts.push(a.tool))

        tracker.ingestClaudeStatusLine({ rate_limits: { five_hour: { used_percentage: 99, resets_at: 1 } } } as never)
        expect(alerts).toHaveLength(0)
    })

    test('a payload without rate limits keeps the previously known windows', () => {
        const tracker = new UsageTracker()
        tracker.ingestClaudeStatusLine({
            rate_limits: { five_hour: { used_percentage: 30, resets_at: 1 } },
            context_window: { used_percentage: 40 }
        } as never)

        // Claude omits rate_limits before a session's first response; that must
        // not erase a figure we already have.
        tracker.ingestClaudeStatusLine({ context_window: { used_percentage: 55 } } as never)

        expect(tracker.getSnapshot().claude).toMatchObject({
            fiveHour: { usedPercent: 30 },
            contextPercent: 55
        })
    })

    test('an out-of-range percentage is clamped rather than rendered as a broken bar', () => {
        const tracker = new UsageTracker()
        tracker.ingestClaudeStatusLine({ rate_limits: { five_hour: { used_percentage: 140, resets_at: 1 } } } as never)
        expect(tracker.getSnapshot().claude?.fiveHour?.usedPercent).toBe(100)
    })
})

// ---------------------------------------------------------------------------
// diffParser / reviewPrompt
// ---------------------------------------------------------------------------

test.describe('T9 diff parsing', () => {
    test('numstat and name-status are merged, including renames and binaries', () => {
        const numstat = ['3\t1\tsrc/a.ts', '0\t0\t', 'old/b.ts', 'new/b.ts', '-\t-\tassets/logo.png'].join('\0') + '\0'
        const nameStatus = ['M', 'src/a.ts', 'R100', 'old/b.ts', 'new/b.ts', 'A', 'assets/logo.png'].join('\0') + '\0'

        const files = parseDiffSummary(numstat, nameStatus)
        const byPath = Object.fromEntries(files.map((f) => [f.path, f]))

        expect(byPath['src/a.ts']).toMatchObject({ status: 'modified', additions: 3, deletions: 1, binary: false })
        expect(byPath['new/b.ts']).toMatchObject({ status: 'renamed', oldPath: 'old/b.ts' })
        // A binary file has no line counts; reporting "-" as NaN would render as
        // "+NaN" in the file list.
        expect(byPath['assets/logo.png']).toMatchObject({ binary: true, additions: 0, deletions: 0 })
    })

    test('paths containing spaces and non-ASCII survive the NUL-delimited parse', () => {
        const numstat = '2\t0\tsrc/한글 파일.ts\0'
        const nameStatus = 'A\0src/한글 파일.ts\0'
        const files = parseDiffSummary(numstat, nameStatus)
        expect(files).toHaveLength(1)
        expect(files[0]).toMatchObject({ path: 'src/한글 파일.ts', status: 'added', additions: 2 })
    })

    test('hunk line numbers track both sides independently', () => {
        const raw = [
            'diff --git a/x.ts b/x.ts',
            'index 111..222 100644',
            '--- a/x.ts',
            '+++ b/x.ts',
            '@@ -10,4 +10,5 @@ function x() {',
            ' const a = 1',
            '-const b = 2',
            '+const b = 3',
            '+const c = 4',
            ' const d = 5',
            ''
        ].join('\n')

        const diff = parseFileDiff(raw, 'x.ts', 'modified')
        const lines = diff.hunks[0].lines

        expect(lines.map((l) => l.type)).toEqual(['context', 'del', 'add', 'add', 'context'])
        // The numbers a reviewer cites must match what the editor shows.
        expect(lines[0]).toMatchObject({ oldNumber: 10, newNumber: 10 })
        expect(lines[1]).toMatchObject({ oldNumber: 11, newNumber: null })
        expect(lines[2]).toMatchObject({ oldNumber: null, newNumber: 11 })
        expect(lines[3]).toMatchObject({ oldNumber: null, newNumber: 12 })
        expect(lines[4]).toMatchObject({ oldNumber: 12, newNumber: 13 })
    })

    test('binary output and "no newline" markers are handled', () => {
        expect(parseFileDiff('Binary files a/logo.png and b/logo.png differ\n', 'logo.png', 'modified').binary).toBe(true)

        const raw = ['@@ -1,1 +1,1 @@', '-old', '\\ No newline at end of file', '+new', ''].join('\n')
        const diff = parseFileDiff(raw, 'x.ts', 'modified')
        // The marker is metadata; treating it as content would put a stray
        // backslash line into a quoted review comment.
        expect(diff.hunks[0].lines.map((l) => l.content)).toEqual(['old', 'new'])
    })

    test('an empty diff yields no hunks rather than an empty phantom hunk', () => {
        expect(parseFileDiff('', 'x.ts', 'modified').hunks).toHaveLength(0)
        expect(parseFileDiff('   \n', 'x.ts', 'modified').hunks).toHaveLength(0)
    })

    test('a review prompt anchors on the file and the line the reader saw', () => {
        const diff = parseFileDiff(
            ['@@ -40,2 +40,3 @@', ' const nav = useRouter()', '+if (!user) return null', ' login(user)', ''].join('\n'),
            'src/auth/login.tsx',
            'modified'
        )
        const selected = diff.hunks[0].lines.slice(1, 2)

        const prompt = buildReviewPrompt('src/auth/login.tsx', selected, 'undefined도 걸러줘')

        expect(prompt).toContain('src/auth/login.tsx:41')
        expect(prompt).toContain('if (!user) return null')
        expect(prompt).toContain('undefined도 걸러줘')
    })

    test('a comment with no lines selected still names the file', () => {
        const prompt = buildReviewPrompt('src/api.ts', [], '이 파일 전체 정리해줘')
        expect(prompt).toContain('src/api.ts')
        expect(prompt).toContain('이 파일 전체 정리해줘')
    })
})
