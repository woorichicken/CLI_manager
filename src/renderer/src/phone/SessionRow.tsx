import { useEffect, useMemo, useRef } from 'react'
import { MessageSquareText, Pin, TerminalSquare } from 'lucide-react'
import type { PhoneSession } from '../../../shared/phone'
import { createLongPress } from './longPress'
import { PhoneRenameBar } from './PhoneRenameBar'

/**
 * One session in the phone's list. A tap opens it; a press held on it (or a right-click on a wide
 * screen) renames it in place — the Mac sidebar's ⋯ → Rename, on a phone (ebf8dec6). Only for a
 * device that may type: a view-only phone's press does nothing. No delete, on purpose.
 */

const STATE_TEXT: Partial<Record<PhoneSession['state'], string>> = {
    working: 'Working…',
    stopped: 'Not running',
    exited: 'Exited'
}

/**
 * The finger that held a row lifts over the editor that replaced it: the browser's tap after it
 * (touchend → mousedown → click) would take the focus off the name box or hit ✓/✕. Cancel that
 * lift's touchend (no mouse events follow it), and eat a mousedown/click that comes anyway — until
 * a moment after the lift, however long the finger was held.
 */
const AFTER_LIFT_MS = 600
const AT_MOST_MS = 15_000

function swallowPressEnd(): void {
    let timer = 0
    const block = (event: Event): void => {
        event.preventDefault()
        event.stopPropagation()
        if (event.type === 'click') done()
    }
    const lifted = (event: Event): void => {
        if (event.type === 'touchend' && event.cancelable) event.preventDefault()
        window.clearTimeout(timer)
        timer = window.setTimeout(done, AFTER_LIFT_MS)
    }
    const done = (): void => {
        window.clearTimeout(timer)
        document.removeEventListener('touchend', lifted, true)
        document.removeEventListener('pointerup', lifted, true)
        document.removeEventListener('mousedown', block, true)
        document.removeEventListener('click', block, true)
    }
    document.addEventListener('touchend', lifted, { capture: true, passive: false })
    document.addEventListener('pointerup', lifted, true)
    document.addEventListener('mousedown', block, true)
    document.addEventListener('click', block, true)
    timer = window.setTimeout(done, AT_MOST_MS)
}

export function SessionRow({
    session,
    active,
    renaming,
    canRename,
    onOpen,
    onRename,
    onRenamed,
    onCancelRename
}: {
    session: PhoneSession
    active: boolean
    renaming: boolean
    canRename: boolean
    onOpen: (session: PhoneSession) => void
    onRename: (session: PhoneSession) => void
    onRenamed: (session: PhoneSession, kept: string) => void
    onCancelRename: () => void
}) {
    const actions = useRef({ session, canRename, onRename })
    actions.current = { session, canRename, onRename }
    const press = useMemo(
        () =>
            createLongPress(() => {
                const { session: current, canRename: may, onRename: rename } = actions.current
                if (!may) return
                swallowPressEnd()
                try {
                    navigator.vibrate?.(10)
                } catch {
                    // no vibration here: the editor opening says it
                }
                rename(current)
            }),
        []
    )
    useEffect(() => () => press.cancel(), [press])

    if (renaming) {
        return (
            <div className="phone-row-rename" data-testid="phone-row-rename" data-session-id={session.id}>
                <PhoneRenameBar
                    inline
                    sessionId={session.id}
                    name={session.name}
                    onCancel={onCancelRename}
                    onDone={(kept) => onRenamed(session, kept)}
                />
            </div>
        )
    }

    const stateText = STATE_TEXT[session.state]
    return (
        <button
            type="button"
            className="phone-row"
            data-testid="phone-session-row"
            data-session-id={session.id}
            data-state={session.state}
            aria-current={active ? 'true' : undefined}
            onPointerDown={(event) => {
                if (event.button === 0) press.down(event.clientX, event.clientY)
            }}
            onPointerMove={(event) => press.move(event.clientX, event.clientY)}
            onPointerUp={() => press.up()}
            onPointerCancel={() => press.cancel()}
            onPointerLeave={() => press.up()}
            onContextMenu={(event) => {
                // the browser's own menu (and text selection) on a held finger; a right-click on a wide screen renames
                event.preventDefault()
                if (!canRename) return
                press.cancel()
                // a held finger (Android raises this for a long press) still has its lift to come; a mouse's is over
                if ((event.nativeEvent as PointerEvent).pointerType === 'touch') swallowPressEnd()
                onRename(session)
            }}
            onClick={() => {
                if (!press.takeClick()) return
                onOpen(session)
            }}
        >
            <span className={`phone-dot phone-dot-${session.state}`} aria-hidden="true" />
            {session.agent ? <MessageSquareText size={14} className="phone-row-icon" /> : <TerminalSquare size={14} className="phone-row-icon" />}
            <span className="phone-row-text">
                <span className="phone-row-name">
                    {session.pinned && <Pin size={11} className="phone-row-pin" />}
                    {session.name}
                </span>
                <span className="phone-row-meta">
                    <span className="phone-row-workspace" data-testid="phone-row-workspace">{session.workspaceName}</span>
                    {stateText && <span className="phone-row-sub"> · {stateText}</span>}
                </span>
                {session.state === 'waiting' && <span className="phone-row-question" data-testid="phone-row-question">{session.question ?? 'Waiting for you'}</span>}
            </span>
        </button>
    )
}
