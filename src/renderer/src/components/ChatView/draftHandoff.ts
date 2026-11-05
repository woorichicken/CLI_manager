import { useSyncExternalStore } from 'react'
import type { ChatTransport } from '../../../../shared/conversation'
import { readDraft, replaceDraft } from './draftStore'

/**
 * The view switch carries what was being written (4b9cb0c2, people's decision 11-05).
 * Chat → Terminal: the chat's unsent text goes into Claude's input box without Enter, and the chat
 * box empties — unless the input box already holds text (never written over: a notice instead).
 * Terminal → Chat: a one-row draft moves to the chat and the input box empties; more rows stay.
 * Claude only: for Codex the chat keeps its text and says so. Mac (button, ⌘⇧M) and phone (tab) alike.
 */

export interface HandoffNotice {
    id: number
    sessionId: string
    text: string
}

let current: HandoffNotice | null = null
let sequence = 0
const listeners = new Set<() => void>()

function notify(sessionId: string, text: string): void {
    current = { id: ++sequence, sessionId, text }
    for (const listener of listeners) listener()
}

export function dismissHandoffNotice(id: number): void {
    if (current?.id !== id) return
    current = null
    for (const listener of listeners) listener()
}

export function useHandoffNotice(): HandoffNotice | null {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        () => current
    )
}

export const HANDOFF_TEXT = {
    busy: 'The terminal input line already has text — your Chat message stays in Chat.',
    question: 'A question is on screen in the terminal — your Chat message stays in Chat.',
    codex: 'Codex: your unsent Chat message stays in Chat — it is not moved to the terminal.',
    severalLines: 'There is text you were writing in the terminal (more than one line) — it stays there.',
    kept: 'There is text you were writing in the terminal — it stays there.'
} as const

/** Leaving Chat for the terminal. */
export async function draftToTerminal(transport: ChatTransport, sessionId: string): Promise<void> {
    const text = readDraft(sessionId)
    if (!text.trim() || !transport.placeDraftInTerminal) return
    const result = await transport.placeDraftInTerminal(sessionId, text).catch(() => null)
    if (!result) return
    if (result.status === 'placed') {
        // typed into in the meantime: that is newer, keep it
        if (readDraft(sessionId) === text) replaceDraft(sessionId, '')
    } else if (result.status === 'busy') notify(sessionId, HANDOFF_TEXT.busy)
    else if (result.status === 'unsupported') notify(sessionId, HANDOFF_TEXT.codex)
    else if (result.reason === 'awaiting_input') notify(sessionId, HANDOFF_TEXT.question)
}

/** Leaving the terminal for Chat. */
export async function draftFromTerminal(transport: ChatTransport, sessionId: string): Promise<void> {
    if (!transport.takeTerminalDraft) return
    const result = await transport.takeTerminalDraft(sessionId).catch(() => null)
    if (!result) return
    if (result.status === 'moved') {
        const before = readDraft(sessionId)
        replaceDraft(sessionId, before.trim() ? `${before}\n${result.text}` : result.text)
    } else if (result.status === 'left') notify(sessionId, result.reason === 'several_lines' ? HANDOFF_TEXT.severalLines : HANDOFF_TEXT.kept)
}

/** Runs the carry for a switch between the two views; nothing for a switch to the same one. */
export function carryDraft(transport: ChatTransport, sessionId: string, from: 'terminal' | 'chat', to: 'terminal' | 'chat'): void {
    if (from === to) return
    void (to === 'terminal' ? draftToTerminal(transport, sessionId) : draftFromTerminal(transport, sessionId))
}
