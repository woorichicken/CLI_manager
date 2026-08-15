import React, { useEffect, useState } from 'react'
import { Gauge } from 'lucide-react'
import { UsageSnapshot, UsageWindow } from '../../../shared/types'

interface UsageIndicatorProps {
    /** Percent at which a window is treated as a warning. */
    claudeThreshold: number
    codexThreshold: number
    onOpenSettings?: () => void
}

/** Colour follows proximity to the user's own alert threshold, not a fixed scale. */
function colorFor(percent: number, threshold: number): string {
    if (percent >= 95) return 'text-red-400'
    if (threshold > 0 && percent >= threshold) return 'text-amber-400'
    return 'text-gray-400'
}

function formatReset(resetsAt: number | null): string {
    if (!resetsAt) return 'reset time unknown'

    const remainingMs = resetsAt * 1000 - Date.now()
    if (remainingMs <= 0) return 'resetting now'

    const hours = Math.floor(remainingMs / 3_600_000)
    const minutes = Math.floor((remainingMs % 3_600_000) / 60_000)

    if (hours >= 24) {
        const days = Math.floor(hours / 24)
        return `resets in ${days}d ${hours % 24}h`
    }
    if (hours > 0) return `resets in ${hours}h ${minutes}m`
    return `resets in ${minutes}m`
}

function WindowChip({
    label,
    window: usageWindow,
    threshold,
    title
}: {
    label: string
    window: UsageWindow
    threshold: number
    title: string
}) {
    return (
        <span
            className={`font-mono ${colorFor(usageWindow.usedPercent, threshold)}`}
            title={`${title}\n${formatReset(usageWindow.resetsAt)}`}
        >
            {label} {Math.round(usageWindow.usedPercent)}%
        </span>
    )
}

/**
 * Shows how much of each provider's rate limit is gone.
 *
 * Both figures come from the provider itself rather than from token estimates,
 * so they agree with `/usage` and `/status` inside the CLIs. Nothing is rendered
 * until real data arrives — an invented zero would be worse than silence when
 * the whole point is knowing when work is about to be cut off.
 */
export function UsageIndicator({ claudeThreshold, codexThreshold, onOpenSettings }: UsageIndicatorProps) {
    const [snapshot, setSnapshot] = useState<UsageSnapshot>({})

    useEffect(() => {
        let cancelled = false

        void window.api.getUsageSnapshot().then((initial) => {
            if (!cancelled) setSnapshot(initial)
        })

        const unsubscribe = window.api.onUsageUpdate((next) => setSnapshot(next))
        return () => {
            cancelled = true
            unsubscribe()
        }
    }, [])

    // Re-render on a slow tick so the "resets in" countdown stays honest.
    const [, setTick] = useState(0)
    useEffect(() => {
        const timer = setInterval(() => setTick((t) => t + 1), 60_000)
        return () => clearInterval(timer)
    }, [])

    const claude = snapshot.claude
    const codex = snapshot.codex
    if (!claude && !codex) return null

    return (
        <div
            className="flex items-center gap-2 shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
            onClick={onOpenSettings}
            title="Agent usage — click to configure alert thresholds"
        >
            <Gauge size={11} className="text-gray-500" />

            {claude && (claude.fiveHour || claude.sevenDay) && (
                <span className="flex items-center gap-1.5">
                    <span className="text-gray-500">CC</span>
                    {claude.fiveHour && (
                        <WindowChip
                            label="5h"
                            window={claude.fiveHour}
                            threshold={claudeThreshold}
                            title="Claude Code · 5-hour limit"
                        />
                    )}
                    {claude.sevenDay && (
                        <WindowChip
                            label="7d"
                            window={claude.sevenDay}
                            threshold={claudeThreshold}
                            title="Claude Code · weekly limit"
                        />
                    )}
                </span>
            )}

            {codex?.weekly && (
                <span className="flex items-center gap-1.5">
                    <span className="text-gray-500">Codex</span>
                    <WindowChip
                        label="7d"
                        window={codex.weekly}
                        threshold={codexThreshold}
                        title={`Codex · weekly limit${codex.planType ? ` (${codex.planType})` : ''}`}
                    />
                </span>
            )}
        </div>
    )
}
