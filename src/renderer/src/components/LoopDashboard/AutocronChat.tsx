import { useEffect, useState } from 'react'
import { ExternalLink, MessageSquareText } from 'lucide-react'
import type { ChatPreferences } from '../../../../shared/conversation'
import type { TerminalSession } from '../../../../shared/types'
import { ChatView } from '../ChatView'
import { electronChatTransport } from '../../utils/electronChatTransport'
import { isAgentSession } from '../../utils/agentSession'

/**
 * Loop window › Autocron › Chat: talk to a session a job opened without leaving the Loop window.
 *
 * Only the Chat view comes here, never a terminal: a terminal view is attached to one window at a
 * time (TerminalManager.attachView), so drawing it here would take it from the main window.
 * The Chat view reads the conversation file and types through the same path the main window's
 * Chat uses, so what is sent here shows up there too (conversation-changed goes to every window).
 */

/** How often the panel re-reads whether its session still exists (it can be closed in the main window). */
const SESSION_CHECK_MS = 3000

type SessionLookup =
    | { state: 'loading' }
    | { state: 'closed' }
    | { state: 'found'; session: TerminalSession }

async function findSession(sessionId: string): Promise<SessionLookup> {
    const workspaces = await window.api.getWorkspaces()
    for (const workspace of workspaces) {
        const session = workspace.sessions?.find((s) => s.id === sessionId)
        if (session) return { state: 'found', session }
    }
    return { state: 'closed' }
}

function useSession(sessionId: string): SessionLookup {
    const [lookup, setLookup] = useState<SessionLookup>({ state: 'loading' })
    useEffect(() => {
        let cancelled = false
        setLookup({ state: 'loading' })
        const check = () => {
            findSession(sessionId)
                .then((next) => { if (!cancelled) setLookup(next) })
                .catch(() => {})
        }
        check()
        const timer = window.setInterval(check, SESSION_CHECK_MS)
        return () => {
            cancelled = true
            window.clearInterval(timer)
        }
    }, [sessionId])
    return lookup
}

function useChatPreferences(): ChatPreferences | undefined {
    const [preferences, setPreferences] = useState<ChatPreferences | undefined>(undefined)
    useEffect(() => {
        let cancelled = false
        window.api.getSettings().then((settings) => {
            if (!cancelled) setPreferences(settings?.chat)
        }).catch(() => {})
        return () => { cancelled = true }
    }, [])
    return preferences
}

function Notice({ text, onOpenInMain }: { text: string; onOpenInMain?: () => void }) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6" data-testid="autocron-chat-notice">
            <MessageSquareText size={32} className="text-purple-400/40" />
            <p className="text-xs text-gray-400 max-w-xs">{text}</p>
            {onOpenInMain && (
                <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-white/10 text-xs text-gray-300 hover:text-white" onClick={onOpenInMain}>
                    <ExternalLink size={12} /> Open in main window
                </button>
            )}
        </div>
    )
}

export function AutocronChat({ sessionId, onOpenInMain }: { sessionId: string | null; onOpenInMain: (sessionId: string) => void }) {
    if (!sessionId) return <Notice text="No session to talk to yet — run the job, then pick a run's «Talk here»." />
    // keyed so a different run starts a fresh lookup and a fresh Chat view
    return <SessionChat key={sessionId} sessionId={sessionId} onOpenInMain={() => onOpenInMain(sessionId)} />
}

function SessionChat({ sessionId, onOpenInMain }: { sessionId: string; onOpenInMain: () => void }) {
    const lookup = useSession(sessionId)
    const preferences = useChatPreferences()

    if (lookup.state === 'loading') return <Notice text="Looking for the session…" />
    if (lookup.state === 'closed') return <Notice text="This session was closed." />
    if (!isAgentSession(lookup.session)) {
        return <Notice text="Chat isn't available for this session." onOpenInMain={onOpenInMain} />
    }

    return (
        <div className="flex flex-col flex-1 min-h-0" data-testid="autocron-chat" data-session-id={sessionId}>
            <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-white/5 shrink-0">
                <span className="text-xs text-gray-300 truncate" data-testid="autocron-chat-name">{lookup.session.name}</span>
                <button className="flex items-center gap-1 text-xs text-purple-300 hover:text-purple-200 shrink-0" onClick={onOpenInMain} data-testid="autocron-chat-open-main">
                    <ExternalLink size={11} /> Open in main window
                </button>
            </div>
            {/* .chat-view is absolutely positioned (it sits over a terminal in the main window), so it
                needs a positioned box to fill */}
            <div className="relative flex-1 min-h-0">
                <ChatView
                    sessionId={sessionId}
                    transport={electronChatTransport}
                    preferences={preferences}
                    // a command only the terminal can show (/config, a bare /model) goes to the main window
                    onOpenTerminal={onOpenInMain}
                />
            </div>
        </div>
    )
}
