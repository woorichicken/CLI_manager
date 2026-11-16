import { useCallback, useEffect, useRef, useState } from 'react'
import type { SplitTerminalLayout, TerminalSession } from '../../../shared/types'
import { DOC_PANE_PREFIX, type DocPane, docSideBlockedReason, isDocPaneId, splitWithDoc } from '../utils/docPanes'

interface DocPanesDeps {
    splitLayout: SplitTerminalLayout | null
    setSplitLayout: (layout: SplitTerminalLayout | null) => void
    activeSplitIndex: number
    setActiveSplitIndex: (index: number) => void
    activeSession: TerminalSession | null
    setActiveSession: (session: TerminalSession | null) => void
}

/**
 * Document panes in split view (backlog 「앱 안 브라우저」 B): the preview window's Side by side puts a page into the
 * split as one more pane. Kept here, not in App.tsx — App only renders a pane for a `doc:` id and asks this hook.
 * Memory only: a restart has no document panes, as it has no split view.
 */
export function useDocPanes({ splitLayout, setSplitLayout, activeSplitIndex, setActiveSplitIndex, activeSession, setActiveSession }: DocPanesDeps) {
    const [panes, setPanes] = useState<ReadonlyMap<string, DocPane>>(new Map())
    const nextId = useRef(1)
    /** The session a document was put beside from the single view: where closing the last pane returns. */
    const returnTo = useRef<string | null>(null)

    const placeBeside = useCallback((pane: Omit<DocPane, 'source'> & { source?: boolean }): boolean => {
        const id = `${DOC_PANE_PREFIX}${nextId.current++}`
        const result = splitWithDoc(splitLayout?.sessionIds ?? null, activeSplitIndex, activeSession?.id ?? null, id)
        if (result.kind === 'full') return false
        setPanes((current) => new Map(current).set(id, { path: pane.path, line: pane.line, source: pane.source ?? false, sessionId: pane.sessionId }))
        // sizes reset: the panes are laid out again for the new count
        setSplitLayout({ ...(splitLayout ?? {}), sessionIds: result.sessionIds, sizes: undefined })
        setActiveSplitIndex(result.activeIndex)
        if (!splitLayout) {
            returnTo.current = activeSession?.id ?? null
            setActiveSession(null)
        }
        return true
    }, [splitLayout, activeSplitIndex, activeSession, setSplitLayout, setActiveSplitIndex, setActiveSession])

    const setSource = useCallback((id: string, source: boolean) => {
        setPanes((current) => {
            const pane = current.get(id)
            return pane && pane.source !== source ? new Map(current).set(id, { ...pane, source }) : current
        })
    }, [])

    /** a link inside the page to another page of its folder: the pane shows that one, drawn */
    const setPath = useCallback((id: string, path: string) => {
        setPanes((current) => {
            const pane = current.get(id)
            return pane && pane.path !== path ? new Map(current).set(id, { ...pane, path, line: undefined, source: false }) : current
        })
    }, [])

    // a pane gone from the split (closed, replaced by a session) is forgotten
    const shownIds = splitLayout?.sessionIds.filter(isDocPaneId).join(',') ?? ''
    useEffect(() => {
        const shown = new Set(shownIds ? shownIds.split(',') : [])
        setPanes((current) => ([...current.keys()].every((id) => shown.has(id)) ? current : new Map([...current].filter(([id]) => shown.has(id)))))
        if (!splitLayout) returnTo.current = null
    }, [shownIds, splitLayout])

    return {
        panes,
        placeBeside,
        setSource,
        setPath,
        /** why Side by side is off now, or null */
        blockedReason: docSideBlockedReason(splitLayout?.sessionIds ?? null),
        returnTo: () => returnTo.current
    }
}
