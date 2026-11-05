import type { Workspace } from '../shared/types'

/**
 * The order the renderer loads workspaces in (`get-workspaces`): Home first, then by
 * createdAt. The sidebar's display order starts from it; the phone's session list falls
 * back to it until the window has reported its own (phoneSetup). Sorts in place, as before.
 */
export function workspacesInLoadOrder(workspaces: Workspace[]): Workspace[] {
    return workspaces.sort((a, b) => {
        if (a.isHome) return -1
        if (b.isHome) return 1
        return a.createdAt - b.createdAt
    })
}
