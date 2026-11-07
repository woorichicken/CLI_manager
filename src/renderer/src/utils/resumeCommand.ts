import { TerminalSession } from '../../../shared/types'
import { decideAgentCommand, type AliasResolver } from '../../../shared/agentCommand'

/**
 * A read-only restart command: known options and aliases survive, a definite
 * prompt is removed, and uncertain syntax falls back to the agent name. Main
 * applies the same policy immediately before input, with its loaded aliases.
 */
export function resumeCommandFor(
    session: Pick<TerminalSession, 'cliSessionId' | 'cliToolName' | 'cliCommand'>,
    resolveAlias?: AliasResolver
): string | undefined {
    if (!session.cliSessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.cliSessionId)) return undefined
    if (session.cliToolName !== 'claude' && session.cliToolName !== 'codex') return undefined
    const command = decideAgentCommand(session.cliCommand, session.cliToolName, resolveAlias).inputCommand
    return session.cliToolName === 'codex'
        ? `${command} resume ${session.cliSessionId}`
        : `${command} --resume ${session.cliSessionId}`
}
