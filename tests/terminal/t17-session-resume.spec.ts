import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, termText, LaunchResult } from './helpers'
import { resumeCommandFor } from '../../src/renderer/src/utils/resumeCommand'

/**
 * Startup drops any session id whose Claude transcript is gone, so a seeded id
 * only survives if the matching file exists. CLAUDE_CONFIG_DIR points that scan
 * at a temp directory instead of the real ~/.claude.
 */
function seedClaudeTranscript(sessionId: string): string {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t17-claude-'))
    const projectDir = path.join(configDir, 'projects', 'seeded-project')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '{"type":"seed"}\n')
    return configDir
}

/** An actual alias and agent-named local executable exercise the production command policy. */
function shellEnvironment(dir: string): { env: Record<string, string>; argsFile: string } {
    const home = path.join(dir, 'home')
    const bin = path.join(dir, 'bin')
    const argsFile = path.join(dir, 'resume-args.jsonl')
    fs.mkdirSync(home)
    fs.mkdirSync(bin)
    const executable = path.join(bin, 'claude')
    const quotedLog = `'${argsFile.replace(/'/g, `'\\''`)}'`
    fs.writeFileSync(executable, `#!/bin/sh\nprintf 'T17-CLDY %s\\n' "$*"\nprintf '%s\\n' "$*" >> ${quotedLog}\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(home, '.zshrc'), `export PATH='${bin}':"$PATH"\nalias cldy='${executable} --dangerously-skip-permissions'\nPROMPT='T17> '\nunset HISTFILE\n`)
    return {
        env: { HOME: home, ZDOTDIR: home, CODEX_HOME: path.join(dir, 'codex'), CLIMANAGER_HOME: path.join(dir, 'manager'), PATH: `${bin}:${process.env.PATH ?? ''}` },
        argsFile
    }
}

test('T17 read-only restart policy never replays prompts or damages uncertain stored options', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    const cases: Array<{ agent: 'claude' | 'codex'; command: string; expected: string }> = [
        { agent: 'codex', command: 'codex -m gpt-5 "DO_NOT_REPLAY"', expected: `codex -m gpt-5 resume ${id}` },
        { agent: 'codex', command: 'codex --remote https://remote.example --remote-auth-token-env TOKEN --local-provider ollama', expected: `codex --remote https://remote.example --remote-auth-token-env TOKEN --local-provider ollama resume ${id}` },
        { agent: 'claude', command: 'claude --fallback-model sonnet --dangerously-skip-permissions', expected: `claude --fallback-model sonnet --dangerously-skip-permissions --resume ${id}` },
        { agent: 'claude', command: 'claude --future-option value --dangerously-skip-permissions', expected: `claude --resume ${id}` },
        { agent: 'claude', command: 'claude -p "DO_NOT_REPLAY"', expected: `claude --resume ${id}` }
    ]
    for (const { agent, command, expected } of cases) {
        const stored = { cliSessionId: id, cliToolName: agent, cliCommand: command }
        expect(resumeCommandFor(stored)).toBe(expected)
        expect(stored.cliCommand).toBe(command)
    }
    expect(resumeCommandFor({ cliSessionId: id, cliToolName: 'claude', cliCommand: 'cldy --model opus' }, name => name === 'cldy' ? 'claude --dangerously-skip-permissions' : undefined)).toBe(`cldy --model opus --resume ${id}`)
    expect(resumeCommandFor({ cliSessionId: 'invalid; echo injected', cliToolName: 'codex', cliCommand: 'codex' })).toBeUndefined()
})

/**
 * T17 — a restart resumes the conversation, with the command that started it.
 *
 * The app injects `--session-id` when an agent starts so the next launch can
 * `--resume` the same conversation. Two things had to hold and only one did:
 * the id has to be captured (T9 covers that), and the resume has to repeat the
 * *original* command. Rebuilding it as `claude --resume …` drops whatever an
 * alias carried — `cldy` is `claude --dangerously-skip-permissions`, so the
 * resumed session would start asking for approvals the user had opted out of.
 *
 * An agent-named stand-in records the actual arguments, under an isolated
 * HOME and alias table. No real Claude process is started.
 */
test.describe('T17 session resume', () => {
    let ctx: LaunchResult
    const temps: string[] = []
    const tempDir = (): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t17-'))
        temps.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('a tracked session resumes with its own command, not a rebuilt one', async () => {
        const dir = tempDir()
        const sessionId = '11111111-2222-3333-4444-555555555555'
        const claudeConfigDir = seedClaudeTranscript(sessionId)
        temps.push(claudeConfigDir)
        const { env, argsFile } = shellEnvironment(dir)
        const originalCommand = 'cldy --model opus'

        ctx = await launchAppWithWorkspaces([{
            id: 'ws', name: 'T17WS', path: dir,
            sessions: [{
                id: 's-resume',
                name: 'T17RESUME',
                // What a template session looks like after the app tracked it.
                initialCommand: 'echo T17-FRESH-START',
                cliSessionId: sessionId,
                cliToolName: 'claude',
                cliCommand: originalCommand
            }]
        }], { env: { ...env, CLAUDE_CONFIG_DIR: claudeConfigDir } })

        await ctx.page.locator('[data-session-item="s-resume"]').click()
        await expect
            .poll(() => termText(ctx.page, 's-resume'), { timeout: 20_000 })
            .toContain(`T17-CLDY --dangerously-skip-permissions --model opus --resume ${sessionId}`)

        expect(fs.readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([`--dangerously-skip-permissions --model opus --resume ${sessionId}`])
        const saved = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'config.json'), 'utf8')).workspaces.find((w: any) => w.id === 'ws').sessions.find((s: any) => s.id === 's-resume')
        expect(saved.cliCommand).toBe(originalCommand)

        const text = await termText(ctx.page, 's-resume')
        expect(text, 'a resumed session must not re-run its start command').not.toContain('T17-FRESH-START')
    })

    test('an untracked session just runs its start command', async () => {
        const dir = tempDir()
        const { env } = shellEnvironment(dir)
        ctx = await launchAppWithWorkspaces([{
            id: 'ws', name: 'T17WS2', path: dir,
            sessions: [{ id: 's-fresh', name: 'T17FRESH', initialCommand: 'echo T17-NO-SESSION-ID' }]
        }], { env: { ...env, CLAUDE_CONFIG_DIR: path.join(dir, 'claude') } })

        await ctx.page.locator('[data-session-item="s-fresh"]').click()
        await expect
            .poll(() => termText(ctx.page, 's-fresh'), { timeout: 20_000 })
            .toContain('T17-NO-SESSION-ID')
    })
})
