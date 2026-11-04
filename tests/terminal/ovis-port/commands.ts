// Ported from ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// ovis tests: server/skills/claude.test.ts (31 cases) and server/skills/codex.test.ts (27 cases).
// Ours under test: src/main/chatCommands.ts (createChatCommandLister). Not ported: cases that call ovis-only
// pieces (paneCommands ids/origins/visibility, skillOverrides, synced skills, comparableName, plugin manifests,
// Codex config.toml, version-gated prompts, worktree fallback, walk budget spy) — see parts/G.md.
// server/skill-invocations/codex.test.ts tests parseCodexTranscript, not the command lister.
import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createChatCommandLister } from '../../../src/main/chatCommands'
import type { ChatCommand } from '../../../src/shared/conversation'

const roots: string[] = []
test.afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

/** Everything lives under a fresh temp home; the lister gets that home, never the real ~/.claude. */
function fixture() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-cmds-'))
    roots.push(home)
    const repo = path.join(home, 'repo')
    const cwd = path.join(repo, 'app')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(cwd)
    return { home, repo, cwd }
}
function put(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
}
function skill(root: string, name: string, fields = '', body = 'Probe skill'): void {
    put(path.join(root, name, 'SKILL.md'), `---\n${fields}\n---\n${body}\n`)
}
function codexSkill(root: string, name: string): string {
    const file = path.join(root, name, 'SKILL.md')
    put(file, `---\nname: ${name}\ndescription: First sentence. Second sentence.\n---\nBody\n`)
    return file
}
function lister(home: string, claudeConfig = path.join(home, '.claude'), codexHome = path.join(home, '.codex')) {
    return createChatCommandLister({ home, claudeConfigDir: () => claudeConfig, codexHome: () => codexHome })
}
const claudeRows = (home: string, cwd: string | undefined, config?: string): ChatCommand[] => lister(home, config)('claude', cwd)
const claudeFound = (home: string, cwd: string): ChatCommand[] => claudeRows(home, cwd).filter((row) => row.source !== 'builtin')
const codexRows = (home: string, cwd?: string): ChatCommand[] => lister(home)('codex', cwd)

