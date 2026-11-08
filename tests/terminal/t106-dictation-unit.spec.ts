import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DictationService, parseLine, parseStatus } from '../../src/main/Dictation'
import { dictationAnchor, placeDictation } from '../../src/renderer/src/components/ChatView/dictationText'
import type { DictationEvent } from '../../src/shared/dictation'

/**
 * T106 — Chat dictation without Electron (people's decision 11-08: Orca-style, macOS on-device).
 *
 *  - where the words go in the box (cursor, selection, spaces) — each partial replaces the last
 *  - main's reading of the helper's lines and its status
 *  - DictationService against the fake helper: event order, stop → final, cancel → silence,
 *    one run at a time, SIGABRT (no usage description) → permission_setup, not macOS / no helper
 *  - the real helper's `status` line, when it is built on this Mac (pnpm build:dictation)
 */

const REPO = path.join(__dirname, '../..')
const FAKE = path.join(__dirname, 'fixtures/fake-dictation.cjs')
const REAL = path.join(REPO, 'native/dictation/bin/climanager-dictation')

test.describe('T106 where dictated words go', () => {
    test('at the cursor, with a space only where the text has none', () => {
        expect(placeDictation(dictationAnchor('', 0, 0), '안녕하세요')).toEqual({ text: '안녕하세요', caret: 5 })
        expect(placeDictation(dictationAnchor('이 파일', 4, 4), '고쳐줘')).toEqual({ text: '이 파일 고쳐줘', caret: 8 })
        expect(placeDictation(dictationAnchor('이 파일 ', 5, 5), '고쳐줘')).toEqual({ text: '이 파일 고쳐줘', caret: 8 })
        // in the middle: a space on each side that lacks one
        expect(placeDictation(dictationAnchor('ab', 1, 1), 'X')).toEqual({ text: 'a X b', caret: 3 })
        // over a selection
        expect(placeDictation(dictationAnchor('fix the bug now', 4, 11), 'that typo')).toEqual({ text: 'fix that typo now', caret: 13 })
    })

    test('a later partial replaces the earlier one; nothing heard puts the text back', () => {
        const anchor = dictationAnchor('앞 뒤', 2, 2)
        expect(placeDictation(anchor, '안녕').text).toBe('앞 안녕 뒤')
        expect(placeDictation(anchor, '안녕하세요 여러분').text).toBe('앞 안녕하세요 여러분 뒤')
        expect(placeDictation(anchor, '   ')).toEqual({ text: '앞 뒤', caret: 2 })
    })

    test('a stale selection past the end is clamped', () => {
        expect(placeDictation(dictationAnchor('abc', 10, 12), 'd')).toEqual({ text: 'abc d', caret: 5 })
    })
})

test.describe('T106 reading the helper', () => {
    test('lines', () => {
        expect(parseLine(3, '{"type":"listening","locale":"ko_KR"}')).toEqual({ id: 3, type: 'listening' })
        expect(parseLine(3, '{"type":"partial","text":"안녕"}')).toEqual({ id: 3, type: 'partial', text: '안녕' })
        expect(parseLine(3, '{"type":"final","text":"안녕."}')).toEqual({ id: 3, type: 'final', text: '안녕.' })
        expect(parseLine(3, '{"type":"error","code":"mic_denied","message":"m"}')).toEqual({ id: 3, type: 'error', code: 'mic_denied', message: 'm' })
        // an unknown code from a newer helper is still an error, never a crash
        expect(parseLine(3, '{"type":"error","code":"later","message":"m"}')).toMatchObject({ type: 'error', code: 'helper_failed' })
        expect(parseLine(3, 'not json')).toBeNull()
        expect(parseLine(3, '{"type":"level"}')).toBeNull()
    })

    test('status', () => {
        expect(parseStatus('{"type":"status","supported":true,"onDevice":true,"locale":"ko_KR","speech":"notDetermined","mic":"denied"}')).toEqual({
            available: true,
            reason: null,
            locale: 'ko_KR',
            speech: 'notDetermined',
            mic: 'denied'
        })
        // a Mac that would need Apple's servers for its language: no button, not a server fallback
        expect(parseStatus('{"type":"status","supported":true,"onDevice":false,"locale":"xx","speech":"authorized","mic":"authorized"}')).toMatchObject({ available: false, reason: 'unsupported' })
        expect(parseStatus('garbage')).toMatchObject({ available: false, reason: 'helper_failed' })
    })
})

interface Harness {
    service: DictationService
    events: DictationEvent[]
    log: string
}

