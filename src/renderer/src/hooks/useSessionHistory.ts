import { useEffect, useState } from 'react'

/** Enough to walk back through a working session; older steps fall off. */
const MAX_HISTORY = 50

interface HistoryState {
    back: string[]
    forward: string[]
    current?: string
}

export interface SessionHistory {
    canGoBack: boolean
    canGoForward: boolean
    /** The session to show, or undefined when there is nowhere to go. */
    goBack: () => string | undefined
    goForward: () => string | undefined
}

/**
 * Back and forward through the sessions shown in the main view, like a browser.
 * Kept in memory only: it is about this sitting, not something to restore.
 * A session closed since is skipped.
 */
export function useSessionHistory(activeSessionId: string | undefined, sessionExists: (id: string) => boolean): SessionHistory {
    const [history, setHistory] = useState<HistoryState>({ back: [], forward: [] })

    // Any other way of switching (sidebar, tabs, links) starts a new branch, as a click does in a browser.
    useEffect(() => {
        if (!activeSessionId) return
        setHistory(prev => {
            if (prev.current === activeSessionId) return prev
            const back = prev.current ? [...prev.back, prev.current].slice(-MAX_HISTORY) : prev.back
            return { back, forward: [], current: activeSessionId }
        })
    }, [activeSessionId])

    const goBack = (): string | undefined => {
        const back = history.back.filter(sessionExists)
        const target = back.pop()
        if (!target) return undefined
        const forward = history.current ? [history.current, ...history.forward] : history.forward
        setHistory({ back, forward, current: target })
        return target
    }

    const goForward = (): string | undefined => {
        const forward = history.forward.filter(sessionExists)
        const target = forward.shift()
        if (!target) return undefined
        const back = history.current ? [...history.back, history.current].slice(-MAX_HISTORY) : history.back
        setHistory({ back, forward, current: target })
        return target
    }

    return {
        canGoBack: history.back.some(sessionExists),
        canGoForward: history.forward.some(sessionExists),
        goBack,
        goForward
    }
}
