import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { REPO_ROOT } from './helpers'

/**
 * T11 — The integration driven the way a user drives it.
 *
 * Everything below is reachable only through the real UI: click the toggle in
 * Settings, let the app write the config itself, then fire the script it
 * installed. The module-level suites (T7-T9) cover the same code paths in
 * isolation and all passed while this flow was destroying the user's Codex
 * `notify` entry — the enable path calls uninstall() first, and uninstall did
 * not check ownership before deleting. Nothing short of clicking the button
 * exercised that sequence.
 *
 * Isolation needs two mechanisms because they cover different things: Electron
 * resolves `userData` from the OS (CLIMANGER_TEST_USERDATA), while
 * HookInstaller resolves `~/.claude` through os.homedir() (`$HOME`).
 * CLIMANAGER_ALLOW_HOOK_INSTALL re-enables the install path that the test
 * guards would otherwise block.
 */
test('enabling and disabling the integration through the UI leaves config as found', async () => {
    // Faking $HOME isolates everything at once on macOS: Electron derives
    // userData from it, and HookInstaller resolves ~/.claude and ~/.codex
    // through os.homedir(). The real config is untouchable from here.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handson-home-'))
    // Electron resolves userData from the OS rather than $HOME, so app storage
    // needs its own env var; $HOME only isolates os.homedir() (~/.claude etc).
    const userData = path.join(home, 'userData')
    fs.mkdirSync(userData, { recursive: true })
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })

    // Pre-existing third-party entries, exactly like the real machine has.
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
        statusLine: { type: 'command', command: '/usr/local/bin/my-hud' },
        hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node /other/tool.cjs' }] }] }
    }, null, 2))
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
        'model = "gpt-5"\nnotify = ["/opt/other/notifier", "turn-ended"]\n\n[tui]\ntheme = "dark"\n')

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'handson-repo-'))
    const git = (a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' })
    git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 't@e.com']); git(['config', 'user.name', 'T'])
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1\n')
    git(['add', '.']); git(['commit', '-q', '-m', 'base'])

    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
        workspaces: [{
            id: 'ws1', name: 'demo-app', path: repo,
            sessions: [
                { id: 's1', name: 'Frontend', cwd: repo, type: 'regular',
                  cliSessionId: 'sess-hands-on', cliToolName: 'claude' },
                { id: 's2', name: 'Backend', cwd: repo, type: 'regular' }
            ],
            createdAt: 1700000000000
        }],
        playgroundPath: userData, customTemplates: [],
        settings: { theme: 'dark', fontSize: 14, defaultShell: 'zsh', defaultEditor: 'vscode',
            hasCompletedOnboarding: true, portFilter: { enabled: false, minPort: 3000, maxPort: 9000 },
            hooks: { enabled: true, claudeCode: { enabled: true, detectRunning: true, detectReady: true,
                     detectError: false, showInSidebar: true, autoDismissSeconds: 5 } } }
    }))

    const app = await electron.launch({
        args: [path.join(REPO_ROOT, 'out/main/index.js')],
        env: {
            ...process.env,
            HOME: home,
            CLIMANGER_TEST_USERDATA: userData,
            CLIMANAGER_ALLOW_HOOK_INSTALL: '1',
            CLIMANGER_TEST_HEADLESS: '1'
        } as Record<string, string>
    })
    const page = await app.firstWindow()
    await page.getByText('demo-app').first().waitFor({ timeout: 30_000 })
    await page.setViewportSize({ width: 1500, height: 950 })

    console.log('\n=== STEP 1: Settings > Agents 열기 ===')
    await page.locator('button[title="Settings"]').click()
    await page.waitForTimeout(1000)
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: '/tmp/ho-1-before.png' })

    console.log('=== STEP 2: 통합 켜기 (실제 파일 수정됨) ===')
    const toggles = page.locator('button.relative.w-11.h-6')
    await toggles.first().click()
    await page.waitForTimeout(2500)
    await page.screenshot({ path: '/tmp/ho-2-enabled.png' })

    const settingsJson = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'))
    const codexToml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8')
    console.log('  기존 남의 훅 보존:', JSON.stringify(settingsJson.hooks.SessionStart).includes('other/tool.cjs'))
    console.log('  우리 훅 등록    :', JSON.stringify(settingsJson.hooks).includes('claude-hook.sh'))
    console.log('  statusLine 래핑 :', String(settingsJson.statusLine.command).includes('claude-statusline.sh'))
    console.log('  codex notify    :', codexToml.includes('codex-notify.sh'))

    expect(JSON.stringify(settingsJson.hooks.SessionStart)).toContain('other/tool.cjs')
    expect(JSON.stringify(settingsJson.hooks)).toContain('claude-hook.sh')

    console.log('=== STEP 3: 설치된 훅 스크립트를 실제로 실행 (Claude Code가 하는 것과 동일) ===')
    const hookScript = path.join(home, '.climanager', 'hooks', 'claude-hook.sh')
    console.log('  스크립트 존재:', fs.existsSync(hookScript))
    const hookEnv = { ...process.env, HOME: home } as Record<string, string>
    execFileSync(hookScript, {
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-hands-on', cwd: repo }),
        env: hookEnv
    })
    await page.waitForTimeout(1800)

    execFileSync(hookScript, {
        input: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'sess-hands-on', cwd: repo, tool_name: 'Bash' }),
        env: hookEnv
    })
    await page.waitForTimeout(1800)

    // Close settings so the sidebar dot is visible.
    await page.locator('button:has-text("Cancel")').first().click().catch(() => {})
    await page.waitForTimeout(800)
    await page.screenshot({ path: '/tmp/ho-3-awaiting.png' })

    const status = await page.evaluate(async () =>
        (await (window as any).api.getAgentStatusSnapshot()).find((s: any) => s.terminalId === 's1'))
    console.log('  세션 상태:', JSON.stringify(status))
    expect(status.source).toBe('hook')
    expect(status.awaitingInput).toBe(true)

    console.log('=== STEP 4: 통합 끄기 → 원래 설정 복구 확인 ===')
    await page.locator('button[title="Settings"]').click()
    await page.waitForTimeout(900)
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.waitForTimeout(500)
    await toggles.first().click()
    await page.waitForTimeout(2000)

    const restored = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'))
    const codexRestored = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8')
    console.log('  statusLine 복구 :', restored.statusLine?.command)
    console.log('  남의 훅 살아있음:', JSON.stringify(restored.hooks?.SessionStart ?? []).includes('other/tool.cjs'))
    console.log('  codex notify 복구:', codexRestored.includes('/opt/other/notifier'))
    expect(restored.statusLine.command).toBe('/usr/local/bin/my-hud')
    expect(codexRestored).toContain('/opt/other/notifier')

    console.log('=== STEP 5: 새 포트 모니터 토글 ===')
    await page.getByRole('button', { name: 'Port Monitoring', exact: true }).click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: '/tmp/ho-4-port.png' })

    await app.close()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
})
