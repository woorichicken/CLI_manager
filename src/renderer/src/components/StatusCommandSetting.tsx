interface StatusCommandSettingProps {
    command: string | undefined
    onChange: (command: string | undefined) => void
    actionCommand: string | undefined
    onActionChange: (command: string | undefined) => void
}

const INPUT_CLASS = 'w-full bg-black/20 border border-white/10 rounded px-3 py-2 text-sm text-white font-mono placeholder-gray-600 focus:outline-none focus:border-blue-500'

/**
 * Settings › General › Status command. Whatever is typed here runs in the login shell each time the
 * System Monitor opens, so it is spelled out next to the field. Empty hides the Queues section.
 * The action command is separate and off by default: without it every queue stays read only (decision 0014).
 */
export function StatusCommandSetting({ command, onChange, actionCommand, onActionChange }: StatusCommandSettingProps) {
    return (
        <div className="mt-6 pt-6 border-t border-white/10" data-setting="status-command">
            <h3 className="text-sm font-semibold text-white mb-1">Status Command</h3>
            <p className="text-xs text-gray-400 mb-3">
                Show your machine's work queues and locks in the System Monitor. The command runs in your login
                shell each time the monitor opens (never in the background) and must print a status report as
                JSON — <code className="text-gray-300">{'{ "version": 1, "sources": [...] }'}</code>. Leave it empty to hide the section.
            </p>
            <input
                type="text"
                value={command ?? ''}
                onChange={e => onChange(e.target.value.trim() ? e.target.value : undefined)}
                placeholder="queues status --json"
                spellCheck={false}
                className={INPUT_CLASS}
            />
            <p className="text-xs text-gray-400 mt-4 mb-3" data-setting="status-action-command">
                Action command (optional). Lets the Control API (<code className="text-gray-300">POST /v1/queues/…</code>) act
                on a queue row — only on rows whose report offers that action right now. The queue, row and action
                names are added as three separate arguments. Leave it empty to keep every queue read only.
            </p>
            <input
                type="text"
                value={actionCommand ?? ''}
                onChange={e => onActionChange(e.target.value.trim() ? e.target.value : undefined)}
                placeholder="queues act"
                spellCheck={false}
                className={INPUT_CLASS}
                data-status-action-command
            />
        </div>
    )
}
