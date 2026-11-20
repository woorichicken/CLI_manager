import { test, expect } from '@playwright/test'
import path from 'path'
import { parseStatusReport, runStatusCommand } from '../../src/main/statusCommand'

/**
 * T157 — Status panel, without Electron (fb-1120b queues).
 *
 * The System Monitor runs the user's status command and draws its JSON. A row the app cannot read
 * must say "failed", never pass as fine, and a command that exits 3 because something is blocked
 * (what `queues status --json` does) still has a report to show.
 *
 * Fails on the code before this change: the module does not exist.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'status-command')
const node = (file: string): string => `"${process.execPath}" "${path.join(FIXTURES, file)}"`

test.describe('T157 status report — parse', () => {
    test('reads a v1 report, recounts the rows, and turns an unknown state into error', () => {
        const parsed = parseStatusReport(JSON.stringify({
            version: 1,
            generatedAt: '2026-11-20T13:00:00.000Z',
            counts: { ok: 50, busy: 0, attention: 0, blocked: 0, error: 0 },
            sources: [
                { id: 'a', name: 'A', state: 'blocked', summary: 's', items: [{ text: 'x', state: 'blocked' }] },
                { id: 'b', name: 'B', state: 'sideways', summary: 's', items: [] }
            ]
        }))
        expect('report' in parsed).toBe(true)
        if (!('report' in parsed)) return
        expect(parsed.report.counts).toEqual({ ok: 0, busy: 0, attention: 0, blocked: 1, error: 1 })
        expect(parsed.report.sources[1].state).toBe('error')
        expect(parsed.report.sources[0].items[0]).toEqual({ text: 'x', state: 'blocked' })
    })

    test('skips text a login shell prints before the JSON', () => {
        const parsed = parseStatusReport('Last login: Thu\n{"version":1,"sources":[]}')
        expect('report' in parsed).toBe(true)
    })

    test('a brace inside a warning line is not where the report starts', () => {
        const parsed = parseStatusReport('warning: check /path/{a,b} first\n{\n "version": 1,\n "sources": []\n}')
        expect('report' in parsed).toBe(true)
    })

    test('refuses other versions, missing sources and non-JSON', () => {
        expect(parseStatusReport('{"version":2,"sources":[]}')).toEqual({ error: 'unsupported report version 2 (expected 1)' })
        expect(parseStatusReport('{"version":1}')).toEqual({ error: 'report has no "sources" array' })
        expect(parseStatusReport('nothing here')).toEqual({ error: 'no JSON in the output' })
    })

    test('caps rows, items and text so a runaway command cannot flood the popover', () => {
        const long = 'x'.repeat(5000)
        const sources = Array.from({ length: 100 }, (_, i) => ({
            id: `s${i}`, name: long, state: 'ok', summary: long, items: Array.from({ length: 500 }, () => ({ text: long }))
        }))
        const parsed = parseStatusReport(JSON.stringify({ version: 1, sources }))
        if (!('report' in parsed)) throw new Error(parsed.error)
        expect(parsed.report.sources.length).toBe(40)
        expect(parsed.report.sources[0].items.length).toBe(60)
        expect(parsed.report.sources[0].name.length).toBe(300)
    })
})

test.describe('T157 status report — run', () => {
    test('a command that exits 3 with a report is a report', async () => {
        const result = await runStatusCommand(node('report.cjs'))
        expect(result.configured && result.ok).toBe(true)
        if (!(result.configured && result.ok)) return
        expect(result.report.counts).toEqual({ ok: 1, busy: 0, attention: 1, blocked: 1, error: 1 })
        expect(result.report.sources.map(s => s.id)).toEqual(['heavy', 'browser', 'list', 'remote'])
    })

    test('a command with no JSON says why, with its exit code and last stderr line', async () => {
        const result = await runStatusCommand(node('broken.cjs'))
        expect(result).toMatchObject({ configured: true, ok: false })
        if (result.configured && !result.ok) {
            expect(result.error).toContain('no JSON in the output (exit 1)')
            expect(result.error).toContain('cannot reach the control API')
        }
    })

    test('a command that hangs is cut off at the timeout', async () => {
        const result = await runStatusCommand('sleep 5', 500)
        expect(result).toMatchObject({ configured: true, ok: false, error: 'timed out after 1s' })
    })
})
