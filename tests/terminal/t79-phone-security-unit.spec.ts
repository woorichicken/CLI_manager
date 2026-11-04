import { test, expect } from '@playwright/test'
import { execFileSync, spawnSync } from 'child_process'
import { EventEmitter } from 'events'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { PhoneDevices } from '../../src/main/phone/PhoneDevices'
import { PhonePush } from '../../src/main/phone/PhonePush'
import { PhoneServer } from '../../src/main/phone/PhoneServer'
import { maskSnapshot } from '../../src/main/phone/phoneApi'
import { maskSecretLines } from '../../src/main/maskSecrets'
import { readPrompt } from '../../src/main/promptScreen'
import { createChatCommandLister } from '../../src/main/chatCommands'
import type { ConversationSnapshot } from '../../src/shared/conversation'

/**
 * T79 — the phone server's security and resource fixes (Codex cross review F01·F02·F05·F06·F07·F08·F21·F22·F23),
 * without Electron. Each block reproduces its finding against the old code first: a revoked device must not type
 * (socket or a request still sending its body), a revoke must reach the disk or say it did not, the 51st pairing
 * revokes the oldest, a special SKILL.md cannot stall main, a push that never answers ends, a question card's
 * signature carries no masked secret, Codex `$` finds every skill folder ovis does, and sw.js is in Git.
 */

const ROOT = path.resolve(__dirname, '../..')
const tmp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `t79-${name}-`))

/** A real PhoneServer on 127.0.0.1:0 with fake terminals and Chat, a real device list. */
async function startServer(): Promise<{
    server: PhoneServer
    devices: PhoneDevices
    port: number
    typed: string[]
    sent: string[]
    subscribed: string[]
    stop: () => Promise<void>
}> {
    const dir = tmp('server')
    const devices = new PhoneDevices(path.join(dir, 'devices.json'))
    const typed: string[] = []
    const sent: string[] = []
    const subscribed: string[] = []
    const events = new EventEmitter()
    const push = {
        forgetOwner: () => undefined,
        publicKey: () => 'key',
        count: () => subscribed.length,
        onStatus: () => undefined,
        subscribe: (_s: unknown, owner: string) => {
            subscribed.push(owner)
            return true
        },
        unsubscribe: () => undefined,
        test: async () => ({ status: 'none' })
    }
    const server = new PhoneServer({
        devices,
        push: push as never,
        tailscale: { read: async () => ({ found: false, owner: null, dnsName: null }), peek: () => null } as never,
        staticDir: dir,
        onStateChange: () => undefined,
        statusPoller: { start: () => undefined, stop: () => undefined },
        listSessions: () => ({ sessions: [] }) as never,
        sessionExists: (id: string) => id === 'S1',
        conversation: {
            send: async (_id: string, text: string) => {
                sent.push(text)
                return { status: 'sent' }
            }
        } as never,
        saveAttachment: () => ({ status: 'attached', path: '/tmp/x' }) as never,
        maskLine: (text: string) => text,
        recordPhoneInput: () => undefined,
        terminals: {
            attachRemote: async () => ({ snapshot: '', cols: 80, rows: 24, detach: () => undefined }),
            writeInput: (_id: string, data: string) => {
                typed.push(data)
                return true
            },
            events: events as never
        },
        subscribeConversation: () => () => undefined
    })
    const state = await server.apply({ enabled: true, port: 0 } as never)
    expect(state.running).toBe(true)
    return { server, devices, port: state.port!, typed, sent, subscribed, stop: () => server.stop() }
}

/** Pairs a `drive` device and returns its cookie. */
function pairDevice(devices: PhoneDevices): { cookie: string; id: string } {
    const { code } = devices.startPairing('drive')
    const result = devices.pair(code, 'Phone')
    if ('error' in result) throw new Error(result.error)
    return { cookie: `climanager_phone=${result.token}`, id: result.device.id }
}

const until = async (check: () => boolean, ms = 3000): Promise<boolean> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
        if (check()) return true
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return check()
}

test.describe('T79 F06 the alert worker is in Git', () => {
    // .gitignore's `*.js` (build output) hid public/phone/sw.js: a clean checkout built a phone page whose
    // /sw.js was a 404, so alerts never registered. The check reads the commit, not the working folder.
    test('src/renderer/public/phone/sw.js is tracked and not ignored', () => {
        const file = 'src/renderer/public/phone/sw.js'
        const ignored = spawnSync('git', ['check-ignore', '-q', file], { cwd: ROOT })
        expect(ignored.status, `${file} is ignored by .gitignore`).toBe(1)
        const tracked = spawnSync('git', ['ls-files', '--error-unmatch', file], { cwd: ROOT })
        expect(tracked.status, `${file} is not in Git`).toBe(0)
        const inHead = spawnSync('git', ['cat-file', '-e', `HEAD:${file}`], { cwd: ROOT })
        expect(inHead.status, `${file} is not in HEAD`).toBe(0)
    })
})
