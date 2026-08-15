import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { HookInstaller } from '../../src/main/HookInstaller'
import { CLAUDE_HOOK_SCRIPT, CLAUDE_STATUSLINE_SCRIPT, CODEX_NOTIFY_SCRIPT, withDelegate } from '../../src/main/hookScripts'

/**
 * T8 — Hook installation safety.
 *
 * This is the only code in the app that edits files the user owns and that
 * other tools also write to (`~/.claude/settings.json`, `~/.codex/config.toml`).
 * Getting it wrong silently deletes someone else's hook or leaves a dead
 * command that slows every agent turn, so the round trip is pinned here.
 *
 * Isolation: `$HOME` is redirected to a temp directory for the duration of each
 * test. HookInstaller resolves the config paths through os.homedir(), which
 * honours $HOME on POSIX, so nothing outside the temp directory is reachable.
 */

/** A settings file that already contains someone else's hook and status line. */
const EXISTING_CLAUDE_SETTINGS = {
    env: { SOME_VAR: '1' },
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
        SessionStart: [
            {
                matcher: '*',
                hooks: [{ type: 'command', command: 'node /Users/someone/.claude/scripts/other-tool.cjs', timeout: 5 }]
            }
        ]
    },
    statusLine: { type: 'command', command: '/usr/local/bin/my-hud' },
    effortLevel: 'high'
}

/** A config.toml with a pre-existing notify and tables after it. */
const EXISTING_CODEX_CONFIG = `# Codex configuration
model = "gpt-5"
notify = ["/opt/some-tool/notifier", "turn-ended"]

[tui]
theme = "dark"

[mcp_servers.example]
command = "example-server"
`

interface Fixture {
    home: string
    climanagerHome: string
    claudePath: string
    codexPath: string
    restore: () => void
}

function setupFixture(options: { withExisting: boolean }): Fixture {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-home-t8-'))
    const climanagerHome = path.join(home, '.climanager')

    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })

    const claudePath = path.join(home, '.claude', 'settings.json')
    const codexPath = path.join(home, '.codex', 'config.toml')

    if (options.withExisting) {
        fs.writeFileSync(claudePath, JSON.stringify(EXISTING_CLAUDE_SETTINGS, null, 2))
        fs.writeFileSync(codexPath, EXISTING_CODEX_CONFIG)
    } else {
        fs.writeFileSync(claudePath, '{}')
        fs.writeFileSync(codexPath, 'model = "gpt-5"\n')
    }

    const prevHome = process.env.HOME
    const prevClimanagerHome = process.env.CLIMANAGER_HOME
    process.env.HOME = home
    process.env.CLIMANAGER_HOME = climanagerHome

    return {
        home,
        climanagerHome,
        claudePath,
        codexPath,
        restore: () => {
            process.env.HOME = prevHome
            if (prevClimanagerHome === undefined) delete process.env.CLIMANAGER_HOME
            else process.env.CLIMANAGER_HOME = prevClimanagerHome
            fs.rmSync(home, { recursive: true, force: true })
        }
    }
}

const ALL_TARGETS = { enabled: true, claudeHooks: true, claudeStatusLine: true, codexNotify: true }
const LIFECYCLE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'Notification', 'SessionEnd']

