import { Fragment } from 'react'
import { RelatedEntry, SessionTree, TreeEntry } from '../../utils/relatedSessions'
import { SessionPeek } from '../../../../shared/types'
import { RelatedSessionRow } from './RelatedSessionRow'

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
}

type Section = {
    /** `data-related-tree`: where in the tree. */
    tree: 'up' | 'side' | 'down' | 'manual'
    /** `data-related-group`: the name the flat list used, so what already looks for it keeps working. */
    group: 'toHere' | 'side' | 'fromHere' | 'manual'
    title: string
    hint: string
    entries: Array<RelatedEntry & { indent: number }>
}

/**
 * The relation tab: who opened this session above it, who shares its parent
 * beside it, what it opened below it, then whatever was added by hand.
 * Only for the Related dialog, hence not a shared component.
 */
export function RelationTree({ tree, ownerName, peeks, selected, selectionFull, onToggle, onShow, onRemove, onCopyId }: RelationTreeProps) {
    const deepestAbove = tree.ancestors.reduce((max, entry) => Math.max(max, entry.depth), 0)
    const withIndent = (entries: TreeEntry[], indentOf: (entry: TreeEntry) => number) =>
        entries.map(entry => ({ ...entry, indent: indentOf(entry) }))

    const sections: Section[] = [
        {
            tree: 'up', group: 'toHere', title: 'Opened this session',
            hint: 'An agent there opened this session, or started working in it. Farthest first.',
            // The root sits at the edge, each step down moves in toward this session.
            entries: withIndent(tree.ancestors, entry => deepestAbove - entry.depth)
        },
        {
            tree: 'side', group: 'side', title: 'Beside this session',
            hint: 'Opened by the same session as this one.',
            entries: withIndent(tree.siblings, () => 0)
        },
        {
            tree: 'down', group: 'fromHere', title: 'Opened from this session',
            hint: 'Its agent opened them, or started working in them, through the Control API. Their own children follow, indented.',
            entries: withIndent(tree.descendants, entry => entry.depth - 1)
        },
        {
            tree: 'manual', group: 'manual', title: 'Added by hand',
            hint: 'Added in this dialog, here or in the other session. Not part of the tree: it has no direction.',
            entries: tree.manual.map(entry => ({ ...entry, indent: 0 }))
        }
    ]

    return (
        <>
            {sections.map(section => (
                <Fragment key={section.group}>
                {section.tree === 'side' && (
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
