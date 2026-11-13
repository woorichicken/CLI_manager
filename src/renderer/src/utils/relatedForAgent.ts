import type { SessionPeek } from '../../../shared/types'
import type { RelatedEntry, SessionTree } from './relatedSessions'

/** What a peek says the session is doing, in the Related dialog's words. */
function stateOf(peek: SessionPeek | undefined): string | null {
    if (!peek) return null
    if (peek.awaitingInput) return 'waiting for you'
    return { busy: 'working', idle: 'idle', starting: 'starting', exited: 'exited' }[peek.state]
}

/**
 * The Related dialog as text to paste to an agent (df23dbd0), like the checklist's "Copy for agent":
 * which sessions belong with this one, where each sits in the tree, and how the agent reaches them.
 * Sessions are named by full id — names repeat, and the MCP tools take the id.
 *
 * `picked` (the ticked rows) narrows the list to those sessions; empty means all of them.
 */
export function relatedForAgent(
    owner: { id: string; name: string },
    tree: SessionTree,
    peeks: Map<string, SessionPeek>,
    picked: string[] = []
): string {
    const keep = (entry: RelatedEntry): boolean => picked.length === 0 || picked.includes(entry.session.id)
    const line = (entry: RelatedEntry): string => {
        const state = stateOf(peeks.get(entry.session.id))
        return [`- "${entry.session.name}"`, entry.workspace.name, `id ${entry.session.id}`, state].filter(Boolean).join(' · ')
    }
    const sections: Array<[string, RelatedEntry[]]> = [
        ['Below this session (it opened them, or they were put under it)', tree.descendants],
        ['Above this session (they opened it)', tree.ancestors],
        ['Beside this session (same parent)', tree.siblings],
        ['Also related', tree.other]
    ]
    const body = sections.flatMap(([title, entries]) => {
        const rows = entries.filter(keep)
        return rows.length > 0 ? ['', `${title}:`, ...rows.map(line)] : []
    })
    return [
        `Sessions related to "${owner.name}" (id ${owner.id}) in CLI Manager`,
        ...body,
        '',
        'Read a session with the CLI Manager MCP tool read_output (session_id: its id), send it work with send_input, and wait for it with wait_for_idle. list_session_relations shows its relations.'
    ].join('\n')
}