test.describe('T8 hook install safety', () => {
    test('install preserves third-party entries and uninstall restores them', () => {
        const fixture = setupFixture({ withExisting: true })

        try {
            const installer = new HookInstaller()
            const state = installer.install(ALL_TARGETS)

            expect(state.claudeHooks.installed).toBe(true)
            expect(state.claudeStatusLine.installed).toBe(true)
            expect(state.codexNotify.installed).toBe(true)

            const afterInstall = JSON.parse(fs.readFileSync(fixture.claudePath, 'utf-8'))

            // The other tool's hook must still be there, alongside ours.
            const sessionStart = JSON.stringify(afterInstall.hooks.SessionStart)
            expect(sessionStart).toContain('other-tool.cjs')
            expect(sessionStart).toContain('claude-hook.sh')

            for (const event of LIFECYCLE_EVENTS) {
                expect(JSON.stringify(afterInstall.hooks[event] ?? [])).toContain('claude-hook.sh')
            }

            // Unrelated settings must survive untouched.
            expect(afterInstall.env).toEqual(EXISTING_CLAUDE_SETTINGS.env)
            expect(afterInstall.permissions).toEqual(EXISTING_CLAUDE_SETTINGS.permissions)
            expect(afterInstall.effortLevel).toBe('high')

            // The displaced status line is captured and chained to, not dropped.
            expect(afterInstall.statusLine.command).toContain('claude-statusline.sh')
            expect(state.claudeStatusLine.wrapped).toBe('/usr/local/bin/my-hud')
            expect(fs.readFileSync(installer.claudeStatusLineScriptPath, 'utf-8')).toContain('/usr/local/bin/my-hud')

            // Same for the Codex notify program.
            const codexAfter = fs.readFileSync(fixture.codexPath, 'utf-8')
            expect(codexAfter).toContain('codex-notify.sh')
            expect(state.codexNotify.wrapped).toContain('/opt/some-tool/notifier')
            expect(fs.readFileSync(installer.codexNotifyScriptPath, 'utf-8')).toContain('/opt/some-tool/notifier')

            // Only the notify line may change; comments and tables stay put.
            const originalLines = EXISTING_CODEX_CONFIG.split('\n')
            const changed = codexAfter.split('\n').filter((line, i) => line !== originalLines[i])
            expect(changed).toHaveLength(1)
            expect(changed[0]).toMatch(/^\s*notify\s*=/)

            // TOML requires root keys before the first table header.
            const lines = codexAfter.split('\n')
            const notifyIndex = lines.findIndex((l) => /^\s*notify\s*=/.test(l))
            const tableIndex = lines.findIndex((l) => /^\s*\[/.test(l))
            expect(notifyIndex).toBeGreaterThanOrEqual(0)
            expect(notifyIndex).toBeLessThan(tableIndex)

            // --- uninstall ---
            installer.uninstall()

            const afterUninstall = JSON.parse(fs.readFileSync(fixture.claudePath, 'utf-8'))
            expect(JSON.stringify(afterUninstall.hooks ?? {})).not.toContain('claude-hook.sh')
            expect(JSON.stringify(afterUninstall.hooks.SessionStart)).toContain('other-tool.cjs')
            expect(afterUninstall.statusLine.command).toBe('/usr/local/bin/my-hud')
            expect(fs.readFileSync(fixture.codexPath, 'utf-8')).toBe(EXISTING_CODEX_CONFIG)
        } finally {
            fixture.restore()
        }
    })

    test('re-installing is idempotent and never chains a script to itself', () => {
        const fixture = setupFixture({ withExisting: true })

        try {
            const installer = new HookInstaller()
            installer.install(ALL_TARGETS)
            installer.install(ALL_TARGETS)
            installer.install(ALL_TARGETS)

            const settings = JSON.parse(fs.readFileSync(fixture.claudePath, 'utf-8'))
            const occurrences = JSON.stringify(settings.hooks.SessionStart).split('claude-hook.sh').length - 1
            expect(occurrences).toBe(1)

            // Self-chaining would make the status line recurse until the shell
            // gives up, taking the user's prompt with it.
            const statusLineScript = fs.readFileSync(installer.claudeStatusLineScriptPath, 'utf-8')
            expect(statusLineScript).toContain('/usr/local/bin/my-hud')
            expect(statusLineScript).not.toContain('claude-statusline.sh')

            const notifyScript = fs.readFileSync(installer.codexNotifyScriptPath, 'utf-8')
            expect(notifyScript).not.toContain('codex-notify.sh"')

            expect(installer.verify().claudeHooks.installed).toBe(true)
        } finally {
            fixture.restore()
        }
    })

    test('works on a machine with no prior hooks configured', () => {
        const fixture = setupFixture({ withExisting: false })

        try {
            const installer = new HookInstaller()
            const state = installer.install(ALL_TARGETS)

            expect(state.claudeHooks.installed).toBe(true)
            expect(state.claudeStatusLine.wrapped).toBeUndefined()

            const settings = JSON.parse(fs.readFileSync(fixture.claudePath, 'utf-8'))
            expect(JSON.stringify(settings.hooks.Stop)).toContain('claude-hook.sh')

            installer.uninstall()
            const restored = JSON.parse(fs.readFileSync(fixture.claudePath, 'utf-8'))
            // With nothing to restore, our status line is removed rather than
            // left pointing at a script that no longer has a purpose.
            expect(restored.statusLine).toBeUndefined()
            expect(restored.hooks).toBeUndefined()
        } finally {
            fixture.restore()
        }
    })

    test('a corrupt settings.json is reported, not thrown, and other targets still install', () => {
        const fixture = setupFixture({ withExisting: true })

        try {
            fs.writeFileSync(fixture.claudePath, '{ this is not json')

            const installer = new HookInstaller()
            const state = installer.install(ALL_TARGETS)

            // Claude targets fail with a message the Settings panel can show...
            expect(state.claudeHooks.installed).toBe(false)
            expect(state.claudeHooks.error).toBeTruthy()
            expect(state.claudeStatusLine.installed).toBe(false)

            // ...while Codex, which is independent, still works. One broken
            // integration must not disable the rest.
            expect(state.codexNotify.installed).toBe(true)
            expect(fs.readFileSync(fixture.codexPath, 'utf-8')).toContain('codex-notify.sh')

            // The unparseable file is left exactly as found rather than replaced
            // with something we invented.
            expect(fs.readFileSync(fixture.claudePath, 'utf-8')).toBe('{ this is not json')
        } finally {
            fixture.restore()
        }
    })

    test('a multi-line notify array is refused rather than corrupted', () => {
        const fixture = setupFixture({ withExisting: true })

        try {
            const multiline = [
                'model = "gpt-5"',
                'notify = [',
                '  "/opt/some-tool/notifier",',
                '  "turn-ended"',
                ']',
                '',
                '[tui]',
                'theme = "dark"',
                ''
            ].join('\n')
            fs.writeFileSync(fixture.codexPath, multiline)

            const installer = new HookInstaller()
            const state = installer.install(ALL_TARGETS)

            // We only edit the single line we own. A value we cannot rewrite
            // safely is left alone and reported.
            expect(state.codexNotify.installed).toBe(false)
            expect(state.codexNotify.error).toContain('multiple lines')
            expect(fs.readFileSync(fixture.codexPath, 'utf-8')).toBe(multiline)

            // Claude is unaffected by the Codex refusal.
            expect(state.claudeHooks.installed).toBe(true)
        } finally {
            fixture.restore()
        }
    })

    test('a missing Codex config is reported without blocking Claude', () => {
        const fixture = setupFixture({ withExisting: true })

        try {
            fs.rmSync(fixture.codexPath)

            const installer = new HookInstaller()
            const state = installer.install(ALL_TARGETS)

            expect(state.codexNotify.installed).toBe(false)
            // Skipped, not failed: a machine without Codex is behaving normally
            // and must not show a warning in Settings.
            expect(state.codexNotify.skipped).toBe(true)
            expect(state.codexNotify.error).toBeUndefined()
            expect(state.codexNotify.skipReason).toContain('not installed')
            expect(state.claudeHooks.installed).toBe(true)
            // We do not create a config file for a tool the user does not have.
            expect(fs.existsSync(fixture.codexPath)).toBe(false)
        } finally {
            fixture.restore()
        }
    })

    test('only the enabled targets are installed', () => {
        const fixture = setupFixture({ withExisting: true })

        try {
            const installer = new HookInstaller()
            const state = installer.install({
                enabled: true,
                claudeHooks: true,
                claudeStatusLine: false,
                codexNotify: false
            })

            expect(state.claudeHooks.installed).toBe(true)
            expect(state.claudeStatusLine.installed).toBe(false)

            const settings = JSON.parse(fs.readFileSync(fixture.claudePath, 'utf-8'))
            // The status line the user already had must be untouched when we
            // were not asked to wrap it.
            expect(settings.statusLine.command).toBe('/usr/local/bin/my-hud')
            expect(fs.readFileSync(fixture.codexPath, 'utf-8')).not.toContain('codex-notify.sh')
        } finally {
            fixture.restore()
        }
    })

    test('verify() reports on-disk truth after an external tool overwrites our entry', () => {
        const fixture = setupFixture({ withExisting: true })

        try {
            const installer = new HookInstaller()
            installer.install(ALL_TARGETS)
            expect(installer.verify().claudeStatusLine.installed).toBe(true)

            // Simulate another tool claiming the status line after us.
            const settings = JSON.parse(fs.readFileSync(fixture.claudePath, 'utf-8'))
            settings.statusLine = { type: 'command', command: '/opt/other/hud' }
            fs.writeFileSync(fixture.claudePath, JSON.stringify(settings, null, 2))

            // verify() must read the file, not report what we believe we wrote —
            // otherwise Settings would show a working integration that is gone.
            expect(installer.verify().claudeStatusLine.installed).toBe(false)
            expect(installer.verify().claudeHooks.installed).toBe(true)
        } finally {
            fixture.restore()
        }
    })

    test('verify() reports a partial hook registration rather than calling it installed', () => {
        const fixture = setupFixture({ withExisting: true })

        try {
            const installer = new HookInstaller()
            installer.install(ALL_TARGETS)

            const settings = JSON.parse(fs.readFileSync(fixture.claudePath, 'utf-8'))
            delete settings.hooks.PermissionRequest
            delete settings.hooks.Stop
            fs.writeFileSync(fixture.claudePath, JSON.stringify(settings, null, 2))

            const state = installer.verify()
            expect(state.claudeHooks.installed).toBe(false)
            expect(state.claudeHooks.error).toContain('4/6')
        } finally {
            fixture.restore()
        }
    })

    test('the pre-CLI-Manager config is backed up once and not overwritten later', () => {
        const fixture = setupFixture({ withExisting: true })

        try {
            const installer = new HookInstaller()
            installer.install(ALL_TARGETS)

            const backup = path.join(fixture.climanagerHome, 'backups', 'claude-settings.json.original')
            expect(fs.existsSync(backup)).toBe(true)

            const original = JSON.parse(fs.readFileSync(backup, 'utf-8'))
            expect(original.statusLine.command).toBe('/usr/local/bin/my-hud')
            expect(JSON.stringify(original.hooks)).not.toContain('claude-hook.sh')

            // A second install must not replace the backup with our own output —
            // that would make the backup useless for recovery.
            installer.install(ALL_TARGETS)
            const stillOriginal = JSON.parse(fs.readFileSync(backup, 'utf-8'))
            expect(JSON.stringify(stillOriginal.hooks)).not.toContain('claude-hook.sh')
        } finally {
            fixture.restore()
        }
    })

    test('a delegate path containing spaces and quotes survives shell execution', () => {
        const fixture = setupFixture({ withExisting: true })
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "climanger-odd name-"))

        try {
            // Real example: the Codex notifier ships inside an .app bundle whose
            // path contains spaces. Naive quoting breaks it silently.
            const odd = path.join(dir, "it's a notifier.sh")
            fs.writeFileSync(odd, ['#!/bin/sh', 'printf "DELEGATE-RAN"', ''].join('\n'))
            fs.chmodSync(odd, 0o755)

            fs.writeFileSync(fixture.codexPath, `notify = ${JSON.stringify([odd, 'turn-ended'])}

[tui]
theme = "dark"
`)

            const installer = new HookInstaller()
            const state = installer.install(ALL_TARGETS)
            expect(state.codexNotify.installed).toBe(true)

            const output = execFileSync('/bin/sh', [installer.codexNotifyScriptPath, '{"type":"agent-turn-complete"}'], {
                env: { ...process.env, CLIMANAGER_SPOOL: path.join(fixture.climanagerHome, 'events') }
            }).toString()

            expect(output).toContain('DELEGATE-RAN')
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
            fixture.restore()
        }
    })

    test('bridge scripts capture payloads and still run the command they replaced', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-scripts-'))
        const spool = path.join(dir, 'events')

        try {
            const write = (name: string, body: string): string => {
                const file = path.join(dir, name)
                fs.writeFileSync(file, body)
                fs.chmodSync(file, 0o755)
                return file
            }

            const original = write('original.sh', '#!/bin/sh\nread ignored\nprintf "ORIGINAL-OUTPUT"\n')
            const hook = write('hook.sh', CLAUDE_HOOK_SCRIPT)
            const statusLine = write('statusline.sh', withDelegate(CLAUDE_STATUSLINE_SCRIPT, `"${original}"`, 'stdin', true))
            const notify = write('notify.sh', withDelegate(CODEX_NOTIFY_SCRIPT, undefined, 'argv'))

            const env = { ...process.env, CLIMANAGER_SPOOL: spool }

            execFileSync(hook, {
                input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/repo' }),
                env
            })

            // The wrapper must return the original command's output verbatim,
            // otherwise enabling usage tracking would blank the user's HUD.
            const output = execFileSync(statusLine, {
                input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10 } } }),
                env
            }).toString()
            expect(output).toContain('ORIGINAL-OUTPUT')

            // Codex passes its payload as argv, not stdin.
            execFileSync(notify, [JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 't-1' })], { env })

            const files = fs.readdirSync(spool)
            expect(files).toHaveLength(3)

            const payloads = files.map((f) => JSON.parse(fs.readFileSync(path.join(spool, f), 'utf-8')))
            const sources = payloads.map((p) => p.climanager.source).sort()
            expect(sources).toEqual(['claude-hook', 'claude-statusline', 'codex-notify'])

            const hookPayload = payloads.find((p) => p.climanager.source === 'claude-hook')
            expect(hookPayload.payload).toMatchObject({ hook_event_name: 'Stop', session_id: 'sess-1' })
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('a hook script still exits 0 when the spool cannot be written', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-readonly-'))

        try {
            const hook = path.join(dir, 'hook.sh')
            fs.writeFileSync(hook, CLAUDE_HOOK_SCRIPT)
            fs.chmodSync(hook, 0o755)

            // Point the spool at a path that cannot be created. A failure here
            // must never surface to the agent session.
            const blocked = path.join(dir, 'blocker')
            fs.writeFileSync(blocked, 'not a directory')

            const result = execFileSync(hook, {
                input: '{"hook_event_name":"Stop"}',
                env: { ...process.env, CLIMANAGER_SPOOL: path.join(blocked, 'events') }
            })

            // execFileSync throws on a non-zero exit, so reaching here is the assertion.
            expect(result.toString()).toBe('')
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
