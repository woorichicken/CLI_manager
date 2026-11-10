import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DictationService } from '../../src/main/Dictation'
import { DictationLog, dictationLogDay, type DictationLogEntry, type DictationLogSettings } from '../../src/main/DictationLog'
import type { DictationEvent } from '../../src/shared/dictation'

/**
 * T114 — the dictation log without Electron (people's decision 11-09, decision 0012).
 *
 *  - off (the default): no folder, no file, no sound — whatever happens
 *  - one line per run: final (whole run, across a pause) next to the message sent, or why not
 *    (cancelled · edited-away · discarded · empty · failed), agent, locale, partial count, duration
 *  - masked before it is written; folder 0700, files 0600; turned off mid-run keeps nothing
 *  - sound only with "Also keep audio"; the WAV the helper wrote is kept 0600
 *  - retention: day files after 30 days, sounds after 7 — and pruning never creates the folder
 *  - DictationService with the fake helper drives it end to end (stop → report sent)
 */

const FAKE = path.join(__dirname, 'fixtures/fake-dictation.cjs')
const DAY = 24 * 60 * 60 * 1000

interface Rig {
    dir: string
    log: DictationLog
    settings: DictationLogSettings
    clock: { now: number }
    lines(): DictationLogEntry[]
}

function rig(settings: Partial<DictationLogSettings> = {}, outcomeWaitMs?: number): Rig {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t114-'))
    const dir = path.join(root, 'dictation-log')
    const current: DictationLogSettings = { enabled: true, audio: false, ...settings }
    const clock = { now: new Date(2026, 10, 9, 14, 0, 0).getTime() }
    let next = 0
    const log = new DictationLog({
        dir,
        settings: () => current,
        homeDir: '/Users/someone',
        now: () => clock.now,
        outcomeWaitMs,
        newId: () => `run-${++next}`
    })
    const lines = (): DictationLogEntry[] =>
        fs.existsSync(dir)
            ? fs
                  .readdirSync(dir)
                  .filter((name) => name.endsWith('.jsonl'))
                  .sort()
                  .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n'))
                  .filter(Boolean)
                  .map((line) => JSON.parse(line) as DictationLogEntry)
            : []
    return { dir, log, settings: current, clock, lines }
}

/** A run as DictationService reports it: listening, partials, final, then the helper's end. */
function speak(r: Rig, runId: number, words: string[], options: { owner?: number; agent?: 'claude' | 'codex'; final?: string; endAfterMs?: number } = {}): void {
    const owner = options.owner ?? 7
    r.log.begin(runId, owner, { agent: options.agent ?? 'claude' })
    r.log.heard(runId, { id: runId, type: 'listening' }, 'ko_KR')
    for (const text of words) r.log.heard(runId, { id: runId, type: 'partial', text })
    r.clock.now += options.endAfterMs ?? 2500
    r.log.heard(runId, { id: runId, type: 'final', text: options.final ?? `${words.at(-1) ?? ''}.` })
    r.log.ended(runId)
}

const mode = (file: string): number => fs.statSync(file).mode & 0o777

test.describe('T114 off by default', () => {
    test('off: nothing is created, whatever the run does', () => {
        const r = rig({ enabled: false, audio: true })
        expect(r.log.begin(1, 7, { agent: 'claude' })).toEqual({ audioPath: null })
        r.log.heard(1, { id: 1, type: 'listening' }, 'ko_KR')
        r.log.heard(1, { id: 1, type: 'final', text: '안녕.' })
        r.log.ended(1)
        r.log.report(1, 7, { type: 'sent', text: '안녕.' })
        r.log.ownerGone(7)
        r.log.flush()
        expect(r.log.prune()).toEqual({ text: 0, audio: 0 })
        expect(fs.existsSync(r.dir)).toBe(false)
    })
})

