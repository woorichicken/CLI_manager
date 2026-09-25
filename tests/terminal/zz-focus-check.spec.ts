// SCRATCH — API 가 화면을 바꿀 때 키보드 포커스까지 가져가나
import { test, expect } from '@playwright/test'
import fs from 'fs'; import os from 'os'; import path from 'path'
import { launchAppWithWorkspaces, closeApp } from './helpers'

test('does an API-driven view switch steal the keyboard?', async () => {
    test.setTimeout(120_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-home-'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-ws-'))
    const ctx = await launchAppWithWorkspaces(
        [{ id: 'ws', name: 'FOCUSWS', path: dir, sessions: [{ id: 's-user', name: 'USERSESS' }] }],
        { settings: { controlApi: { enabled: true, port: 0 } }, env: { CLIMANAGER_HOME: home } }
    )
    await expect.poll(() => fs.existsSync(path.join(home, 'control-api.json')), { timeout: 15_000 }).toBe(true)
    const d = JSON.parse(fs.readFileSync(path.join(home, 'control-api.json'), 'utf-8'))
    const api = async (m: string, r: string, b?: unknown) => {
        const res = await fetch(d.url + r, { method: m, headers: { Authorization: 'Bearer ' + d.token, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
        return JSON.parse((await res.text()) || 'null')
    }
    // 사용자가 자기 세션을 보고 있고, 거기에 타이핑 중인 상태를 만든다
    const focused = () => ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.xterm.focus'))
            .map(el => el.closest('[data-session-id]')?.getAttribute('data-session-id') ?? '?')
            .join(',') || 'none')
    await ctx.page.locator('[data-session-item="s-user"]').click()
    await ctx.page.waitForTimeout(500)
    // 사용자가 그 터미널에 실제로 타이핑하는 상태를 만든다
    await ctx.page.locator('[data-session-id="s-user"] .xterm-helper-textarea').focus()
    await ctx.page.keyboard.type('echo hi')
    await ctx.page.waitForTimeout(500)
    const before = await focused()

    // AI 가 세션을 연다 — ① focus 없이
    const quiet = await api('POST', '/v1/sessions', { path: dir, command: 'echo quiet', name: 'AI-QUIET' })
    await ctx.page.waitForTimeout(1500)
    const afterQuiet = await focused()

    // ② focus: true 로
    const loud = await api('POST', '/v1/sessions', { path: dir, command: 'echo loud', name: 'AI-FOCUS', focus: true })
    await ctx.page.waitForTimeout(1500)
    const afterFocus = await focused()
    const typedWhere = await ctx.page.evaluate(() => {
        const d = (window as any).__termDebug
        return 'n/a'
    })

    console.log(JSON.stringify({
        사용자세션: 's-user',
        조용히연세션: quiet.session.id.slice(0, 8),
        focus로연세션: loud.session.id.slice(0, 8),
        '타이핑중_포커스': before.slice(0, 8),
        'focus없이_열었을때': afterQuiet.slice(0, 8),
        'focus로_열었을때': afterFocus.slice(0, 8),
        '설명': '값이 사용자 세션 id 면 포커스 유지, AI 세션 id 면 빼앗김'
    }, null, 1))
    await closeApp(ctx)
})
