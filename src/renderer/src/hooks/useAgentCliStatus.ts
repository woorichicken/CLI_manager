import { useEffect, useState } from 'react'
import type { AgentCliStatuses } from '../../../shared/gettingStarted'

const UNKNOWN: AgentCliStatuses = { claude: 'unknown', codex: 'unknown' }

// Shared by every open menu: main caches the shell check for a minute, this keeps the last answer
// so a menu opened again draws at once instead of flashing from normal to dim.
let lastKnown: AgentCliStatuses = UNKNOWN

/**
 * Whether `claude` / `codex` can start in this app's terminals — asked each time a "+" menu opens.
 * Until the answer comes, and when the check fails, rows draw as normal ('unknown').
 */
export function useAgentCliStatus(): AgentCliStatuses {
    const [statuses, setStatuses] = useState<AgentCliStatuses>(lastKnown)
    useEffect(() => {
        let alive = true
        window.api.agentCliStatus()
            .then((value) => {
                lastKnown = value
                if (alive) setStatuses(value)
            })
            .catch(() => { /* stays as it was */ })
        return () => { alive = false }
    }, [])
    return statuses
}
