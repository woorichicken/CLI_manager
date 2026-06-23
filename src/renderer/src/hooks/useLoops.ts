import { useState, useEffect, useCallback } from 'react'
import { LoopProject, LoopSession, LoopState, LoopUpdatePayload, IPCResult } from '../../../shared/types'

// -------------------------------------------------------
// Type-safe accessor for loop APIs
// The preload may not have these methods yet if the main process has not been
// updated. We use optional-chaining + type assertions to stay safe at runtime.
// -------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loopApi = window.api as any as {
    listLoops: () => Promise<IPCResult<LoopState>>
    promoteToLoop: (workspaceId: string) => Promise<IPCResult<LoopState>>
    openLoopTerminal: (loopProjectId: string) => Promise<IPCResult<LoopSession>>
    restartLoop: (loopSessionId: string) => Promise<IPCResult<LoopSession>>
    removeLoopProject: (loopProjectId: string) => Promise<IPCResult<LoopState>>
    onLoopUpdate: (callback: (payload: LoopUpdatePayload) => void) => () => void
}

export interface UseLoopsResult {
    projects: LoopProject[]
    sessions: LoopSession[]
    /** Returns the LoopSession for a given project id, or undefined if none exists yet. */
    sessionForProject: (projectId: string) => LoopSession | undefined
    /** Call openLoopTerminal IPC for the given project. No-op if session already exists. */
    openTerminal: (projectId: string) => Promise<void>
    /** Promote a workspace to a loop project. */
    promote: (workspaceId: string) => Promise<void>
    /** Restart a stopped loop session. */
    restart: (loopSessionId: string) => Promise<void>
    /** Remove a loop project from the dashboard. */
    remove: (loopProjectId: string) => Promise<void>
}

const EMPTY_STATE: LoopState = { projects: [], sessions: [] }

export function useLoops(): UseLoopsResult {
    const [state, setState] = useState<LoopState>(EMPTY_STATE)

    // Load initial state on mount and subscribe to updates
    useEffect(() => {
        let cancelled = false

        // Initial load — guard against undefined if preload not yet updated
        if (typeof loopApi.listLoops === 'function') {
            loopApi.listLoops().then((result: IPCResult<LoopState>) => {
                if (cancelled) return
                if (result.success && result.data) {
                    setState(result.data)
                }
                // If success:false (e.g. feature not yet wired in main), stay empty
            }).catch(() => {
                // Silently stay in empty state — loop feature may not be available yet
            })
        }

        // Subscribe to push updates — guard against undefined
        let unsubscribe: (() => void) | undefined
        if (typeof loopApi.onLoopUpdate === 'function') {
            unsubscribe = loopApi.onLoopUpdate((payload: LoopUpdatePayload) => {
                if (!cancelled) {
                    setState(payload.state)
                }
            })
        }

        return () => {
            cancelled = true
            unsubscribe?.()
        }
    }, [])

    const sessionForProject = useCallback(
        (projectId: string): LoopSession | undefined =>
            state.sessions.find((s) => s.loopProjectId === projectId),
        [state.sessions]
    )

    const openTerminal = useCallback(async (projectId: string): Promise<void> => {
        if (typeof loopApi.openLoopTerminal !== 'function') return
        try {
            await loopApi.openLoopTerminal(projectId)
            // State will be updated via onLoopUpdate broadcast from main
        } catch {
            // Ignore — state will remain as-is
        }
    }, [])

    const promote = useCallback(async (workspaceId: string): Promise<void> => {
        if (typeof loopApi.promoteToLoop !== 'function') return
        try {
            await loopApi.promoteToLoop(workspaceId)
        } catch {
            // Ignore
        }
    }, [])

    const restart = useCallback(async (loopSessionId: string): Promise<void> => {
        if (typeof loopApi.restartLoop !== 'function') return
        try {
            await loopApi.restartLoop(loopSessionId)
        } catch {
            // Ignore
        }
    }, [])

    const remove = useCallback(async (loopProjectId: string): Promise<void> => {
        if (typeof loopApi.removeLoopProject !== 'function') return
        try {
            await loopApi.removeLoopProject(loopProjectId)
        } catch {
            // Ignore
        }
    }, [])

    return {
        projects: state.projects,
        sessions: state.sessions,
        sessionForProject,
        openTerminal,
        promote,
        restart,
        remove,
    }
}
