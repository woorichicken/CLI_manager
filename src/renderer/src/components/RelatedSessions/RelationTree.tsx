import { Fragment } from 'react'
import { RelatedEntry, SessionTree, TreeEntry } from '../../utils/relatedSessions'
import { SessionPeek } from '../../../../shared/types'
import { RelatedSessionRow } from './RelatedSessionRow'
import type { RelationFilterKey } from './RelationFilter'

interface RelationTreeProps {
    tree: SessionTree
    ownerName: string
    peeks: Map<string, SessionPeek>
    selected: string[]
    selectionFull: boolean
    onToggle: (sessionId: string) => void
    onShow: (sessionId: string) => void
    onRemove: (sessionId: string) => void
    onCopyId: (sessionId: string) => void
    /** Only this part of the tree; `all` (the default) is every section. */
    filter?: RelationFilterKey
}

type Section = {
    /** `data-related-tree`: where in the tree. */
    tree: 'up' | 'side' | 'down' | 'other'
    /** `data-related-group`: the name the flat list used, so what already looks for it keeps working. */
    group: 'toHere' | 'side' | 'fromHere' | 'other'
    title: string
    hint: string
    entries: Array<RelatedEntry & { indent: number }>
}

/** The section a filter keeps. "Also related" sits outside the tree, so only All lists it. */
const SECTION_FOR_FILTER: Record<Exclude<RelationFilterKey, 'all'>, Section['tree']> = {
    above: 'up',
    beside: 'side',
    below: 'down'
}

const EMPTY_FILTER_TEXT: Record<Exclude<RelationFilterKey, 'all'>, string> = {
    above: 'Nothing above this session: no session opened it or had it dropped on it.',
    beside: 'Nothing beside this session: no other session sits under the same one.',
    below: 'Nothing below this session: it has not opened a session, and none was dropped on it.'
}

/**
 * The relation tab: its children first — what the person usually comes here
 * for (474b70f8) — then its parents, who shares its parent, and the related
 * sessions the tree places elsewhere. Only for the Related dialog, hence not a
 * shared component.
 */
export function RelationTree({ tree, ownerName, peeks, selected, selectionFull, onToggle, onShow, onRemove, onCopyId, filter = 'all' }: RelationTreeProps) {
    const deepestAbove = tree.ancestors.reduce((max, entry) => Math.max(max, entry.depth), 0)
    const withIndent = (entries: TreeEntry[], indentOf: (entry: TreeEntry) => number) =>
        entries.map(entry => ({ ...entry, indent: indentOf(entry) }))

    const sections: Section[] = [
        {
            tree: 'down', group: 'fromHere', title: 'Below this session',
            hint: 'Its agent opened them or started working in them, or they were dragged onto it or added here by hand. Their own children follow, indented.',
            entries: withIndent(tree.descendants, entry => entry.depth - 1)
        },
        {
            tree: 'up', group: 'toHere', title: 'Above this session',
            hint: 'An agent there opened this session or started working in it, or this session was dragged onto it by hand. Farthest first.',
            // The root sits at the edge, each step down moves in toward this session.
            entries: withIndent(tree.ancestors, entry => deepestAbove - entry.depth)
        },
        {
            tree: 'side', group: 'side', title: 'Beside this session',
            hint: 'Under the same session as this one.',
            entries: withIndent(tree.siblings, () => 0)
        },
        {
            tree: 'other', group: 'other', title: 'Also related',
            hint: 'Related to this session, but the tree places them under another session: a session dragged onto a row by hand sits only there.',
            entries: tree.other.map(entry => ({ ...entry, indent: 0 }))
        }
    ]

    const shown = filter === 'all' ? sections : sections.filter(section => section.tree === SECTION_FOR_FILTER[filter])
    // "This session" marks where the tree turns from above to beside; Below starts at this session, so it goes there.
    const showSelf = filter === 'all' || filter === 'above' || filter === 'beside'

    return (
        <>
            {filter !== 'all' && shown.every(section => section.entries.length === 0) && (
                <div className="px-4 py-6 text-center text-xs text-gray-500" data-related-filter-empty={filter}>
                    {EMPTY_FILTER_TEXT[filter]}
                </div>
            )}
            {shown.map(section => (
                <Fragment key={section.group}>
                {section.tree === 'side' && showSelf && (
                    <div className="px-4 py-1 text-[11px] text-blue-300/80 truncate" data-related-self>
                        ▸ {ownerName} (this session)
                    </div>
                )}
                {section.entries.length > 0 && (
                <div data-related-group={section.group} data-related-tree={section.tree}>
                    <div className="px-4 pt-2 pb-1 text-[11px] uppercase tracking-wide text-gray-500" title={section.hint}>
                        {section.title}
                    </div>
                    {section.entries.map(entry => (
                        <RelatedSessionRow
                            key={entry.session.id}
                            entry={entry}
                            indent={entry.indent}
                            peek={peeks.get(entry.session.id)}
                            selected={selected.includes(entry.session.id)}
                            selectionFull={selectionFull}
                            onToggle={onToggle}
                            onShow={onShow}
                            onRemove={onRemove}
                            onCopyId={onCopyId}
                        />
                    ))}
                </div>
                )}
                </Fragment>
            ))}
        </>
    )
}
