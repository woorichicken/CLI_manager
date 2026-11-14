import { useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { readTemplateLogo } from '../utils/templateLogo'

interface TemplateLogoFieldProps {
    logo?: string
    onChange: (logo: string | undefined) => void
}

/**
 * Template editor: pick a small PNG/SVG logo for sessions opened from this template
 * (report 8062e68c). The picked file is shrunk right away; only the result is kept.
 */
export function TemplateLogoField({ logo, onChange }: TemplateLogoFieldProps) {
    const inputRef = useRef<HTMLInputElement>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const handleFile = async (file: File | undefined) => {
        if (!file) return
        setBusy(true)
        const result = await readTemplateLogo(file)
        setBusy(false)
        if (result.ok) {
            setError(null)
            onChange(result.dataUrl)
        } else {
            // A refused file leaves the current logo as it was.
            setError(result.error)
        }
    }

    return (
        <div>
            <label className="block text-xs text-gray-400 mb-1">Logo (optional)</label>
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded border border-white/10 bg-black/30 flex items-center justify-center shrink-0">
                    {logo ? (
                        <img src={logo} alt="Template logo" data-testid="template-logo-preview" className="w-4 h-4 object-contain" />
                    ) : (
                        <span className="text-[10px] text-gray-600">None</span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    disabled={busy}
                    data-testid="template-logo-choose"
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded transition-colors disabled:opacity-50"
                >
                    <ImagePlus size={14} />
                    {logo ? 'Change image…' : 'Choose image…'}
                </button>
                {logo && (
                    <button
                        type="button"
                        onClick={() => {
                            setError(null)
                            onChange(undefined)
                        }}
                        data-testid="template-logo-remove"
                        className="flex items-center gap-1 px-2 py-1.5 text-xs text-gray-400 hover:text-red-300 transition-colors"
                    >
                        <X size={12} />
                        Remove
                    </button>
                )}
                <input
                    ref={inputRef}
                    type="file"
                    accept="image/png,image/svg+xml,.png,.svg"
                    data-testid="template-logo-input"
                    className="hidden"
                    onChange={(e) => {
                        void handleFile(e.target.files?.[0])
                        // Picking the same file again after a refusal should fire again.
                        e.target.value = ''
                    }}
                />
            </div>
            {error ? (
                <p className="text-xs text-red-400 mt-1" data-testid="template-logo-error" role="alert">{error}</p>
            ) : (
                <p className="text-xs text-gray-500 mt-1">
                    PNG or SVG. Shown in the sidebar for sessions opened from this template from now on.
                </p>
            )}
        </div>
    )
}
