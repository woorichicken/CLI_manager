import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { TerminalTemplate, Workspace } from '../../../shared/types'

/** What the sidebar's "New Terminal" menu calls a shell with nothing started in it. */
const PLAIN_TERMINAL: TerminalTemplate = {
    id: 'plain',
    name: 'Plain Terminal',
    icon: 'terminal',
    description: 'Basic terminal',
    command: ''
}

interface NewSessionDialogProps {
    /** Preselected project: where the caller's own session lives. */
    defaultWorkspaceId: string
    workspaces: Workspace[]
    templates: TerminalTemplate[]
    onCreate: (workspaceId: string, template: TerminalTemplate, name: string) => Promise<void>
    onCancel: () => void
    /** One line under the fields saying where the new session will show up. */
    note: string
    /**
     * `parent` covers the positioned element it sits in (the Related dialog, which
     * handles Esc itself so Esc closes this first). `window` covers the whole window
     * (All sessions in the sidebar) and closes on Esc on its own.
     */
    overlay?: 'parent' | 'window'
    /** Which surface opened it — for tests and reports. */
    source: 'related' | 'all-sessions'
}

/**
 * Start a session: pick the project and what runs in it, the way the sidebar's
 * "New Terminal" menu does, and name it. Opened from the Related dialog and from
 * the All sessions list (report c63a93c0), so both make sessions the same way.
 * The `data-related-new-*` hooks predate the second caller and are kept as they are.
 */
export function NewSessionDialog({ defaultWorkspaceId, workspaces, templates, onCreate, onCancel, note, overlay = 'parent', source }: NewSessionDialogProps) {
    const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId)
    const [templateId, setTemplateId] = useState(PLAIN_TERMINAL.id)
    const [name, setName] = useState('')
    const [creating, setCreating] = useState(false)
    const choices = [PLAIN_TERMINAL, ...templates]
    const template = choices.find(choice => choice.id === templateId) ?? PLAIN_TERMINAL

    useEffect(() => {
        if (overlay !== 'window') return
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') onCancel()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [overlay, onCancel])

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
    const layerClass = overlay === 'window' ? 'fixed inset-0 z-50' : 'absolute inset-0 z-10'

    return (
        <div className={`${layerClass} flex items-center justify-center px-4`} role="dialog" aria-label="New session" data-new-session-dialog={source}>
            <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onCancel} />
            <div className="relative w-full max-w-md glass-panel rounded-lg shadow-2xl border border-white/10 px-4 py-3 space-y-3" data-related-new-form>
            <div className="text-sm text-white">New session</div>
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
                    autoFocus
                />
            </div>
            <div className="flex items-center gap-2">
                <span className="text-[11px] text-gray-500">{note}</span>
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
        </div>
    )
}
