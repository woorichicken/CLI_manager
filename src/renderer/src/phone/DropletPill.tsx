import { useEffect } from 'react'
import { X } from 'lucide-react'
import { DROPLET_HOLD_MS, type Droplet } from './droplets'

/**
 * One in-app alert under the header (droplets.ts says when). Tapping it opens that session's
 * chat; ✕ or time sends it away. A newer one replaces it — the list still shows every dot.
 */
export function DropletPill({ droplet, onOpen, onClose }: { droplet: Droplet; onOpen: () => void; onClose: () => void }) {
    useEffect(() => {
        const timer = window.setTimeout(onClose, DROPLET_HOLD_MS)
        return () => window.clearTimeout(timer)
    }, [droplet, onClose])

    return (
        <div className="phone-droplet" role="status" data-testid="phone-droplet" data-kind={droplet.kind} data-session-id={droplet.sessionId}>
            <button type="button" className="phone-droplet-open" data-testid="phone-droplet-open" onClick={onOpen}>
                <span className={`phone-dot phone-dot-${droplet.kind === 'waiting' ? 'waiting' : 'idle'}`} aria-hidden="true" />
                <span className="phone-droplet-text">
                    <span className="phone-droplet-name">{droplet.name}</span>
                    <span className="phone-droplet-kind">{droplet.kind === 'waiting' ? 'needs you' : 'finished'}</span>
                    {droplet.detail && <span className="phone-droplet-detail">{droplet.detail}</span>}
                </span>
            </button>
            <button type="button" className="phone-droplet-close" aria-label="Dismiss" data-testid="phone-droplet-close" onClick={onClose}>
                <X size={14} />
            </button>
        </div>
    )
}