test.describe('ovis server/skills/claude.test.ts', () => {
    test.describe('Claude discovery', () => {
        test('loads personal and nearest ancestor skills before commands, without descendants', () => {
            const { home, repo, cwd } = fixture()
            skill(path.join(home, '.claude/skills'), 'shared', 'description: Personal')
            skill(path.join(repo, '.claude/skills'), 'shared', 'description: Project')
            skill(path.join(repo, '.claude/skills'), 'parent')
            skill(path.join(cwd, '.claude/skills'), 'local', 'name: renamed')
            skill(path.join(cwd, '.claude/skills'), 'hidden', 'user-invocable: false')
            skill(path.join(cwd, 'sub/.claude/skills'), 'deep')
            put(path.join(home, '.claude/commands/shared.md'), 'Legacy command')
            put(path.join(repo, '.claude/commands/team/check.md'), 'Check')
            const commands = claudeFound(home, cwd)
            // ovis returns them sorted by name; ours returns discovery order, so compare as a sorted list
            expect(commands.map(({ name }) => name).sort()).toEqual(['parent', 'renamed', 'shared', 'team:check'])
            expect(commands.find(({ name }) => name === 'shared')?.description).toBe('Personal')
        })

        test('loads personal and nearest ancestor skills before commands, without descendants — description from the body', () => {
            const { home, repo, cwd } = fixture()
            skill(path.join(repo, '.claude/skills'), 'parent')
            put(path.join(repo, '.claude/commands/team/check.md'), 'Check')
            const byName = new Map(claudeFound(home, cwd).map((row) => [row.name, row]))
            // ovis: a missing description falls back to the body text
            expect(byName.get('parent')?.description).toBe('Probe skill')
            expect(byName.get('team:check')?.description).toBe('Check')
        })

        test('honors the process config directory for synced skills, plugins and commands', () => {
            const { home, cwd } = fixture()
            const config = path.join(home, 'custom')
            const plugin = path.join(home, 'plugin')
            skill(path.join(home, '.claude/skills'), 'wrong-home')
            skill(path.join(plugin, 'skills'), 'folder', 'name: named')
            skill(path.join(plugin, 'skills'), 'hidden', 'user-invocable: false')
            put(path.join(plugin, 'commands/check.md'), 'Check')
            put(path.join(config, 'commands/local.md'), 'Local')
            put(path.join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@market': true, 'off@market': false } }))
            put(path.join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'tools@market': [{ installPath: plugin }], 'off@market': [{ installPath: plugin }] } }))
            const commands = claudeRows(home, cwd, config).filter(({ source }) => source !== 'builtin')
            // the synced-skills line (config/skills/synced/probe-skill) is not ported: ours skips `synced` folders by design
            expect(commands.map(({ name }) => name).sort()).toEqual(['local', 'tools:check', 'tools:named'])
        })

        test("offers the current reference's names, drops removed ones and keeps review as code-review's alias", () => {
            const { home, cwd } = fixture()
            const names = new Set(claudeRows(home, cwd).map(({ name }) => name))
            for (const name of ['agents', 'code-review', 'review', 'config', 'theme', 'batch', 'loop']) expect(names.has(name), name).toBe(true)
            for (const name of ['pr-comments', 'vim', 'ultraplan']) expect(names.has(name), name).toBe(false)
            const all = claudeRows(home, cwd).map(({ name }) => name)
            expect(new Set(all).size).toBe(all.length)
        })

        test("offers the current reference's names, drops removed ones and keeps review as code-review's alias — the agent-hidden four", () => {
            test.fail(true, 'ovis-port bug: heapdump/setup-bedrock/setup-vertex are not in CLAUDE_REFERENCE')
            const { home, cwd } = fixture()
            const names = new Set(claudeRows(home, cwd).map(({ name }) => name))
            for (const name of ['heapdump', 'setup-bedrock', 'setup-vertex']) expect(names.has(name), name).toBe(true)
        })

        test('offers every screen Chat cannot see through as terminal-bound and marks exactly the menu-hidden four', () => {
            test.fail(true, 'ovis-port bug: design-login, radio, stickers missing from CLAUDE_REFERENCE/CLAUDE_TERMINAL')
            const { home, cwd } = fixture()
            const bound = claudeRows(home, cwd).filter((row) => row.source === 'builtin' && row.terminal === 'always').map((row) => row.name).sort()
            expect(bound).toEqual([
                'add-dir', 'artifacts', 'auto-mode-setup', 'autofix-pr', 'bug', 'cd', 'chrome', 'config', 'copy', 'cost', 'design-login', 'desktop',
                'diff', 'feedback', 'help', 'hooks', 'ide', 'import', 'install-github-app', 'install-slack-app', 'keybindings', 'login', 'logout',
                'mcp', 'memory', 'mobile', 'passes', 'permissions', 'plugin', 'powerup', 'privacy-settings', 'radio', 'rate-limit-options',
                'remote-control', 'remote-env', 'resume', 'sandbox', 'scroll-speed', 'skill-doctor', 'skills', 'stats', 'status', 'stickers', 'tasks',
                'teleport', 'terminal-setup', 'theme', 'ultrareview', 'upgrade', 'usage', 'usage-credits', 'voice', 'web-setup', 'workflows'
            ])
        })

        test('describes the forms the block names and leaves the rest unannotated', () => {
            // ovis `source.forms`, copied; ours keeps only whether bare input opens a screen (terminal: 'bare')
            const forms: Record<string, Array<{ match: unknown; interaction: string }>> = {
                model: [{ match: 'bare', interaction: 'dialog' }, { match: 'other', interaction: 'none' }],
                effort: [{ match: 'bare', interaction: 'dialog' }, { match: 'other', interaction: 'none' }],
                goal: [{ match: 'bare', interaction: 'dialog' }, { match: { sub: 'clear' }, interaction: 'none' }, { match: 'other', interaction: 'none' }],
                btw: [{ match: 'bare', interaction: 'terminal' }, { match: 'other', interaction: 'terminal' }],
                rewind: [{ match: 'bare', interaction: 'terminal' }],
                fast: [{ match: 'bare', interaction: 'terminal' }, { match: 'other', interaction: 'none' }],
                autocompact: [{ match: 'bare', interaction: 'terminal' }, { match: 'other', interaction: 'none' }],
                advisor: [{ match: 'bare', interaction: 'terminal' }, { match: 'other', interaction: 'none' }],
                export: [{ match: 'bare', interaction: 'terminal' }, { match: 'other', interaction: 'none' }],
                plan: [{ match: 'bare', interaction: 'unknown' }, { match: { sub: 'open' }, interaction: 'terminal' }, { match: 'other', interaction: 'unknown' }],
                review: [{ match: 'bare', interaction: 'unknown' }],
                'code-review': [{ match: 'bare', interaction: 'unknown' }]
            }
            const { home, cwd } = fixture()
            const rows = new Map(claudeRows(home, cwd).filter((row) => row.source === 'builtin').map((row) => [row.name, row]))
            for (const [name, list] of Object.entries(forms)) {
                expect(rows.has(name), name).toBe(true)
                const bare = list.find((form) => form.match === 'bare')
                const opensScreenBare = bare?.interaction === 'dialog' || bare?.interaction === 'terminal'
                expect(rows.get(name)?.terminal, name).toBe(opensScreenBare ? 'bare' : undefined)
            }
        })

        test('hides skills with user-invocable off in any spelling the frontmatter accepts', () => {
            const { home, cwd } = fixture()
            const root = path.join(cwd, '.claude/skills')
            skill(root, 'plain')
            for (const [name, value] of [['a', 'false'], ['b', 'no'], ['c', 'Off'], ['d', '0']] as const) skill(root, name, `user-invocable: ${value}`)
            skill(root, 'e', 'user-invocable: true')
            expect(claudeFound(home, cwd).map(({ name }) => name).sort()).toEqual(['e', 'plain'])
        })

        test('lets a skill replace a bundled one of the same name, marked as shadowing it', () => {
            const { home, cwd } = fixture()
            skill(path.join(cwd, '.claude/skills'), 'doctor')
            const rows = claudeRows(home, cwd).filter((row) => row.name === 'doctor')
            expect(rows).toHaveLength(1)
            // ours has no `shadows` field; the skill winning over the built-in is what is checked
            expect(rows[0]).toMatchObject({ source: 'project' })
        })

        test('honors user-invocable off in a legacy command file', () => {
            const { home, repo, cwd } = fixture()
            put(path.join(repo, '.claude/commands/hidden.md'), '---\nuser-invocable: false\n---\nHidden')
            put(path.join(repo, '.claude/commands/team/inner.md'), '---\nuser-invocable: no\n---\nHidden')
            put(path.join(home, '.claude/commands/personal.md'), '---\nuser-invocable: false\n---\nHidden')
            put(path.join(repo, '.claude/commands/shown.md'), '---\nuser-invocable: true\n---\nShown')
            expect(claudeFound(home, cwd).map(({ name }) => name)).toEqual(['shown'])
        })

        test('lists the screens with visibility terminal and the hidden four as agent-hidden', () => {
            const { home, cwd } = fixture()
            const rows = claudeRows(home, cwd)
            for (const name of ['config', 'usage', 'cost', 'status', 'help', 'add-dir', 'mcp']) expect(rows.find((row) => row.name === name)?.terminal, name).toBe('always')
            // "offered" = the chat can send it as is
            for (const name of ['fast', 'export', 'context', 'plan']) expect(rows.find((row) => row.name === name)?.terminal, name).not.toBe('always')
            expect(rows.find((row) => row.name === 'compact')?.terminal).toBeUndefined()
        })

        test('shows one compact row, marked as shadowing the builtin, when a skill has that name', () => {
            const { home, cwd } = fixture()
            skill(path.join(cwd, '.claude/skills'), 'compact')
            const rows = claudeRows(home, cwd).filter((row) => row.name === 'compact')
            expect(rows).toHaveLength(1)
            expect(rows[0]?.source).not.toBe('builtin')
        })
    })

    test.describe('Claude skill identity', () => {
        test('lists a skill reached through a symlinked alias root once, identified by its real file', () => {
            const { home, repo, cwd } = fixture()
            skill(path.join(home, '.claude/skills'), 'aliased', 'description: Aliased')
            fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
            fs.symlinkSync(path.join(home, '.claude/skills'), path.join(repo, '.claude/skills'), 'dir')
            const rows = claudeRows(home, cwd).filter(({ name }) => name === 'aliased')
            expect(rows).toHaveLength(1)
            expect(rows[0]).toMatchObject({ source: 'skill', description: 'Aliased' })
        })
    })
})

