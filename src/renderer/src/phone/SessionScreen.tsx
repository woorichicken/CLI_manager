import { useMemo } from 'react'
import { Menu, MessageSquareText, TerminalSquare } from 'lucide-react'
import type { PhoneRole, PhoneSession } from '../../../shared/phone'
import { ChatView } from '../components/ChatView'
import { createPhoneChatTransport } from './phoneChatTransport'
import { PhoneTerminal } from './PhoneTerminal'

/**
 * One session on the phone: a header with «Chat | Terminal» (agents only; Chat first)
 * and the view under it. Chat is the desktop Chat view itself, handed the phone's
 * transport. The terminal is the Mac's own, at the Mac's size.
 */

export type SessionLens = 'chat' | 'terminal'

export function SessionScreen({
    session,
    lens,
    role,
    onLens,
    onMenu,
    showMenuButton
}: {
    session: PhoneSession
    lens: SessionLens
    role: PhoneRole
    onLens: (lens: SessionLens) => void
    onMenu: () => void
    showMenuButton: boolean
}) {
    const transport = useMemo(() => createPhoneChatTransport(), [])
    const chatAvailable = session.agent !== null
    const view: SessionLens = chatAvailable ? lens : 'terminal'

    return (
        <div className="phone-session" data-testid="phone-session" data-session-id={session.id} data-lens={view}>
            <header className="phone-header">
                {showMenuButton && (
                    <button type="button" className="phone-icon-button" aria-label="Sessions" data-testid="phone-menu-button" onClick={onMenu}>
                        <Menu size={18} />
                    </button>
                )}
                <span className={`phone-dot phone-dot-${session.state}`} aria-hidden="true" />
                <span className="phone-header-title" data-testid="phone-session-title">{session.name}</span>
                {chatAvailable && (
                    <div className="phone-seg phone-lens" role="group" aria-label="Chat or terminal">
                        <button type="button" aria-pressed={view === 'chat'} data-testid="phone-lens-chat" onClick={() => onLens('chat')}>
                            <MessageSquareText size={14} /> Chat
                        </button>
                        <button type="button" aria-pressed={view === 'terminal'} data-testid="phone-lens-terminal" onClick={() => onLens('terminal')}>
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
                        onOpenTerminal={() => onLens('terminal')}
                    />
                ) : (
                    <PhoneTerminal sessionId={session.id} deviceRole={role} />
                )}
            </div>
        </div>
    )
}