test.describe('T114 one line per run', () => {
    test('sent: the words heard next to the whole message sent', () => {
        const r = rig()
        speak(r, 1, ['안녕하세요', '안녕하세요 받아쓰기'])
        expect(r.lines()).toEqual([]) // waits for what the Chat view did with them
        r.log.report(1, 7, { type: 'sent', text: '앞 글 안녕하세요 받아 쓰기.' })
        const [entry] = r.lines()
        expect(entry).toEqual({
            v: 1,
            id: 'run-1',
            startedAt: new Date(2026, 10, 9, 14, 0, 0).toISOString(),
            durationMs: 2500,
            locale: 'ko_KR',
            agent: 'claude',
            partialCount: 2,
            finalText: '안녕하세요 받아쓰기.',
            sentText: '앞 글 안녕하세요 받아 쓰기.',
            outcome: 'sent',
            audioFile: null
        })
        const file = path.join(r.dir, '2026-11-09.jsonl')
        expect(fs.existsSync(file)).toBe(true)
        expect(mode(r.dir)).toBe(0o700)
        expect(mode(file)).toBe(0o600)
    })

    test('a report that comes before the helper ends still lands once', () => {
        const r = rig()
        r.log.begin(1, 7, { agent: 'codex' })
        r.log.heard(1, { id: 1, type: 'listening' }, 'en_US')
        r.log.heard(1, { id: 1, type: 'final', text: 'fix it' })
        r.log.report(1, 7, { type: 'sent', text: 'fix it now' })
        expect(r.lines()).toEqual([])
        r.log.ended(1)
        expect(r.lines()).toMatchObject([{ agent: 'codex', locale: 'en_US', finalText: 'fix it', sentText: 'fix it now', outcome: 'sent' }])
    })

    test('Esc: cancelled, with the last words heard; a box that went away: discarded', () => {
        const r = rig()
        r.log.begin(1, 7, {})
        r.log.heard(1, { id: 1, type: 'listening' }, 'ko_KR')
        r.log.heard(1, { id: 1, type: 'partial', text: '취소할 말' })
        r.log.ended(1, 'cancelled')
        r.log.begin(2, 7, {})
        r.log.heard(2, { id: 2, type: 'listening' }, 'ko_KR')
        r.log.heard(2, { id: 2, type: 'partial', text: '다른 세션' })
        r.log.ended(2, 'discarded')
        expect(r.lines()).toMatchObject([
            { outcome: 'cancelled', finalText: '취소할 말', sentText: null, agent: null },
            { outcome: 'discarded', finalText: '다른 세션', sentText: null }
        ])
    })

    test('emptied box: edited-away; nothing heard: empty; a failure: failed with its code', () => {
        const r = rig()
        speak(r, 1, ['지울 말'])
        r.log.report(1, 7, { type: 'edited-away' })
        speak(r, 2, [], { final: '' })
        r.log.begin(3, 7, {})
        r.log.heard(3, { id: 3, type: 'listening' }, 'ko_KR')
        r.log.heard(3, { id: 3, type: 'error', code: 'recognition_failed', message: 'x' })
        r.log.ended(3)
        expect(r.lines()).toMatchObject([
            { id: 'run-1', outcome: 'edited-away', sentText: null, finalText: '지울 말.' },
            { id: 'run-2', outcome: 'empty', finalText: '' },
            { id: 'run-3', outcome: 'failed', error: 'recognition_failed' }
        ])
        expect(r.lines()[0]).not.toHaveProperty('error')
    })

    test('a run that never listened (microphone refused) leaves no line', () => {
        const r = rig()
        r.log.begin(1, 7, {})
        r.log.heard(1, { id: 1, type: 'error', code: 'mic_denied', message: 'x' })
        r.log.ended(1)
        expect(fs.existsSync(r.dir)).toBe(false)
    })

    test('no report: discarded after the wait, when the window goes, or when the app quits', async () => {
        const r = rig({}, 50)
        speak(r, 1, ['기다린 말'])
        speak(r, 2, ['창이 닫힘'], { owner: 9 })
        speak(r, 3, ['앱 종료'], { owner: 11 })
        r.log.ownerGone(9)
        r.log.flush()
        await new Promise((resolve) => setTimeout(resolve, 120))
        expect(r.lines().map((entry) => [entry.id, entry.outcome])).toEqual([
            ['run-2', 'discarded'],
            ['run-1', 'discarded'],
            ['run-3', 'discarded']
        ])
    })

    test('another window cannot report a run; a second report adds nothing', () => {
        const r = rig()
        speak(r, 1, ['내 말'])
        r.log.report(1, 99, { type: 'sent', text: 'someone else' })
        expect(r.lines()).toEqual([])
        r.log.report(1, 7, { type: 'sent', text: '내 말.' })
        r.log.report(1, 7, { type: 'sent', text: 'again' })
        expect(r.lines()).toMatchObject([{ sentText: '내 말.' }])
    })

    test('masked before it is written: keys, passwords, the home folder', () => {
        const r = rig()
        // fake credentials are joined at run time: the CI secret scan reads test files too (as T32 does)
        const token = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz', '0123'].join('')
        const assignment = ['pass', 'word', '=', 'hunter2', 'hunter2'].join('')
        speak(r, 1, [`토큰은 ${token}`], { final: `토큰은 ${token}` })
        r.log.report(1, 7, { type: 'sent', text: `${assignment}\n/Users/someone/project 열어줘` })
        const [entry] = r.lines()
        expect(entry.finalText).toBe('토큰은 [REDACTED]')
        expect(entry.sentText).toBe('password=[REDACTED]\n~/project 열어줘')
        const raw = fs.readFileSync(path.join(r.dir, '2026-11-09.jsonl'), 'utf8')
        expect(raw).not.toContain(token)
        expect(raw).not.toContain('hunter2')
        expect(raw).not.toContain('/Users/someone')
    })

    test('turned off before the line is written: nothing is kept, the sound goes too', () => {
        const r = rig({ audio: true })
        const { audioPath } = r.log.begin(1, 7, {})
        expect(audioPath).toBe(path.join(r.dir, 'audio', 'run-1.wav'))
        fs.writeFileSync(audioPath as string, 'RIFF')
        r.log.heard(1, { id: 1, type: 'listening' }, 'ko_KR')
        r.log.heard(1, { id: 1, type: 'final', text: '끈 뒤' })
        r.log.ended(1)
        r.settings.enabled = false
        r.log.report(1, 7, { type: 'sent', text: '끈 뒤' })
        expect(r.lines()).toEqual([])
        expect(fs.existsSync(audioPath as string)).toBe(false)
    })
})

