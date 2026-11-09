import { useSyncExternalStore } from 'react'
import type { TerminalSession } from '../../../shared/types'

/**
 * Sessions whose Codex has started but written no conversation file yet (main's `agent-pending`): Codex
 * writes it with the first message, and that message can come from the Chat. Kept here, not in the
 * workspaces state — nothing about it is stored.
 */
const awaitingFirstMessage = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

export function setAgentPending(sessionId: string, agent: 'codex' | null): void {
    if ((agent !== null) === awaitingFirstMessage.has(sessionId)) return
    if (agent) awaitingFirstMessage.add(sessionId)
    else awaitingFirstMessage.delete(sessionId)
    version++
    for (const listener of listeners) listener()
}

/** Re-renders the caller when a session starts or stops waiting for its first message. */
export function useAgentPendingVersion(): number {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        () => version
    )
}

/**
 * A session the Chat view can draw: one running Claude Code or Codex, whose
 * conversation id the app knows (`cliToolName` is set when the CLI starts —
 * template, typed command or Codex rollout — and cleared when it exits), or a
 * Codex that waits for its first message.
 */
export function isAgentSession(session: (Pick<TerminalSession, 'cliToolName'> & { id?: string }) | null | undefined): boolean {
    if (session?.cliToolName === 'claude' || session?.cliToolName === 'codex') return true
    return session?.id !== undefined && awaitingFirstMessage.has(session.id)
}
