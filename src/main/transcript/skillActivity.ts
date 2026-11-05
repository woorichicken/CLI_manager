// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/skill-activity.ts — the Claude and Codex readers only (pi/omp/Hermes forms dropped),
// plus server/skill-invocations/claude.ts (claudeCommandEcho) with a fixed list of built-in commands.
import { basename, dirname } from 'path'
import type { SkillActivity } from '../../shared/conversation'

const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const label = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n<>]/.test(value) ? value : null

/** No filesystem lookup: evidence belongs to the transcript. */
export function skillDocument(path: unknown): SkillActivity | null {
    if (typeof path !== 'string' || path.length > 4096 || /[\r\n]/.test(path)) return null
    const normalized = path.replaceAll('\\', '/')
    if (!normalized.endsWith('/SKILL.md')) return null
    const name = label(basename(dirname(normalized)))
    return name && name !== '.' ? { name, path, evidence: 'instructions', status: 'loaded' } : null
}

/** Codex's explicitly selected skill is injected as one complete user-context envelope. */
export function selectedSkill(text: string): SkillActivity | null {
    const match = /^<skill>\s*<name>([^<>\r\n]+)<\/name>\s*<path>([^<>\r\n]+)<\/path>[\s\S]*<\/skill>$/.exec(text.trim())
    if (!match) return null
    const name = label(match[1])
    const document = skillDocument(match[2])
    return name && document ? { ...document, name } : null
}

export function invokedSkill(name: string, input: Record<string, unknown>): SkillActivity | null {
    if (name !== 'Skill') return null
    const skill = label(input.skill)
    return skill ? { name: skill, evidence: 'invocation', status: 'requested' } : null
}

/** Codex records parsed read paths even for commands executed inside code-mode tools. */
export function codexReadSkills(value: unknown): SkillActivity[] {
    const item = record(value)
    if (item.type !== 'CommandExecution' || !Array.isArray(item.parsed_cmd)) return []
    if (item.status !== 'completed' && item.status !== 'failed') return []
    const status = item.exit_code === 0 ? 'loaded' : typeof item.exit_code === 'number' ? 'failed' : null
    if (!status) return []
    return item.parsed_cmd.flatMap((entry) => {
        const command = record(entry)
        const skill = command.type === 'read' ? skillDocument(command.path) : null
        return skill ? [{ ...skill, status }] : []
    })
}

/** Older Codex rollouts only record tool calls: a literal, single file read of a SKILL.md. */
export function codexReadCall(name: string, args: Record<string, unknown>): SkillActivity | null {
    if (name === 'read_file' || name === 'Read') {
        const skill = skillDocument(args.file_path ?? args.path)
        return skill ? { ...skill, status: 'requested' } : null
    }
    if (name !== 'exec_command' && name !== 'shell_command' && name !== 'shell') return null
    const cmd = args.cmd ?? args.command
    if (typeof cmd !== 'string' || /[\n;&|<>`$]/.test(cmd)) return null
    const match = /^(?:cat|head(?:\s+-n\s+\d+)?|sed\s+-n\s+['"]?\d+(?:,\d+)?p['"]?)\s+(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))\s*$/.exec(cmd.trim())
    const skill = match ? skillDocument(match[1] ?? match[2] ?? match[3]) : null
    return skill ? { ...skill, status: 'requested' } : null
}

/**
 * Claude Code's own slash commands. ovis reads them from the installed Claude
 * (skills/claude.ts); a fixed list is enough here — a command left off it shows
 * as a skill chip on the prompt instead of being hidden.
 */
const CLAUDE_COMMANDS = new Set([
    'add-dir', 'agents', 'bashes', 'bug', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'exit',
    'export', 'help', 'hooks', 'ide', 'init', 'install-github-app', 'login', 'logout', 'mcp', 'memory', 'model',
    'output-style', 'permissions', 'plugin', 'pr-comments', 'privacy-settings', 'release-notes', 'resume',
    'rewind', 'status', 'statusline', 'terminal-setup', 'todos', 'upgrade', 'usage', 'vim', 'fast', 'goal'
])

/** The recorded Claude command echo, not arbitrary XML embedded in a user's prose. */
export function claudeCommandEcho(text: string): { text: string; skill: SkillActivity } | null {
    const match = /^<command-message>([\p{L}\p{N}_:-]+)<\/command-message>\s*<command-name>\/([\p{L}\p{N}_:-]+)<\/command-name>\s*<command-args>([\s\S]*)<\/command-args>$/u.exec(text.trim())
    if (!match || match[1] !== match[2]) return null
    const name = match[1]
    // a skill (bundled or the user's own) is a skill: only a built-in command is left out
    if (!name || CLAUDE_COMMANDS.has(name)) return null
    const args = match[3]?.trim()
    return { text: `/${name}${args ? ` ${args}` : ''}`, skill: { name, evidence: 'invocation', status: 'requested' } }
}