// Copied by ovis from codex-rs/tui/src/slash_command.rs at rust-v0.163.0 (commit 83086188ae0614bd882818ff1aa23f3194962012)
const PINNED_SLASH_TABLE = [
    'model', 'daybreak', 'ide', 'permissions', 'keymap', 'vim', 'setup-default-sandbox', 'experimental', 'approve', 'memories',
    'skills', 'import', 'hooks', 'review', 'rename', 'new', 'archive', 'delete', 'resume', 'fork', 'worktree', 'init', 'compact',
    'config', 'recap', 'plan', 'voice', 'goal', 'agents', 'side', 'btw', 'copy', 'export', 'raw', 'tui', 'diff', 'mention',
    'status', 'daemon', 'warnings', 'cd', 'pwd', 'usage', 'title', 'statusline', 'theme', 'pets', 'mcp', 'apps', 'plugins',
    'logout', 'quit', 'exit', 'feedback', 'ps', 'stop', 'clear', 'subagents', 'debug-config', 'debug-m-drop', 'debug-m-update'
]
const POPUP_HIDDEN = ['apps', 'debug-config', 'debug-m-drop', 'debug-m-update']

test.describe('ovis server/skills/codex.test.ts', () => {
    const builtinRows = (home: string) => codexRows(home).filter((row) => row.source === 'builtin')

    test.describe('Codex skill discovery', () => {
        test('loads ancestor, shared, legacy, system, nested, nameless and linked skills with their origins', () => {
            test.fail(true, 'ovis-port bug: .system skipped (dot dirs), project .agents/skills not read; same-name dedupe is by design (chatCommands.ts first of a name wins)')
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-cmds-'))
            roots.push(root)
            const home = path.join(root, 'home')
            const repo = path.join(root, 'repo')
            const cwd = path.join(repo, 'packages', 'app')
            fs.mkdirSync(cwd, { recursive: true })
            put(path.join(repo, '.git'), '')
            codexSkill(path.join(root, '.agents', 'skills'), 'outside')
            for (const directory of [repo, path.join(repo, 'packages'), cwd]) codexSkill(path.join(directory, '.agents', 'skills'), 'same')
            codexSkill(path.join(home, '.agents', 'skills'), 'shared')
            codexSkill(path.join(home, '.codex', 'skills'), 'legacy')
            codexSkill(path.join(home, '.codex', 'skills', '.system'), 'creator')
            codexSkill(path.join(cwd, '.codex', 'skills'), 'unsupported')
            const linked = codexSkill(path.join(root, 'links'), 'target')
            fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true })
            fs.symlinkSync(path.dirname(linked), path.join(home, '.agents', 'skills', 'link'), 'dir')
            codexSkill(path.join(home, '.agents', 'skills', 'group'), 'nested')
            put(path.join(home, '.agents', 'skills', 'missing-description', 'SKILL.md'), '---\nname: missing-description\n---\nBody')
            put(path.join(home, '.agents', 'skills', 'missing-name', 'SKILL.md'), '---\ndescription: Named by its directory\n---\n')
            put(path.join(home, '.agents', 'skills', '.ignore'), 'shared/\n')
            const commands = codexRows(home, cwd).filter((command) => command.source === 'skill')
            expect(commands.map(({ name, trigger }) => [name, trigger]).sort()).toEqual([
                ['creator', '$'], ['legacy', '$'], ['missing-name', '$'], ['nested', '$'],
                ['same', '$'], ['same', '$'], ['same', '$'],
                ['shared', '$'], ['target', '$'], ['unsupported', '$']
            ])
            expect(commands.filter((command) => command.name !== 'missing-name').every((command) => command.description === 'First sentence. Second sentence.')).toBe(true)
        })

        test('keeps skills discoverable when TOML is malformed', () => {
            const { home } = fixture()
            codexSkill(path.join(home, '.codex', 'skills'), 'available')
            put(path.join(home, '.codex', 'config.toml'), '[[skills.config]\nenabled = false')
            expect(codexRows(home).some((command) => command.name === 'available')).toBe(true)
        })

        test('carries the pin its builtin table and forms were checked against', () => {
            const { home } = fixture()
            const names = builtinRows(home).map((row) => row.name)
            expect(names).toContain('model')
            expect(names).toContain('subagents')
        })

        test('lists exactly the builtins of the pinned slash table', () => {
            test.fail(true, 'ovis-port bug: apps, daemon, daybreak, debug-*, pets, setup-default-sandbox missing from CODEX_BUILTINS')
            const { home } = fixture()
            const names = builtinRows(home).map((row) => row.name)
            expect([...names].sort()).toEqual([...PINNED_SLASH_TABLE].sort())
            expect(new Set(names).size).toBe(names.length)
            expect(names).not.toContain('fast')
            for (const row of builtinRows(home)) expect(row.description && row.description !== `Run /${row.name}`, row.name).toBeTruthy()
        })

        test('offers the nine former exclusions and the other TUI-only screens as terminal-bound builtins', () => {
            test.fail(true, 'ovis-port bug: setup-default-sandbox/daemon/pets missing; status/diff/pwd/ps marked terminal always (ovis does not terminal-bind them)')
            const { home } = fixture()
            const former = ['resume', 'permissions', 'agents', 'hooks', 'mcp', 'plugins', 'skills', 'voice', 'theme']
            const screens = ['config', 'setup-default-sandbox']
            const held = ['keymap', 'experimental', 'approve', 'memories', 'import', 'new', 'archive', 'delete', 'fork', 'worktree', 'side', 'btw',
                'copy', 'tui', 'mention', 'daemon', 'warnings', 'cd', 'usage', 'title', 'statusline', 'pets', 'feedback', 'subagents', 'vim', 'logout']
            const bound = builtinRows(home).filter((row) => row.terminal === 'always').map((row) => row.name)
            expect([...bound].sort()).toEqual([...former, ...screens, ...held].sort())
            expect(builtinRows(home).map((row) => row.name)).not.toContain('help')
        })

        test('types the forms codex-rs/tui/src/slash_command.rs at rust-v0.163.0 gives each command', () => {
            // ovis forms: bare -> dialog/terminal means a bare send opens a screen. Ours: terminal 'bare' (opens only when bare) or 'always'
            const { home } = fixture()
            const rows = new Map(builtinRows(home).map((row) => [row.name, row]))
            expect(rows.get('model')?.terminal).toBe('bare')
            for (const name of ['status', 'diff', 'pwd', 'ps', 'mcp']) expect(rows.get(name)?.terminal, name).toBeDefined()
            for (const name of ['init', 'compact']) expect(rows.get(name)?.terminal, name).toBeUndefined()
            for (const name of ['rename', 'export']) expect(rows.get(name)?.terminal, name).toBe('bare')
            expect(rows.get('goal')?.terminal).toBeUndefined()
        })

        test('keeps a bare /review in the terminal, where the pinned TUI opens its review preset popup, and sends /review <text>', () => {
            const { home } = fixture()
            expect(builtinRows(home).find((row) => row.name === 'review')?.terminal).toBe('bare')
        })

        test('marks what the pinned popup hides as agent-hidden, and nothing else', () => {
            test.fail(true, 'ovis-port bug: apps and debug-* builtins are not in CODEX_BUILTINS')
            const { home } = fixture()
            const names = builtinRows(home).map((row) => row.name)
            for (const name of POPUP_HIDDEN) {
                expect(names, name).toContain(name)
                expect(builtinRows(home).find((row) => row.name === name)?.terminal, name).toBeUndefined()
            }
        })

        test('lists every former exclusion with visibility terminal in the pane catalog', () => {
            const { home } = fixture()
            const rows = builtinRows(home)
            for (const name of ['resume', 'permissions', 'agents', 'hooks', 'mcp', 'plugins', 'skills', 'voice', 'theme']) {
                expect(rows.find((command) => command.name === name)?.terminal, name).toBe('always')
            }
            expect(rows.find((command) => command.name === 'model')?.terminal).not.toBe('always')
        })
    })

    test.describe('Codex catalog from the pinned loader', () => {
        test('walks skill roots to depth 6 through directory links and never through a SKILL.md link', () => {
            test.fail(true, 'ovis-port bug: skillsIn() lists a skill whose SKILL.md is a symlink (existsSync follows links)')
            const { home } = fixture()
            const outerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-cmds-out-'))
            roots.push(outerRoot)
            const base = path.join(home, '.agents', 'skills')
            codexSkill(path.join(base, 'a'), 'depth-two')
            codexSkill(path.join(base, 'a', 'b', 'c', 'd', 'e'), 'depth-six')
            codexSkill(path.join(base, 'a', 'b', 'c', 'd', 'e', 'x'), 'depth-seven')
            codexSkill(path.join(base, '.hidden'), 'hidden')
            const outside = codexSkill(path.join(outerRoot, 'outside'), 'linked-dir')
            fs.symlinkSync(path.dirname(outside), path.join(base, 'a', 'link'), 'dir')
            const real = codexSkill(path.join(outerRoot, 'elsewhere'), 'file-link')
            put(path.join(base, 'file-link', 'placeholder'), '')
            fs.symlinkSync(real, path.join(base, 'file-link', 'SKILL.md'))
            const names = codexRows(home).map((command) => command.name)
            expect(names).toContain('depth-two')
            expect(names).toContain('depth-six')
            expect(names).toContain('linked-dir')
            expect(names).not.toContain('depth-seven')
            expect(names).not.toContain('hidden')
            expect(names).not.toContain('file-link')
        })

        test('names a skill after its directory when the name is missing or blank', () => {
            const { home } = fixture()
            put(path.join(home, '.agents', 'skills', 'from-dir', 'SKILL.md'), '---\ndescription: No name\n---\n')
            put(path.join(home, '.agents', 'skills', 'blank', 'SKILL.md'), '---\nname: "  "\ndescription: Blank name\n---\n')
            expect(codexRows(home).filter((row) => row.source === 'skill').map((command) => command.name).sort()).toEqual(['blank', 'from-dir'])
        })

        test('loads project .codex/skills from the repository\'s directories', () => {
            const { home, repo, cwd } = fixture()
            codexSkill(path.join(repo, '.codex', 'skills'), 'repo-level')
            codexSkill(path.join(cwd, '.codex', 'skills'), 'app-level')
            expect(codexRows(home, cwd).filter((row) => row.source === 'skill').map((command) => command.name).sort()).toEqual(['app-level', 'repo-level'])
        })
    })

    test.describe('Codex skill identity', () => {
        test('lists a skill reached through a symlinked alias root once, identified by its real file', () => {
            const { home } = fixture()
            put(path.join(home, '.codex', 'skills', 'aliased', 'SKILL.md'), '---\nname: aliased\ndescription: Aliased skill\n---\n')
            fs.mkdirSync(path.join(home, '.agents'), { recursive: true })
            fs.symlinkSync(path.join(home, '.codex', 'skills'), path.join(home, '.agents', 'skills'), 'dir')
            const rows = codexRows(home).filter((command) => command.name === 'aliased')
            expect(rows).toHaveLength(1)
            expect(rows[0]).toMatchObject({ source: 'skill', trigger: '$' })
        })
    })
})
