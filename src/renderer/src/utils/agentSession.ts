import type { TerminalSession } from '../../../shared/types'

/**
 * A session the Chat view can draw: one running Claude Code or Codex, whose
 * conversation id the app knows (`cliToolName` is set when the CLI starts —
 * template, typed command or Codex rollout — and cleared when it exits).
 */
export function isAgentSession(session: Pick<TerminalSession, 'cliToolName'> | null | undefined): boolean {
    return session?.cliToolName === 'claude' || session?.cliToolName === 'codex'
}
