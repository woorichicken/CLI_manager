import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { gunzipSync } from 'zlib'
import { TerminalMirror } from '../../src/main/TerminalMirror'
import { TranscriptReader } from '../../src/main/TranscriptReader'
import { ConversationService, type ConversationServiceDeps } from '../../src/main/ConversationService'
import { send } from '../../src/main/phone/PhoneServer'

/**
 * T119 — the phone's «Reading the conversation…» (fb-1110 91e1b27e · 1e556f10), measured first in T118:
 *
 * 1. A phone asks for the conversation before its socket subscribes. The service dropped what it had read
 *    at once, so the subscription began a new watch: the transcript read from the start again and a
 *    «changed» sent for nothing — the phone fetched the whole conversation a second time on every open.
 *    What was read is kept a while (IDLE_KEEP_MS); a change between the read and the subscription is
 *    still announced.
 * 2. The conversation goes gzipped to a page that takes it (822 KB → ~150 KB on a 16 MB transcript).
 */

const CONVERSATION = '00000000-0000-4000-8000-0000000c1190'
const CWD = '/t119/project'

function fakeTerminals() {
    const events = new EventEmitter()
    return { events, getSize: () => ({ cols: 100, rows: 30 }), hasTerminal: () => true }
}

async function restingClaude(): Promise<TerminalMirror> {
    const terminals = fakeTerminals()
    const mirror = new TerminalMirror(terminals as never)
    terminals.events.emit('created', 's1', 100, 30)
    const rule = '─'.repeat(98)
    terminals.events.emit('output', 's1', ['⏺ Done.', '', rule, '❯ ', rule].join('\r\n'))
    await mirror.flush('s1')
    return mirror
}

function transcriptAt(home: string): string {
    const folder = path.join(home, 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'))
    fs.mkdirSync(folder, { recursive: true })
    return path.join(folder, `${CONVERSATION}.jsonl`)
}

let counter = 0
let last: string | null = null
/** a person's question and the answer, on the branch after the turn before */
function turn(question: string, answer: string): string {
    const user = { type: 'user', uuid: `u-${++counter}`, parentUuid: last, timestamp: new Date(Date.UTC(2026, 10, 10, 0, 0, counter)).toISOString(), message: { role: 'user', content: question } }
    const assistant = {
        type: 'assistant',
        uuid: `a-${++counter}`,
        parentUuid: user.uuid,
        timestamp: new Date(Date.UTC(2026, 10, 10, 0, 0, counter)).toISOString(),
        message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    }
    last = assistant.uuid
    return `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`
}

async function service(idleKeepMs?: number): Promise<{ service: ConversationService; changes: number[]; forgets: () => number; file: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t119-'))
    const file = transcriptAt(home)
    last = null
    fs.writeFileSync(file, turn('first question', 'first answer'))
    const reader = new TranscriptReader({ claudeConfigDir: () => home, codexHome: () => path.join(home, 'codex') })
    let forgets = 0
    const forget = reader.forget.bind(reader)
    reader.forget = (key: string) => (forgets++, forget(key))
    const changes: number[] = []
    const deps: ConversationServiceDeps = {
        session: () => ({ cwd: CWD, cliSessionId: CONVERSATION, cliToolName: 'claude' }),
        reader,
        mirror: await restingClaude(),
        hasTerminal: () => true,
        writeInput: () => undefined,
        type: async () => true,
        onChange: (_id, revision) => changes.push(revision),
        ...(idleKeepMs !== undefined ? { idleKeepMs } : {})
    }
    return { service: new ConversationService(deps), changes, forgets: () => forgets, file }
}

/** three poll rounds (POLL_MS 700) */
const POLLS_MS = 2300

test.describe('T119 a phone opening a chat reads it once', () => {
    test('the read before the subscription is kept: no second read, no «changed» for nothing', async () => {
        const { service: chat, changes, forgets } = await service()
        const snapshot = await chat.getConversation('s1')
        expect(snapshot.turns.map((t) => t.role)).toEqual(['user', 'assistant'])
        chat.subscribe('s1')
        await new Promise((resolve) => setTimeout(resolve, POLLS_MS))
        expect(changes, 'nothing changed since the read the phone has').toEqual([])
        expect(forgets(), 'the transcript was not read from the start again').toBe(0)
        chat.unsubscribe('s1')
    })

    test('a change between the read and the subscription is still announced, once', async () => {
        const { service: chat, changes, file } = await service()
        const before = await chat.getConversation('s1')
        fs.appendFileSync(file, turn('second question', 'second answer'))
        chat.subscribe('s1')
        await new Promise((resolve) => setTimeout(resolve, POLLS_MS))
        expect(changes.length).toBe(1)
        expect(changes[0]).toBeGreaterThan(before.revision)
        const after = await chat.getConversation('s1')
        expect(after.turns.length).toBe(4)
        chat.unsubscribe('s1')
    })

    test('nobody comes back: what was read is let go after the wait', async () => {
        const { service: chat, forgets } = await service(80)
        await chat.getConversation('s1')
        expect(forgets()).toBe(0)
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(forgets()).toBe(1)
    })
})

test.describe('T119 the conversation goes gzipped', () => {
    async function ask(body: unknown, acceptEncoding?: string): Promise<{ encoding: string | undefined; vary: string | undefined; raw: Buffer }> {
        const server = http.createServer((_req, res) => send(res, 200, body))
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const port = (server.address() as { port: number }).port
        try {
            return await new Promise((resolve, reject) => {
                http.get({ host: '127.0.0.1', port, path: '/', headers: acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : {} }, (res) => {
                    const chunks: Buffer[] = []
                    res.on('data', (chunk: Buffer) => chunks.push(chunk))
                    res.on('end', () => resolve({ encoding: res.headers['content-encoding'], vary: res.headers.vary as string | undefined, raw: Buffer.concat(chunks) }))
                }).on('error', reject)
            })
        } finally {
            server.close()
        }
    }
    const big = { turns: Array.from({ length: 400 }, (_, index) => ({ role: 'assistant', text: `answer ${index} — 정리하면 위와 같습니다. `.repeat(4) })) }

    test('a large body to a page that takes gzip: gzipped, smaller, the same JSON', async () => {
        const plain = Buffer.from(JSON.stringify(big))
        const reply = await ask(big, 'gzip, deflate, br')
        expect(reply.encoding).toBe('gzip')
        expect(reply.vary).toBe('Accept-Encoding')
        expect(reply.raw.length).toBeLessThan(plain.length / 4)
        expect(JSON.parse(gunzipSync(reply.raw).toString('utf8'))).toEqual(big)
    })

    test('no gzip asked, or a small body: plain JSON as before', async () => {
        const unasked = await ask(big)
        expect(unasked.encoding).toBeUndefined()
        expect(JSON.parse(unasked.raw.toString('utf8'))).toEqual(big)
        const small = await ask({ ok: true }, 'gzip')
        expect(small.encoding).toBeUndefined()
        expect(JSON.parse(small.raw.toString('utf8'))).toEqual({ ok: true })
    })
})
