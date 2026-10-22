import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { normalizeLinkScheme, sanitizeLinkSchemes } from '../utils/terminalLinks'

interface TerminalLinkSchemesSettingProps {
    schemes: string[] | undefined
    onChange: (schemes: string[]) => void
}

/**
 * Settings > Terminal section listing the app schemes (`obsidian`, …) whose
 * links may be opened from terminal output. The list starts empty on purpose:
 * whatever an agent prints reaches the allowed app as-is.
 */
export function TerminalLinkSchemesSetting({ schemes, onChange }: TerminalLinkSchemesSettingProps) {
    const current = sanitizeLinkSchemes(schemes)
    const [draft, setDraft] = useState('')
    const [error, setError] = useState<string | null>(null)

    const add = () => {
        const check = normalizeLinkScheme(draft, current)
        if (check.error !== undefined) {
            setError(check.error)
            return
        }
        onChange([...current, check.scheme])
        setDraft('')
        setError(null)
    }

    const remove = (scheme: string) => onChange(current.filter(s => s !== scheme))

    return (
        <div className="mt-6 pt-6 border-t border-white/10">
            <h3 className="text-sm font-semibold text-white mb-1">App Links in Terminal</h3>
            <p className="text-xs text-gray-400 mb-4">
                Let links like <code className="text-gray-300">obsidian://open?path=…</code> open their app on click.
                http, https, file and editor links always work.
            </p>

            <div className="flex gap-2">
                <input
                    data-testid="link-scheme-input"
                    value={draft}
                    onChange={e => {
                        setDraft(e.target.value)
                        setError(null)
                    }}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            e.preventDefault()
                            add()
                        }
                    }}
                    placeholder="e.g. obsidian"
                    className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
                <button
                    data-testid="link-scheme-add"
                    onClick={add}
                    className="flex items-center gap-1 px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-sm text-gray-300 hover:text-white rounded transition-colors"
                >
                    <Plus size={14} /> Add
                </button>
            </div>
            {error && (
                <p data-testid="link-scheme-error" className="text-xs text-red-400 mt-2">{error}</p>
            )}

            {current.length > 0 ? (
                <div className="flex flex-wrap gap-2 mt-3">
                    {current.map(scheme => (
                        <span
                            key={scheme}
                            data-testid={`link-scheme-item-${scheme}`}
                            className="flex items-center gap-1 pl-2 pr-1 py-1 bg-white/5 border border-white/10 rounded text-xs text-gray-200"
                        >
                            {scheme}://
                            <button
                                data-testid={`link-scheme-remove-${scheme}`}
                                onClick={() => remove(scheme)}
                                aria-label={`Remove ${scheme}`}
                                className="p-0.5 text-gray-500 hover:text-white rounded transition-colors"
                            >
                                <X size={12} />
                            </button>
                        </span>
                    ))}
                </div>
            ) : (
                <p className="text-xs text-gray-500 mt-3">No app links allowed yet</p>
            )}

            <p className="text-xs text-gray-500 mt-3">
                Terminal output can't be trusted — an agent can print any link, including text from a file it read.
                Add only apps whose links just open things.
            </p>
        </div>
    )
}
