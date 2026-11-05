import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { claudeSkillUsage, createChatCommandLister } from '../../src/main/chatCommands'
import { rankCommands } from '../../src/renderer/src/components/ChatView/chatLib'
import type { ChatCommand } from '../../src/shared/conversation'

/**
 * T91 — phone-fixes round 2 (11-05), without Electron.
 *
 * d50fe2b7: the `/` menu ordered skills by what was picked in this chat only (per browser), so a
 * skill run a hundred times in the terminal stayed under the alphabet. Claude keeps its own count
 * (`skillUsage` in ~/.claude.json, or in CLAUDE_CONFIG_DIR) — the lister reads it, the menu ranks by it.
 */

function claudeHome(skills: string[], usage: Record<string, unknown> | null, configDir?: string) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 't91-'))
    const config = configDir ? path.join(home, configDir) : path.join(home, '.claude')
    fs.mkdirSync(config, { recursive: true })
    for (const name of skills) {
        fs.mkdirSync(path.join(config, 'skills', name), { recursive: true })
        fs.writeFileSync(path.join(config, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n`)
    }
    const file = configDir ? path.join(config, '.claude.json') : path.join(home, '.claude.json')
    if (usage) fs.writeFileSync(file, JSON.stringify({ numStartups: 3, skillUsage: usage }))
    return { home, config }
}

test.describe('T91 Claude skill usage', () => {
    test('read from ~/.claude.json: usageCount per skill, nothing odd kept', () => {
        const { home, config } = claudeHome([], {
            'progress-report': { usageCount: 41, lastUsedAt: 1 },
            'retro-learn': { usageCount: 3 },
            'plugin:skill': { usageCount: 7 },
            broken: { usageCount: 'x' },
            zero: { usageCount: 0 },
            nothing: null
        })
        expect(claudeSkillUsage({ home, claudeConfigDir: () => config })).toEqual({ 'progress-report': 41, 'retro-learn': 3, 'plugin:skill': 7 })
    })

    test('with CLAUDE_CONFIG_DIR, the file inside it', () => {
        const { home, config } = claudeHome([], { a: { usageCount: 2 } }, 'alt-config')
        expect(claudeSkillUsage({ home, claudeConfigDir: () => config })).toEqual({ a: 2 })
    })

    test('no file, bad JSON, no skillUsage: empty', () => {
        const { home, config } = claudeHome([], null)
        expect(claudeSkillUsage({ home, claudeConfigDir: () => config })).toEqual({})
        fs.writeFileSync(path.join(home, '.claude.json'), '{ not json')
        expect(claudeSkillUsage({ home, claudeConfigDir: () => config })).toEqual({})
        fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ skillUsage: [1, 2] }))
        expect(claudeSkillUsage({ home, claudeConfigDir: () => config })).toEqual({})
    })

    test('the lister marks each Claude command with its count', () => {
        const { home, config } = claudeHome(['alpha', 'progress-report', 'zeta'], { 'progress-report': { usageCount: 41 }, zeta: { usageCount: 2 } })
        const list = createChatCommandLister({ home, claudeConfigDir: () => config, codexHome: () => path.join(home, '.codex') })('claude', undefined)
        const byName = new Map(list.map((command) => [command.name, command]))
        expect(byName.get('progress-report')?.uses).toBe(41)
        expect(byName.get('zeta')?.uses).toBe(2)
        expect(byName.get('alpha')?.uses).toBeUndefined()
    })
})

test.describe('T91 the `/` menu order', () => {
    const skill = (name: string, uses?: number): ChatCommand => ({ name, description: '', source: 'skill', ...(uses ? { uses } : {}) })
    const slash = (query: string) => ({ kind: 'slash' as const, prefix: '/' as const, query, start: 0 })

    test('an empty query: most used by Claude first, then picked here, then by name', () => {
        const commands = [skill('alpha'), skill('progress-report', 41), skill('zeta', 2), skill('beta')]
        expect(rankCommands(commands, slash(''), {}).map((c) => c.name)).toEqual(['progress-report', 'zeta', 'alpha', 'beta'])
        // picks in this chat add to it
        expect(rankCommands(commands, slash(''), { beta: 50 }).map((c) => c.name)).toEqual(['beta', 'progress-report', 'zeta', 'alpha'])
    })

    test('the match comes first: a better match beats a more used one', () => {
        const commands = [skill('report-tool'), skill('progress-report', 41)]
        expect(rankCommands(commands, slash('rep'), {}).map((c) => c.name)).toEqual(['report-tool', 'progress-report'])
    })
})
