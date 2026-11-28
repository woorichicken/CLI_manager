import React from 'react'
import type { TerminalTemplate } from '../../../../shared/types'
import { builtinTemplatesFor, type AgentCli } from '../../../../shared/gettingStarted'
import { useAgentCliStatus } from '../../hooks/useAgentCliStatus'
import { AgentLogo } from './AgentLogo'

const INSTALL_HINT: Record<AgentCli, string> = {
    claude: '`claude` was not found in your shell. Install Claude Code, then open this again. (Click to try anyway.)',
    codex: '`codex` was not found in your shell. Install Codex, then open this again. (Click to try anyway.)',
    agy: '`agy` was not found in your shell. Install the Antigravity CLI, then open this again. (Click to try anyway.)',
    opencode: '`opencode` was not found in your shell. Install OpenCode, then open this again. (Click to try anyway.)'
}

/** Marks drawn in the text colour need a light tint on the dark menu */
const MONO_MARK: ReadonlySet<AgentCli> = new Set<AgentCli>(['codex', 'agy', 'opencode'])

interface AgentTemplateRowsProps {
    /** the person's own templates — a row is left out when one of them already starts the same program */
    customTemplates: readonly TerminalTemplate[]
    onPick: (e: React.MouseEvent, template: TerminalTemplate) => void
    /** the menu's own row class, so these rows look like their neighbours */
    rowClassName: string
    iconSize: number
}

/**
 * The folder "+" menu's built-in Claude Code, Codex, Antigravity and OpenCode rows (fb-1120b). When the program is not
 * found they are drawn dim with «Not installed» — still clickable, because the check reads the
 * shell the app's terminals use and can be wrong (an install it cannot see still works).
 */
export function AgentTemplateRows({ customTemplates, onPick, rowClassName, iconSize }: AgentTemplateRowsProps) {
    const statuses = useAgentCliStatus()
    return (
        <>
            {builtinTemplatesFor(customTemplates).map(({ agent, ...template }) => {
                const missing = statuses[agent] === 'missing'
                return (
                    <button
                        key={template.id}
                        className={`${rowClassName}${missing ? ' opacity-50' : ''}`}
                        onClick={(e) => onPick(e, template)}
                        onMouseDown={(e) => e.stopPropagation()}
                        title={missing ? INSTALL_HINT[agent] : `${template.description} (runs \`${template.command}\`)`}
                        type="button"
                        data-builtin-template={agent}
                        data-cli-status={statuses[agent]}
                    >
                        <AgentLogo agent={agent} size={iconSize} className={`shrink-0${MONO_MARK.has(agent) ? ' text-gray-100' : ''}`} />
                        <span className="truncate">{template.name}</span>
                        {missing
                            ? <span className="ml-auto shrink-0 text-[10px] text-gray-500">Not installed</span>
                            : <span className="ml-auto shrink-0 text-[10px] text-gray-500 font-mono">{template.command}</span>}
                    </button>
                )
            })}
        </>
    )
}
