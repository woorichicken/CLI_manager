import { PHONE_CHAT_TURN_PAGE, type ChatPreferences } from '../../../shared/conversation'
import { carryDraft } from '../components/ChatView/draftHandoff'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Menu, MessageSquareText, TerminalSquare } from 'lucide-react'
import type { PhoneRole, PhoneSession } from '../../../shared/phone'
import { ChatView } from '../components/ChatView'
import { createPhoneChatTransport } from './phoneChatTransport'
import { PhoneDocPanel } from './PhoneDocPanel'
import { PhoneFilePanel, type PhoneFileTarget } from './PhoneFilePanel'
import { PhoneTerminal } from './PhoneTerminal'

/**
 * One session on the phone: a header with «Chat | Terminal» (agents only; Chat first)
 * and the view under it. Chat is the desktop Chat view itself, handed the phone's
 * transport. The terminal is the Mac's own, at the Mac's size.
 */

export type SessionLens = 'chat' | 'terminal'

/** Long enough for a Back to land; a page in the frame can take that Back for its own, and then no popstate comes here. */
const BACK_SETTLES_MS = 300

export function afterHistoryBack(then: () => void): void {
    let done = false
    const once = (): void => {
        if (done) return
        done = true
        window.removeEventListener('popstate', once)
        then()
    }
    window.addEventListener('popstate', once)
    window.setTimeout(once, BACK_SETTLES_MS)
}

/** An HTML page opens as itself (decision 0011). A line asked for is a place in its source: the code view. */
export const opensAsDocument = (target: PhoneFileTarget): boolean => target.line === undefined && /\.html?$/i.test(target.path)

/** a finger, not a mouse: the chat's Return breaks the line and opening it leaves the keyboard down */
const COARSE_POINTER = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

export function SessionScreen({
    session,
    lens,
    role,
    onLens,
    onMenu,
    showMenuButton,
    menuBadge = 0,
    offline = false,
    refreshing = false,
    chatPreferences,
    onSessionLink
}: {
    session: PhoneSession
    lens: SessionLens
    role: PhoneRole
    onLens: (lens: SessionLens) => void
    onMenu: () => void
    showMenuButton: boolean
    /** other sessions waiting for an answer — shown on ☰ while the list is out of sight */
    menuBadge?: number
    /** the Mac stopped answering: said in the header, its height unchanged (ovis headerConnection.ts) */
    offline?: boolean
    /** back on the page after a while away: being read again (e05bf978) */
    refreshing?: boolean
    /** this phone's own chat settings (phoneChatSettings.ts) with the Mac's quick replies */
    chatPreferences?: ChatPreferences
    /** a `climanager://session/…` link in the chat: open that session here (b2020233) */
    onSessionLink?: (uri: string) => void
}) {
    const [file, setFile] = useState<PhoneFileTarget | null>(null)
    // the phone's Back closes the panel. The entry holds the same address: a file's path stays out of the
    // browser's history, and PhoneApp, which reads its route from the address, sees nothing change.
    const openFile = useCallback((sessionId: string, path: string, line?: number) => {
        window.history.pushState(window.history.state, '', window.location.href)
        setFile({ sessionId, path, ...(line !== undefined ? { line } : {}) })
    }, [])
    const closeFile = useCallback(() => window.history.back(), [])
    // a page in the frame can add history of its own, and Back would walk through that first: this closes at once
    const closeDocument = useCallback(() => {
        setFile(null)
        window.history.back()
    }, [])
    const fileOpen = file !== null
    useEffect(() => {
        if (!fileOpen) return
        const pop = (): void => setFile(null)
        window.addEventListener('popstate', pop)
        return () => window.removeEventListener('popstate', pop)
    }, [fileOpen])
    // an alert or a session link moved the page on: this session's file does not come back with it
    useEffect(() => setFile(null), [session.id])
    const transport = useMemo(() => createPhoneChatTransport(undefined, openFile), [openFile])
    const chatAvailable = session.agent !== null
    const view: SessionLens = chatAvailable ? lens : 'terminal'
    // the tabs carry what was being written (4b9cb0c2); a view-only phone moves nothing
    const switchLens = (next: SessionLens): void => {
        if (role === 'drive' && chatAvailable) carryDraft(transport, session.id, view, next)
        onLens(next)
    }

    return (
        <div className="phone-session" data-testid="phone-session" data-session-id={session.id} data-lens={view}>
            <header className="phone-header">
                {showMenuButton && (
                    <button type="button" className="phone-icon-button" aria-label="Sessions" data-testid="phone-menu-button" onClick={onMenu}>
                        <Menu size={18} />
                        {menuBadge > 0 && (
                            <span className="phone-menu-badge" data-testid="phone-menu-badge" aria-label={`${menuBadge} waiting`}>
                                {menuBadge}
                            </span>
                        )}
                    </button>
                )}
                <span className={`phone-dot phone-dot-${session.state}`} aria-hidden="true" />
                <span className="phone-header-title" data-testid="phone-session-title">
                    {session.name}
                    {offline && (
                        <span className="phone-header-offline" data-testid="phone-header-offline">
                            {' '}· Reconnecting…
                        </span>
                    )}
                    {!offline && refreshing && (
                        <span className="phone-header-refreshing" data-testid="phone-header-refreshing">
                            {' '}<span className="phone-spinner" aria-hidden="true" /> Refreshing…
                        </span>
                    )}
                </span>
                {chatAvailable && (
                    <div className="phone-seg phone-lens" role="group" aria-label="Chat or terminal">
                        <button type="button" aria-pressed={view === 'chat'} data-testid="phone-lens-chat" onClick={() => switchLens('chat')}>
                            <MessageSquareText size={14} /> Chat
                        </button>
                        <button type="button" aria-pressed={view === 'terminal'} data-testid="phone-lens-terminal" onClick={() => switchLens('terminal')}>
                            <TerminalSquare size={14} /> Terminal
                        </button>
                    </div>
                )}
            </header>
            <div className="phone-session-body">
                {view === 'chat' ? (
                    <ChatView
                        sessionId={session.id}
                        transport={transport}
                        fontSize={15}
                        touch={COARSE_POINTER}
                        preferences={chatPreferences}
                        readOnly={role === 'watch'}
                        canOpenFiles={role === 'drive'}
                        onSessionLink={onSessionLink}
                        onOpenTerminal={() => onLens('terminal')}
                        turnPage={PHONE_CHAT_TURN_PAGE}
                    />
                ) : (
                    // keyed: another session's terminal must not inherit this one's Type, Ctrl or line
                    <PhoneTerminal key={session.id} sessionId={session.id} deviceRole={role} />
                )}
            </div>
            {file && file.sessionId === session.id && !opensAsDocument(file) && <PhoneFilePanel key={`${file.path}:${file.line ?? ''}`} target={file} onClose={closeFile} />}
            {file && file.sessionId === session.id && opensAsDocument(file) && (
                <PhoneDocPanel
                    key={file.path}
                    target={file}
                    onClose={closeDocument}
                    // the panel it replaces cannot be gone back to: the entry already there stands for this one
                    onOpenFile={(sessionId, path) => setFile({ sessionId, path })}
                    onOpenChat={(id) => {
                        // after Back has landed: moving first, Back would undo the move
                        afterHistoryBack(() => {
                            if (id === session.id) onLens('chat')
                            else onSessionLink?.(`climanager://session/${id}`)
                        })
                        closeDocument()
                    }}
                />
            )}
        </div>
    )
}
