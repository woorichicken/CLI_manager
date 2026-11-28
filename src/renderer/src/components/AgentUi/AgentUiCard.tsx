import React, { Suspense, lazy, useState } from 'react'
import clsx from 'clsx'
import type { AgentUi, AgentUiActionResult } from '../../../../shared/types'

// The A2UI library (Lit, zod) loads only when a card is first drawn.
const AgentUiSurface = lazy(() => import('./AgentUiSurface'))

type CardStatus =
    | { state: 'idle' }
    | { state: 'sending' }
    | { state: 'sent' | 'queued' | 'rejected'; message: string }

const ANSWERED_MESSAGE: Record<'sent' | 'queued', string> = {
    sent: 'Answered — sent to the session',
    queued: 'Answered — it goes in when the agent finishes its turn'
}

/**
 * Colours for the A2UI basic catalog inside the app's dark panels. The library styles its parts
 * with `light-dark()` and `--a2ui-*` variables, which reach into its shadow roots.
 */
const CARD_THEME = {
    colorScheme: 'dark',
    '--a2ui-color-primary': '#3b82f6',
    '--a2ui-color-surface': 'rgba(255,255,255,0.04)',
    '--a2ui-color-border': 'rgba(255,255,255,0.12)',
    '--a2ui-color-input': 'rgba(0,0,0,0.3)',
    '--a2ui-font-family': 'inherit',
    '--a2ui-font-size-m': '12px',
    '--a2ui-font-size-s': '12px',
    '--a2ui-font-size-xs': '11px'
} as React.CSSProperties

export interface AgentUiCardProps {
    /** Stable id for the A2UI surface (the request id in the inbox). */
    surfaceId: string
    ui: AgentUi
    /** Why a press would reach no one (closed session, no agent) — the card stays readable but inert. */
    disabledReason?: string | null
    /** A button press: where it goes is the caller's business (decision 0016). */
    onAction: (componentId: string, context: Record<string, unknown>) => Promise<AgentUiActionResult>
}

class CardErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
    state = { failed: false }
    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true }
    }
    render(): React.ReactNode {
        if (this.state.failed) return <p className="text-[11px] text-red-300">Could not draw this card.</p>
        return this.props.children
    }
}

/**
 * A card an agent sent (decision 0016), drawable anywhere in the app: it knows nothing of where
 * it sits — the inbox is only its first place. One answer per card: after a press reaches the
 * session the card locks; a refused press (a question on screen, text in the input box) shows why
 * and leaves it open.
 */
export function AgentUiCard({ surfaceId, ui, disabledReason, onAction }: AgentUiCardProps) {
    const [status, setStatus] = useState<CardStatus>({ state: 'idle' })
    const answered = ui.answered ? ui.answered.status : status.state === 'sent' || status.state === 'queued' ? status.state : null
    const inert = Boolean(answered) || Boolean(disabledReason) || status.state === 'sending'

    const press = async (componentId: string, context: Record<string, unknown>): Promise<void> => {
        if (inert) return
        setStatus({ state: 'sending' })
        let result: AgentUiActionResult
        try {
            result = await onAction(componentId, context)
        } catch {
            result = { status: 'rejected', reason: 'unreachable', message: 'Could not reach the session.' }
        }
        setStatus(result.status === 'rejected' ? { state: 'rejected', message: result.message } : { state: result.status, message: ANSWERED_MESSAGE[result.status] })
    }

    const note = answered
        ? ANSWERED_MESSAGE[answered]
        : disabledReason
            ? disabledReason
            : status.state === 'rejected'
                ? status.message
                : status.state === 'sending'
                    ? 'Sending…'
                    : null

    return (
        <div
            data-testid="agent-ui-card"
            data-surface={surfaceId}
            data-state={answered ? 'answered' : status.state === 'rejected' ? 'rejected' : disabledReason ? 'disabled' : status.state}
            // Esc in a text field stays in the card (it does not close what holds it); elsewhere it goes on.
            // The fields live in the library's shadow roots, so the real target is the composed path's first node.
            onKeyDown={(e) => {
                const origin = e.nativeEvent.composedPath()[0]
                if (e.key === 'Escape' && (origin instanceof HTMLInputElement || origin instanceof HTMLTextAreaElement)) e.stopPropagation()
            }}
        >
            <div
                // The A2UI Card draws its own frame; this wrapper only carries the theme and the lock.
                className={clsx(inert && 'opacity-60 pointer-events-none')}
                style={CARD_THEME}
                aria-disabled={inert}
            >
                <CardErrorBoundary>
                    <Suspense fallback={<p className="text-[11px] text-gray-500">Loading…</p>}>
                        <AgentUiSurface surfaceId={surfaceId} ui={ui} onAction={(id, context) => void press(id, context)} />
                    </Suspense>
                </CardErrorBoundary>
            </div>
            {note && (
                <p
                    data-testid="agent-ui-status"
                    role="status"
                    className={clsx('mt-1 text-[10px]', status.state === 'rejected' && !answered ? 'text-red-300' : answered ? 'text-green-300' : 'text-gray-500')}
                >
                    {note}
                </p>
            )}
        </div>
    )
}
