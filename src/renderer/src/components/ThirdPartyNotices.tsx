import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
// The repository file itself, bundled as text: the app and the repo can never say different things.
import notices from '../../../../THIRD_PARTY_NOTICES.md?raw'

/**
 * "licenses" under the version in Settings: the third-party notices (ovis,
 * TanStack Highlight) with their full license text. MIT asks for the notice in
 * every copy, and the packaged app is a copy — so it ships inside the app, not
 * only in the repository.
 */
export function ThirdPartyNotices() {
    const [open, setOpen] = useState(false)
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="text-[9px] text-blue-500 hover:text-blue-400"
                data-testid="third-party-notices-open"
            >
                licenses
            </button>
            {open &&
                createPortal(
                    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" data-testid="third-party-notices">
                        <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
                        <div className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-lg border border-white/10 bg-[#1e1e20] shadow-2xl">
                            <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
                                <span className="text-sm text-gray-200">Third-party notices</span>
                                <button type="button" onClick={() => setOpen(false)} className="p-1 text-gray-400 hover:text-white" aria-label="Close">
                                    <X size={14} />
                                </button>
                            </div>
                            <pre className="flex-1 overflow-auto p-4 text-[11px] leading-relaxed text-gray-300 whitespace-pre-wrap font-mono">{notices}</pre>
                        </div>
                    </div>,
                    document.body
                )}
        </>
    )
}
