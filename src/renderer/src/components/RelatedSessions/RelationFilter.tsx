import { useRef, type KeyboardEvent } from 'react'
import type { RelatedEntry, SessionTree } from '../../utils/relatedSessions'

/** Which part of the tree the Related dialog lists (report 33f92744). `all` is the whole tree. */
export type RelationFilterKey = 'all' | 'above' | 'beside' | 'below'

export const RELATION_FILTERS: Array<{ key: RelationFilterKey; label: string; hint: string }> = [
    { key: 'all', label: 'All', hint: 'Every related session' },
    { key: 'above', label: 'Above', hint: 'Sessions above this one: what opened it, and what opened that' },
    { key: 'beside', label: 'Beside', hint: 'Sessions under the same session as this one' },
    { key: 'below', label: 'Below', hint: 'Sessions under this one, with their own children' }
]

/** The rows a filter lists. "Also related" sits outside the tree, so only All has it. */
export function entriesForFilter(tree: SessionTree, filter: RelationFilterKey): RelatedEntry[] {
    switch (filter) {
        case 'above': return tree.ancestors
        case 'beside': return tree.siblings
        case 'below': return tree.descendants
        default: return [...tree.descendants, ...tree.ancestors, ...tree.siblings, ...tree.other]
    }
}

/** The choice is a preference, like Sort: it outlives the dialog and a restart. */
const FILTER_STORAGE_KEY = 'climanager.related.filter'

export function storedRelationFilter(): RelationFilterKey {
    try {
        const value = localStorage.getItem(FILTER_STORAGE_KEY)
        return RELATION_FILTERS.some(filter => filter.key === value) ? (value as RelationFilterKey) : 'all'
    } catch {
        return 'all'
    }
}

export function storeRelationFilter(filter: RelationFilterKey): void {
    try {
        localStorage.setItem(FILTER_STORAGE_KEY, filter)
    } catch {
        // Not remembered this time; the filter still applies.
    }
}

interface RelationFilterProps {
    value: RelationFilterKey
    counts: Record<RelationFilterKey, number>
    onChange: (filter: RelationFilterKey) => void
}

/**
 * All · Above · Beside · Below, in the dialog's toolbar where the tabs used to be.
 * A radio group: Tab reaches the chosen one, ← → (and Home / End) move the choice.
 */
export function RelationFilter({ value, counts, onChange }: RelationFilterProps) {
    const buttonsRef = useRef<Array<HTMLButtonElement | null>>([])

    const choose = (index: number): void => {
        const next = RELATION_FILTERS[(index + RELATION_FILTERS.length) % RELATION_FILTERS.length]
        onChange(next.key)
        buttonsRef.current[RELATION_FILTERS.indexOf(next)]?.focus()
    }

    const onKeyDown = (e: KeyboardEvent, index: number): void => {
        const moves: Record<string, number> = {
            ArrowRight: index + 1,
            ArrowDown: index + 1,
            ArrowLeft: index - 1,
            ArrowUp: index - 1,
            Home: 0,
            End: RELATION_FILTERS.length - 1
        }
        if (!(e.key in moves)) return
        e.preventDefault()
        choose(moves[e.key])
    }

    return (
        <div className="flex items-center gap-1 min-w-0" role="radiogroup" aria-label="Show relations" data-related-filter={value}>
            {RELATION_FILTERS.map((filter, index) => {
                const checked = filter.key === value
                return (
                    <button
                        key={filter.key}
                        ref={el => { buttonsRef.current[index] = el }}
                        role="radio"
                        aria-checked={checked}
                        tabIndex={checked ? 0 : -1}
                        onClick={() => onChange(filter.key)}
                        onKeyDown={e => onKeyDown(e, index)}
                        className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border transition-colors outline-none focus-visible:ring-1 focus-visible:ring-blue-400/70 ${
                            checked
                                ? 'border-blue-500/50 bg-blue-500/15 text-blue-200'
                                : 'border-white/10 text-gray-400 hover:bg-white/5'
                        }`}
                        title={filter.hint}
                        data-related-filter-option={filter.key}
                    >
                        {filter.label}
                        <span className={checked ? 'text-blue-300/70' : 'text-gray-600'}>{counts[filter.key]}</span>
                    </button>
                )
            })}
        </div>
    )
}
