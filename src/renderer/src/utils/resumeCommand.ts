import { TerminalSession } from '../../../shared/types'

/**
 * The command that brings a tracked conversation back after a restart. It
 * repeats the command that started it — an alias (`cldy`) or a template's
 * flags would be lost otherwise. Claude Code resumes with a flag, Codex with a
 * subcommand (`codex <flags> resume <id>`, checked with codex-cli 0.155.1).
 */
export function resumeCommandFor(session: Pick<TerminalSession, 'cliSessionId' | 'cliToolName' | 'cliCommand'>): string | undefined {
    if (!session.cliSessionId || !session.cliToolName) return undefined
    const command = session.cliCommand || session.cliToolName
    return session.cliToolName === 'codex'
        ? `${command} resume ${session.cliSessionId}`
        : `${command} --resume ${session.cliSessionId}`
}
