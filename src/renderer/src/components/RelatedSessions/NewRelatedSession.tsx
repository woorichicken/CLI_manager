import { useState } from 'react'
import { Plus } from 'lucide-react'
import { TerminalTemplate, Workspace } from '../../../../shared/types'

/** What the sidebar's "New Terminal" menu calls a shell with nothing started in it. */
const PLAIN_TERMINAL: TerminalTemplate = {
    id: 'plain',
    name: 'Plain Terminal',
    icon: 'terminal',
    description: 'Basic terminal',
    command: ''
}

interface NewRelatedSessionProps {
    /** Preselected: where the dialog's own session lives. */
    defaultWorkspaceId: string
    workspaces: Workspace[]
    templates: TerminalTemplate[]
    onCreate: (workspaceId: string, template: TerminalTemplate, name: string) => Promise<void>
    onCancel: () => void
}

/**
 * Start a session from the Related dialog: pick the project and what runs in it,
 * the way the sidebar's "New Terminal" menu does. Only for the Related dialog,
 * hence not a shared component.
 */
export function NewRelatedSession({ defaultWorkspaceId, workspaces, templates, onCreate, onCancel }: NewRelatedSessionProps) {
    const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId)
    const [templateId, setTemplateId] = useState(PLAIN_TERMINAL.id)
    const [name, setName] = useState('')
    const [creating, setCreating] = useState(false)
    const choices = [PLAIN_TERMINAL, ...templates]
    const template = choices.find(choice => choice.id === templateId) ?? PLAIN_TERMINAL

    const create = async (): Promise<void> => {
        if (creating) return
        setCreating(true)
        try {
            await onCreate(workspaceId, template, name.trim())
        } finally {
            setCreating(false)
        }
    }

    const selectClass = 'min-w-0 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none focus:border-blue-500/50'

    return (
        <div className="px-4 py-3 border-b border-white/10 bg-white/[0.02] space-y-2" data-related-new-form>
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
                <label className="text-[11px] text-gray-500" htmlFor="related-new-workspace">Project</label>
                <select
                    id="related-new-workspace"
                    value={workspaceId}
                    onChange={e => setWorkspaceId(e.target.value)}
                    className={selectClass}
                    data-related-new-workspace
                >
                    {workspaces.map(workspace => (
                        <option key={workspace.id} value={workspace.id} className="bg-gray-900">{workspace.name}</option>
                    ))}
                </select>
                <label className="text-[11px] text-gray-500" htmlFor="related-new-template">Run</label>
                <select
                    id="related-new-template"
                    value={templateId}
                    onChange={e => setTemplateId(e.target.value)}
                    className={selectClass}
                    data-related-new-template
                >
                    {choices.map(choice => (
                        <option key={choice.id} value={choice.id} className="bg-gray-900">
                            {choice.command ? `${choice.name} — ${choice.command}` : choice.name}
                        </option>
                    ))}
                </select>
                <label className="text-[11px] text-gray-500" htmlFor="related-new-name">Name</label>
                <input
                    id="related-new-name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void create() }}
                    placeholder={template.name}
                    className={`${selectClass} placeholder-gray-600`}
                    data-related-new-name
                />
            </div>
            <div className="flex items-center gap-2">
                <span className="text-[11px] text-gray-500">Opens it and lists it here under "Added by hand".</span>
                <button
                    onClick={onCancel}
                    className="ml-auto px-2.5 py-1 rounded text-xs text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                >
                    Cancel
                </button>
                <button
                    onClick={() => void create()}
                    disabled={creating || !workspaceId}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:bg-white/5 disabled:text-gray-500 transition-colors"
                    data-related-new-create
                >
                    <Plus size={12} />
                    Create
                </button>
            </div>
        </div>
    )
}
