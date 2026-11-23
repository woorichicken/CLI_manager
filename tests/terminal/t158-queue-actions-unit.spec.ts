import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createStatusService, parseStatusReport, runStatusAction } from '../../src/main/statusCommand'

/**
 * T158 — queue actions, without Electron (fb-1123 queues API, decision 0014).
 *
 * A row is read only unless its queue lists the action and the row offers it now, and Settings has an
 * action command. Only then does the command run, with the names as arguments. Everything else is
 * refused before anything runs — checked against act.cjs's own log, not the app's answer.
 *
 * Fails on the code before this change: createStatusService and runStatusAction do not exist.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'status-command')
const node = (file: string): string => `"${process.execPath}" "${path.join(FIXTURES, file)}"`

function fixtureState(): { dir: string; calls: () => string[][]; env: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't158-'))
    const log = path.join(dir, 'act.log')
    return {
        dir,
        env: `STATUS_FIXTURE_STATE="${dir}"`,
        calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
    }
}

test.describe('T158 queue actions — parse', () => {
    test('keeps plain action ids only, and a row offers only what its queue lists', () => {
        const parsed = parseStatusReport(JSON.stringify({
            version: 1,
            sources: [
                { id: 'jobs', name: 'Jobs', state: 'busy', summary: '', actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'rm -rf' }, { label: 'no id' }],
                  items: [
                      { id: 'q1', text: 'a', actions: ['cancel', 'retry', 'rm -rf'] },
                      { id: 'bad id!', text: 'b', actions: ['cancel'] },
                      { text: 'no id', actions: ['cancel'] }
                  ] },
                { id: 'heavy', name: 'Heavy', state: 'busy', summary: '', items: [{ id: 'h1', text: 'c', actions: ['cancel'] }] }
            ]
        }))
        if (!('report' in parsed)) throw new Error(parsed.error)
        const [jobs, heavy] = parsed.report.sources
        expect(jobs.actions).toEqual([{ id: 'cancel', label: 'Cancel' }])
        expect(jobs.items.map(i => [i.id, i.actions])).toEqual([['q1', ['cancel']], [undefined, []], [undefined, []]])
        // a queue that lists no action is read only, whatever its rows claim
        expect(heavy.actions).toEqual([])
        expect(heavy.items[0].actions).toEqual([])
    })
})

test.describe('T158 queue actions — run', () => {
    test('an offered action runs once with the names as arguments, and the next report no longer has the row', async () => {
        const st = fixtureState()
        const service = createStatusService(() => ({ command: `${st.env} ${node('report-actions.cjs')}`, actionCommand: `${st.env} ${node('act.cjs')}` }))
        const before = await service.report()
        expect(before.configured && before.ok && before.actionsEnabled).toBe(true)

        const result = await service.act('jobs', 'q1', 'cancel')
        expect(result).toMatchObject({ ok: true, source: 'jobs', item: 'q1', action: 'cancel', output: 'cancelled q1' })
        expect(st.calls()).toEqual([['jobs', 'q1', 'cancel']])

        const after = await service.report()
        if (!(after.configured && after.ok)) throw new Error('report failed')
        expect(after.report.sources[0].items.map(i => i.id)).not.toContain('q1')
        // the same call again: the row is gone, nothing runs
        expect(await service.act('jobs', 'q1', 'cancel')).toMatchObject({ ok: false, status: 404, code: 'queue_item_not_found' })
        expect(st.calls()).toHaveLength(1)
    })

    test('everything not offered right now is refused before anything runs', async () => {
        const st = fixtureState()
        const service = createStatusService(() => ({ command: `${st.env} ${node('report-actions.cjs')}`, actionCommand: `${st.env} ${node('act.cjs')}` }))
        const refusals: Array<[string, string, string, number, string]> = [
            ['jobs', 'r1', 'cancel', 409, 'action_not_offered'],        // running: no cancel
            ['heavy', 'h1', 'cancel', 409, 'action_not_offered'],       // read-only queue
            ['jobs', 'q1', 'retry', 409, 'action_not_offered'],
            ['jobs', 'nope', 'cancel', 404, 'queue_item_not_found'],
            ['nope', 'q1', 'cancel', 404, 'queue_not_found'],
            ['jobs', 'bad id!', 'cancel', 400, 'bad_request'],
            ['jobs', 'q1;touch x', 'cancel', 400, 'bad_request'],
            ['jobs', 'q1', 'rm -rf', 400, 'bad_request']
        ]
        for (const [source, item, action, status, code] of refusals) {
            expect(await service.act(source, item, action), `${source} ${item} ${action}`).toEqual(expect.objectContaining({ ok: false, status, code }))
        }
        expect(st.calls()).toEqual([])
    })

    test('no action command: rows are read only and nothing runs', async () => {
        const st = fixtureState()
        const service = createStatusService(() => ({ command: `${st.env} ${node('report-actions.cjs')}` }))
        const report = await service.report()
        expect(report.configured && report.ok && report.actionsEnabled).toBe(false)
        expect(await service.act('jobs', 'q1', 'cancel')).toMatchObject({ ok: false, status: 404, code: 'actions_off' })
        await expect(createStatusService(() => ({})).act('jobs', 'q1', 'cancel')).resolves.toMatchObject({ code: 'not_configured' })
        expect(st.calls()).toEqual([])
    })

    test('a failing action says so with its exit code and last line', async () => {
        const st = fixtureState()
        const service = createStatusService(() => ({ command: `${st.env} ${node('report-actions.cjs')}`, actionCommand: `${st.env} ${node('act.cjs')}` }))
        expect(await service.act('jobs', 'fail', 'cancel')).toEqual({
            ok: false, status: 502, code: 'action_failed', message: 'exit 5 — queue refused: already started'
        })
    })

    test('the names reach the command as arguments, never as shell text', async () => {
        const st = fixtureState()
        const marker = path.join(st.dir, 'should-not-exist')
        const ran = await runStatusAction(`${st.env} ${node('act.cjs')}`, 'jobs', `x; touch "${marker}"`, '$(touch x)')
        expect(ran.exitCode).toBe(0)
        expect(st.calls()).toEqual([['jobs', `x; touch "${marker}"`, '$(touch x)']])
        expect(fs.existsSync(marker)).toBe(false)
    })
})