test.describe('T114 sound', () => {
    test('only with "Also keep audio"; kept 0600 in audio/, named in the line', () => {
        const without = rig({ audio: false })
        expect(without.log.begin(1, 7, {}).audioPath).toBeNull()
        const r = rig({ audio: true })
        const { audioPath } = r.log.begin(1, 7, {})
        expect(mode(path.join(r.dir, 'audio'))).toBe(0o700)
        fs.writeFileSync(audioPath as string, 'RIFF', { mode: 0o644 })
        r.log.heard(1, { id: 1, type: 'listening' }, 'ko_KR')
        r.log.heard(1, { id: 1, type: 'final', text: '소리도' })
        r.log.ended(1)
        r.log.report(1, 7, { type: 'sent', text: '소리도' })
        expect(r.lines()).toMatchObject([{ audioFile: 'audio/run-1.wav' }])
        expect(mode(audioPath as string)).toBe(0o600)
    })

    test('a run that never listened leaves no sound file', () => {
        const r = rig({ audio: true })
        const { audioPath } = r.log.begin(1, 7, {})
        fs.writeFileSync(audioPath as string, 'RIFF')
        r.log.ended(1)
        expect(fs.existsSync(audioPath as string)).toBe(false)
    })
})

test.describe('T114 retention', () => {
    test('day files after 30 days, sounds after 7; the rest stays', () => {
        const r = rig({ audio: true })
        fs.mkdirSync(path.join(r.dir, 'audio'), { recursive: true })
        const now = r.clock.now
        const day = (ago: number): string => path.join(r.dir, `${dictationLogDay(now - ago * DAY)}.jsonl`)
        for (const ago of [0, 29, 30, 31, 45]) fs.writeFileSync(day(ago), '{}\n')
        fs.writeFileSync(path.join(r.dir, 'notes.txt'), 'not ours')
        const sound = (name: string, ago: number): string => {
            const file = path.join(r.dir, 'audio', name)
            fs.writeFileSync(file, 'RIFF')
            const time = new Date(now - ago * DAY)
            fs.utimesSync(file, time, time)
            return file
        }
        const fresh = sound('fresh.wav', 6.9)
        const old = sound('old.wav', 7.1)
        expect(r.log.prune()).toEqual({ text: 2, audio: 1 })
        expect([0, 29, 30].every((ago) => fs.existsSync(day(ago)))).toBe(true)
        expect([31, 45].some((ago) => fs.existsSync(day(ago)))).toBe(false)
        expect(fs.existsSync(path.join(r.dir, 'notes.txt'))).toBe(true)
        expect(fs.existsSync(fresh)).toBe(true)
        expect(fs.existsSync(old)).toBe(false)
    })

    test('pruning a Mac that never kept a log creates nothing', () => {
        const r = rig()
        expect(r.log.prune()).toEqual({ text: 0, audio: 0 })
        expect(fs.existsSync(r.dir)).toBe(false)
    })

    test('Delete all: the folder goes, and a run still waiting writes nothing later', () => {
        const r = rig()
        speak(r, 1, ['먼저'])
        r.log.report(1, 7, { type: 'sent', text: '먼저' })
        speak(r, 2, ['기다리는 말'])
        r.log.deleteAll()
        expect(fs.existsSync(r.dir)).toBe(false)
        r.log.report(2, 7, { type: 'sent', text: '기다리는 말' })
        expect(fs.existsSync(r.dir)).toBe(false)
    })
})

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
    const end = Date.now() + ms
    while (!check()) {
        if (Date.now() > end) throw new Error('timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

test.describe('T114 DictationService with the fake helper', () => {
    test.afterEach(() => {
        delete process.env.FAKE_DICTATION_MODE
    })

    for (const audio of [false, true]) {
        test(`start → stop → sent: one line, the whole run across a pause${audio ? ', with its WAV' : ''}`, async () => {
            process.env.FAKE_DICTATION_MODE = 'pause'
            const r = rig({ audio })
            const events: DictationEvent[] = []
            const service = new DictationService({ helperPath: () => FAKE, platform: 'darwin', send: (_owner, event) => events.push(event), recorder: r.log })
            const started = service.start(7, { agent: 'claude' })
            const id = started.status === 'started' ? started.id : -1
            await until(() => events.filter((e) => e.type === 'partial').length >= 3)
            service.stop(7, id)
            await until(() => events.some((e) => e.type === 'ended'))
            service.report(7, id, { type: 'sent', text: '안녕하세요 받아 쓰기 시험입니다.' })
            const [entry] = r.lines()
            expect(entry).toMatchObject({
                locale: 'ko_KR',
                agent: 'claude',
                partialCount: 3,
                finalText: '안녕하세요 받아쓰기 시험입니다.',
                sentText: '안녕하세요 받아 쓰기 시험입니다.',
                outcome: 'sent',
                audioFile: audio ? `audio/${entry.id}.wav` : null
            })
            if (audio) {
                const wav = fs.readFileSync(path.join(r.dir, entry.audioFile as string))
                expect(wav.subarray(0, 4).toString()).toBe('RIFF')
                expect(wav.subarray(8, 12).toString()).toBe('WAVE')
                expect(mode(path.join(r.dir, entry.audioFile as string))).toBe(0o600)
            } else expect(fs.existsSync(path.join(r.dir, 'audio'))).toBe(false)
        })
    }

    test('Esc → cancelled; the window going away → discarded; off → no folder', async () => {
        const r = rig()
        const events: DictationEvent[] = []
        const service = new DictationService({ helperPath: () => FAKE, platform: 'darwin', send: (_owner, event) => events.push(event), recorder: r.log })
        const first = service.start(7)
        await until(() => events.some((e) => e.type === 'partial'))
        service.cancel(7, first.status === 'started' ? first.id : -1)
        await until(() => r.lines().length === 1)
        events.length = 0
        service.start(7)
        await until(() => events.some((e) => e.type === 'partial'))
        service.ownerGone(7)
        await until(() => r.lines().length === 2)
        expect(r.lines().map((entry) => entry.outcome)).toEqual(['cancelled', 'discarded'])

        const off = rig({ enabled: false, audio: true })
        const quiet: DictationEvent[] = []
        const offService = new DictationService({ helperPath: () => FAKE, platform: 'darwin', send: (_owner, event) => quiet.push(event), recorder: off.log })
        const run = offService.start(7)
        await until(() => quiet.some((e) => e.type === 'partial'))
        offService.stop(7, run.status === 'started' ? run.id : -1)
        await until(() => quiet.some((e) => e.type === 'ended'))
        offService.report(7, run.status === 'started' ? run.id : -1, { type: 'sent', text: 'x' })
        offService.dispose()
        expect(fs.existsSync(off.dir)).toBe(false)
    })
})
