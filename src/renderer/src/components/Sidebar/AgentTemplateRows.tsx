import React from 'react'
import { Bot, Sparkles } from 'lucide-react'
import type { TerminalTemplate } from '../../../../shared/types'
import { builtinTemplatesFor, type AgentCli } from '../../../../shared/gettingStarted'
import { useAgentCliStatus } from '../../hooks/useAgentCliStatus'

const INSTALL_HINT: Record<AgentCli, string> = {
    claude: '`claude` was not found in your shell. Install Claude Code, then open this again. (Click to try anyway.)',
    codex: '`codex` was not found in your shell. Install Codex, then open this again. (Click to try anyway.)'
}

interface AgentTemplateRowsProps {
    /** the person's own templates — a row is left out when one of them already starts the same program */
    customTemplates: readonly TerminalTemplate[]
    onPick: (e: React.MouseEvent, template: TerminalTemplate) => void
    /** the menu's own row class, so these rows look like their neighbours */
    rowClassName: string
    iconSize: number
}

/**
 * The folder "+" menu's built-in Claude Code and Codex rows (fb-1120b). When the program is not
 * found they are drawn dim with «Not installed» — still clickable, because the check reads the
 * shell the app's terminals use and can be wrong (an install it cannot see still works).
 */
export function AgentTemplateRows({ customTemplates, onPick, rowClassName, iconSize }: AgentTemplateRowsProps) {
    const statuses = useAgentCliStatus()
    return (
        <>
            {builtinTemplatesFor(customTemplates).map(({ agent, ...template }) => {
                const missing = statuses[agent] === 'missing'
                const Icon = agent === 'claude' ? Sparkles : Bot
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
                        <Icon size={iconSize} className={`shrink-0 ${agent === 'claude' ? 'text-orange-300' : 'text-sky-300'}`} />
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