function harness(mode = 'ok', options: { platform?: NodeJS.Platform; helper?: string | null } = {}): Harness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t106-'))
    const log = path.join(dir, 'calls.log')
    process.env.FAKE_DICTATION_MODE = mode
    process.env.FAKE_DICTATION_LOG = log
    const events: DictationEvent[] = []
    const service = new DictationService({
        helperPath: () => (options.helper === undefined ? FAKE : options.helper),
        platform: options.platform ?? 'darwin',
        send: (owner, event) => {
            expect(owner).toBe(7)
            events.push(event)
        }
    })
    return { service, events, log }
}

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
    const end = Date.now() + ms
    while (!check()) {
        if (Date.now() > end) throw new Error('timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}
const calls = (log: string): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [])

test.describe('T106 DictationService with the fake helper', () => {
    test('listening → partials → stop → final → ended', async () => {
        const { service, events, log } = harness()
        expect(await service.status()).toMatchObject({ available: true, locale: 'ko_KR' })
        const started = service.start(7)
        expect(started.status).toBe('started')
        const id = started.status === 'started' ? started.id : -1
        await until(() => events.filter((e) => e.type === 'partial').length >= 3)
        service.stop(7, id)
        await until(() => events.some((e) => e.type === 'ended'))
        expect(events[0]).toEqual({ id, type: 'listening' })
        expect(events.filter((e) => e.type === 'partial').map((e) => (e as { text: string }).text)).toEqual(['안녕하세요', '안녕하세요 받아쓰기', '안녕하세요 받아쓰기 시험입니다'])
        expect(events.at(-2)).toEqual({ id, type: 'final', text: '안녕하세요 받아쓰기 시험입니다.' })
        expect(events.at(-1)).toEqual({ id, type: 'ended' })
        expect(calls(log)).toEqual(['status', 'listen', 'stop', 'end'])
    })

    test('one run at a time; another window cannot stop or cancel it', async () => {
        const { service, events } = harness()
        const first = service.start(7)
        expect(first.status).toBe('started')
        expect(service.start(7)).toMatchObject({ status: 'rejected', code: 'busy' })
        const id = first.status === 'started' ? first.id : -1
        service.stop(99, id)
        service.cancel(99, id)
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(events.some((e) => e.type === 'ended')).toBe(false)
        service.stop(7, id)
        await until(() => events.some((e) => e.type === 'ended'))
        // the microphone is free again
        expect(service.start(7).status).toBe('started')
        service.dispose()
    })

    test('cancel: the helper is killed and the window hears nothing more', async () => {
        const { service, events, log } = harness()
        const started = service.start(7)
        const id = started.status === 'started' ? started.id : -1
        await until(() => events.some((e) => e.type === 'partial'))
        const seen = events.length
        service.cancel(7, id)
        await until(() => calls(log).includes('killed'))
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(events.length).toBe(seen)
        expect(service.start(7).status).toBe('started')
        service.dispose()
    })

    test('the window going away ends its run', async () => {
        const { service, events, log } = harness()
        service.start(7)
        await until(() => events.some((e) => e.type === 'listening'))
        service.ownerGone(7)
        await until(() => calls(log).includes('killed'))
    })

    test('a helper error reaches the window once, then ended', async () => {
        const { service, events } = harness('mic_denied')
        service.start(7)
        await until(() => events.some((e) => e.type === 'ended'))
        expect(events.map((e) => e.type)).toEqual(['error', 'ended'])
        expect(events[0]).toMatchObject({ code: 'mic_denied' })
    })

    test('SIGABRT (macOS killed it: no usage description) → permission_setup; other exits → helper_failed', async () => {
        const aborted = harness('abort')
        aborted.service.start(7)
        await until(() => aborted.events.some((e) => e.type === 'ended'))
        expect(aborted.events[0]).toMatchObject({ type: 'error', code: 'permission_setup' })
        const crashed = harness('crash')
        crashed.service.start(7)
        await until(() => crashed.events.some((e) => e.type === 'ended'))
        expect(crashed.events[0]).toMatchObject({ type: 'error', code: 'helper_failed' })
    })

    test('not macOS, or no helper: unavailable and nothing runs', async () => {
        const windows = harness('ok', { platform: 'win32' })
        expect(await windows.service.status()).toMatchObject({ available: false, reason: 'not_mac' })
        expect(windows.service.start(7)).toMatchObject({ status: 'rejected' })
        expect(calls(windows.log)).toEqual([])
        const missing = harness('ok', { helper: '/nonexistent/climanager-dictation' })
        expect(await missing.service.status()).toMatchObject({ available: false, reason: 'no_helper' })
        const none = harness('ok', { helper: null })
        expect(await none.service.status()).toMatchObject({ available: false, reason: 'no_helper' })
    })

    test('a Mac that cannot do it on the device: unavailable', async () => {
        const { service } = harness('unsupported')
        expect(await service.status()).toMatchObject({ available: false, reason: 'unsupported' })
    })
})

test('T106 the real helper answers status without asking anything', () => {
    test.skip(process.platform !== 'darwin' || !fs.existsSync(REAL), 'helper not built (pnpm build:dictation)')
    const line = execFileSync(REAL, ['status'], { encoding: 'utf8', timeout: 5000 })
    const status = parseStatus(line)
    expect(status.reason === null || status.reason === 'unsupported').toBe(true)
    expect(['authorized', 'denied', 'restricted', 'notDetermined']).toContain(status.speech)
    expect(['authorized', 'denied', 'restricted', 'notDetermined']).toContain(status.mic)
    const archs = execFileSync('lipo', ['-archs', REAL], { encoding: 'utf8' })
    expect(archs).toContain('arm64')
    expect(archs).toContain('x86_64')
})
