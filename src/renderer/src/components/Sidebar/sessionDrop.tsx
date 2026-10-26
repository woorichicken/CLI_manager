import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Waypoints } from 'lucide-react'

/** The HTML5 drag type a session row carries (the split view's drop zone reads it too). */
export const SESSION_DRAG_TYPE = 'application/x-session-id'

const NOTICE_VISIBLE_MS = 2200

/**
 * What a sidebar session row needs to take another session dropped on it
 * (report 269168e4). The sidebar provides it, so the rows in the workspace tree,
 * the All sessions list and the search results all behave the same.
 */
export interface SessionDropContextValue {
    /** The session row being dragged, or null when no session drag is going on. */
    draggingId: string | null
    beginDrag: (sessionId: string) => void
    endDrag: () => void
    /** `draggedId` was dropped on the row of `targetId`: list the two in each other's Related sessions. */
    onRelate: (targetId: string, draggedId: string) => void
}

export const SessionDropContext = createContext<SessionDropContextValue | null>(null)

export function useSessionDrop(): SessionDropContextValue | null {
    return useContext(SessionDropContext)
}

export function isSessionDrag(e: React.DragEvent): boolean {
    return e.dataTransfer.types.includes(SESSION_DRAG_TYPE)
}

/**
 * Highlight state for a drop target. `dragleave` also fires when the pointer
 * moves onto a child of the target, so only leaving the target itself clears it.
 */
export function useDropHighlight(active: boolean) {
    const [over, setOver] = useState(false)
    // A drag that ends anywhere (Esc, a drop elsewhere) leaves no dragleave behind.
    useEffect(() => {
        if (!active) setOver(false)
    }, [active])
    const enter = useCallback(() => setOver(true), [])
    const leave = useCallback((e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
    }, [])
    const clear = useCallback(() => setOver(false), [])
    return { over, enter, leave, clear }
}

/** A line at the bottom of the sidebar saying what a drop did; a drop has no other visible trace there. */
export function useDropNotice() {
    const [text, setText] = useState<string | null>(null)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current)
    }, [])
    const show = useCallback((next: string) => {
        setText(next)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setText(null), NOTICE_VISIBLE_MS)
    }, [])
    return { text, show }
}

export function DropNotice({ text }: { text: string | null }) {
    if (!text) return null
    return (
        <div
            data-testid="sidebar-drop-notice"
            className="absolute left-2 right-2 bottom-2 z-40 flex items-center gap-1.5 px-2 py-1.5 rounded border border-white/10 bg-[#1e1e20] shadow-xl text-xs pointer-events-none"
        >
            <Waypoints size={12} className="text-emerald-400 shrink-0" />
            <span className="text-gray-300 truncate min-w-0">{text}</span>
        </div>
    )
}
