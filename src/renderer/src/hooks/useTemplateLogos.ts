import { useSyncExternalStore } from 'react'
import type { TerminalTemplate } from '../../../shared/types'

/**
 * Template id → logo data URL, for the sidebar rows (report 8062e68c).
 *
 * A module store rather than props: SessionItem is drawn from five lists (folder tree, worktrees,
 * All sessions list and tree, search), and each row only reads its own template's logo, so a logo
 * change re-renders the rows that show it and nothing else.
 */
let logos: ReadonlyMap<string, string> = new Map()
const listeners = new Set<() => void>()

export function publishTemplateLogos(templates: TerminalTemplate[]): void {
    const next = new Map<string, string>()
    for (const template of templates) {
        if (template.logo) next.set(template.id, template.logo)
    }
    const same = next.size === logos.size && [...next].every(([id, logo]) => logos.get(id) === logo)
    if (same) return
    logos = next
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

/** The logo of the template this session was opened from, or undefined. */
export function useTemplateLogo(templateId: string | undefined): string | undefined {
    return useSyncExternalStore(subscribe, () => (templateId ? logos.get(templateId) : undefined))
}
