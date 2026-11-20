interface StatusCommandSettingProps {
    command: string | undefined
    onChange: (command: string | undefined) => void
}

/**
 * Settings › General › Status command. Whatever is typed here runs in the login shell each time the
 * System Monitor opens, so it is spelled out next to the field. Empty hides the Queues section.
 */
export function StatusCommandSetting({ command, onChange }: StatusCommandSettingProps) {
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
                className="w-full bg-black/20 border border-white/10 rounded px-3 py-2 text-sm text-white font-mono placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
        </div>
    )
}
