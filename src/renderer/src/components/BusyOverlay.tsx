import React from 'react'
import { Loader2 } from 'lucide-react'

interface BusyOverlayProps {
    title: string
    detail?: string
}

/**
 * Full-window "working on it" screen for the moments the app cannot respond:
 * restoring every session on launch, and closing everything to install an
 * update. Without it those seconds look like a frozen window.
 *
 * The spinner animates `transform`, which Chromium runs off the main thread,
 * so it keeps turning while React mounts dozens of terminals.
 */
export const BusyOverlay: React.FC<BusyOverlayProps> = ({ title, detail }) => (
    <div
        className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-[#1e1e1e]/95 backdrop-blur-sm"
        role="status"
        aria-live="polite"
        data-busy-overlay
    >
        <Loader2 size={28} className="animate-spin text-blue-400" />
        <p className="text-sm font-medium text-gray-200">{title}</p>
        {detail && <p className="text-xs text-gray-500">{detail}</p>}
    </div>
)
