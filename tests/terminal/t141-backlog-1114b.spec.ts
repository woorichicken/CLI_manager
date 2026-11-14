import { test, expect } from '@playwright/test'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ControlApiServer } from '../../src/main/ControlApiServer'
import type { ControlApiService } from '../../src/main/ControlApiService'
import { DEFAULT_CONTROL_API } from '../../src/shared/types'
import { closeApp, REPO_ROOT, type LaunchResult } from './helpers'

/**
 * T141 — small defects from docs/backlog.md (fb-1114b), Electron-free.
 *
 *  1. Control API: a broken %-escape in a path piece answered 500 `internal` → 400 `bad_path`
 *  2. phone page: Chrome offered «Translate this page?» on every load → `notranslate`
 *  3. closeApp: a close that hangs left the test app running → its process is killed
 */

function fakeStore() {
    const data: Record<string, unknown> = {}
    return { get: (key: string) => data[key], set: (key: string, value: unknown) => void (data[key] = value) }
}

test('Control API: a broken %-escape in the path is 400 bad_path, not 500', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 't141-'))
    const stand = { clearOrchestrators: () => {}, noteCaller: () => {} } as unknown as ControlApiService
    const server = new ControlApiServer({ service: stand, store: fakeStore(), appVersion: 't141', homeDir: home })
    try {
        const state = await server.apply({ ...DEFAULT_CONTROL_API, enabled: true, port: 0 })
        expect(state.running, state.error).toBe(true)
        for (const route of ['/v1/sessions/%E0%A4%A', '/v1/sessions/%', '/v1/sessions/%ZZ/relations']) {
            const res = await fetch(state.url + route, { headers: { Authorization: `Bearer ${state.token}` } })
            const body = (await res.json()) as { error: { code: string } }
            expect(res.status, route).toBe(400)
            expect(body.error.code, route).toBe('bad_path')
        }
        // the token check still comes first
        expect((await fetch(state.url + '/v1/sessions/%E0%A4%A')).status).toBe(401)
    } finally {
        await server.apply({ ...DEFAULT_CONTROL_API, enabled: false })
        fs.rmSync(home, { recursive: true, force: true })
    }
})

test('phone page: asks Chrome not to offer a translation', () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'src/renderer/phone.html'), 'utf8')
    expect(html).toMatch(/<meta name="google" content="notranslate"\s*\/?>/)
})

test('closeApp: an app that does not quit is killed, and its folder still goes', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise((resolve) => child.once('spawn', resolve))
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't141-close-'))
    const hanging = { app: { close: () => new Promise<void>(() => {}), process: () => child }, userDataDir } as unknown as LaunchResult
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)))
    const started = Date.now()
    await closeApp(hanging, 500)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await exited).toBe('SIGKILL')
    expect(fs.existsSync(userDataDir)).toBe(false)
})

test('closeApp: an app that quits is not killed', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: 'ignore' })
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't141-close-'))
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)))
    const quits = { app: { close: () => exited.then(() => undefined), process: () => child }, userDataDir } as unknown as LaunchResult
    await closeApp(quits, 5_000)
    expect(await exited).toBeNull()
})
