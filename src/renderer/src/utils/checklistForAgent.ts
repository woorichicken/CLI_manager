import type { Checklist } from '../../../shared/types'

/**
 * A checklist as text to paste to an agent (ffbfb55e): what is on it, what is done, and how the agent
 * checks an item off. By id — the title may not be unique, and the chip then shows the agent's progress.
 */
export function checklistForAgent(checklist: Checklist, projectName?: string): string {
    const about = [projectName ? `Project: ${projectName}` : null, checklist.due ? `Due: ${checklist.due}` : null].filter(Boolean).join(' · ')
    const items = checklist.items.map((item, index) => `${index + 1}. [${item.doneAt !== undefined ? 'x' : ' '}] ${item.text}`)
    return [
        `Checklist "${checklist.title}" (id ${checklist.id})`,
        ...(about ? [about] : []),
        '',
        ...items,
        '',
        `Work through the open items. When one is done, check it off with the CLI Manager MCP tool checklist_check (checklist: "${checklist.id}", item: its number).`
    ].join('\n')
}
