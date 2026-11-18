import { useEffect, useRef } from 'react'
import { MoreHorizontal, Pencil, StickyNote } from 'lucide-react'
import type { PhoneSession } from '../../../shared/phone'

/**
 * The ⋯ at the end of a session row and its small menu (f683eafe): what a held press used to hide,
 * in plain sight — Rename, and Memo when the session has one. Only for a device that may type; the
 * held press still renames. No end or delete here: the phone neither makes nor removes sessions
 * (decision 0009).
 */
export function SessionRowMenu({
    session,
    open,
    onToggle,
    onClose,
    onRename,
    onMemo
}: {
    session: PhoneSession
    open: boolean
    onToggle: () => void
    onClose: () => void
    onRename: () => void
    onMemo: () => void
}) {
    const box = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!open) return
        // a tap anywhere else, or Escape, closes it — as the Mac's context menus do (540ceb60)
        const away = (event: Event): void => {
            if (box.current && !box.current.contains(event.target as Node)) onClose()
        }
        const key = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') onClose()
        }
        document.addEventListener('pointerdown', away, true)
        document.addEventListener('keydown', key)
        return () => {
            document.removeEventListener('pointerdown', away, true)
            document.removeEventListener('keydown', key)
        }
    }, [open, onClose])

    return (
        <div className="phone-row-menu" ref={box}>
            <button
                type="button"
                className="phone-row-more"
                aria-label={`More for ${session.name}`}
                aria-haspopup="menu"
                aria-expanded={open}
                data-testid="phone-row-more"
                data-session-id={session.id}
                onClick={onToggle}
            >
                <MoreHorizontal size={16} />
            </button>
            {open && (
                <div className="phone-row-menu-list" role="menu" data-testid="phone-row-menu" data-session-id={session.id}>
                    <button type="button" role="menuitem" data-testid="phone-row-menu-rename" onClick={onRename}>
                        <Pencil size={14} aria-hidden="true" />
                        Rename
                    </button>
                    {session.memoPages !== undefined && (
                        <button type="button" role="menuitem" data-testid="phone-row-menu-memo" onClick={onMemo}>
                            <StickyNote size={14} aria-hidden="true" />
                            Memo
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}
