import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Cpu, MemoryStick, HardDrive, Battery, Clock, Terminal, RefreshCw, X } from 'lucide-react'
import { SystemInfo } from '../../../shared/types'
import { MENU_Z_INDEX } from '../constants/styles'
import { StatusPanelSection } from './StatusPanelSection'

const WIDTH = 260
// Queue rows carry a name, a state and a summary on one line — they need more room than the meters.
const WIDTH_WITH_STATUS = 380

interface SystemMonitorPopoverProps {
    anchorRef: React.RefObject<HTMLButtonElement | null>
    onClose: () => void
}

/**
 * System Monitor Popover
 *
 * Shows CPU, RAM, Disk, Battery, Uptime, and Terminal info.
 * Data is fetched on-demand when the popover opens (no background polling).
 */
export function SystemMonitorPopover({ anchorRef, onClose }: SystemMonitorPopoverProps) {
    const [info, setInfo] = useState<SystemInfo | null>(null)
    const [loading, setLoading] = useState(true)
    const popoverRef = useRef<HTMLDivElement>(null)
    const [statusRefreshKey, setStatusRefreshKey] = useState(0)
    const [hasStatus, setHasStatus] = useState(false)
    const width = hasStatus ? WIDTH_WITH_STATUS : WIDTH
    const handleStatusConfigured = useCallback((configured: boolean) => setHasStatus(configured), [])

    // Fetch system info when popover opens
    const fetchInfo = async () => {
        setLoading(true)
        try {
            const data = await window.api.getSystemInfo()
            setInfo(data)
        } catch (error) {
            console.error('Failed to get system info:', error)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchInfo()
    }, [])

    // Close on outside click
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (
                popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
                anchorRef.current && !anchorRef.current.contains(e.target as Node)
            ) {
                onClose()
            }
        }
        // Delay to avoid immediate close from the same click that opened it
        const timer = setTimeout(() => {
            window.addEventListener('click', handleClick)
        }, 0)
        return () => {
            clearTimeout(timer)
            window.removeEventListener('click', handleClick)
        }
    }, [onClose, anchorRef])

    // Close on Escape
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [onClose])

    // Calculate popover position based on anchor button
    const getPosition = () => {
        if (!anchorRef.current) return { top: 0, left: 0 }
        const rect = anchorRef.current.getBoundingClientRect()
        return {
            top: rect.bottom + 6,
            // Right edge stays near the button; clamp so a wide popover never leaves the window.
            left: Math.max(8, Math.min(rect.left - (width - 60) + rect.width, window.innerWidth - width - 8))
        }
    }

    const pos = getPosition()

    return createPortal(
        <div
            ref={popoverRef}
            className="fixed bg-[#1e1e20] border border-white/10 rounded-lg shadow-xl backdrop-blur-md"
            style={{ top: pos.top, left: pos.left, width, zIndex: MENU_Z_INDEX }}
            onClick={e => e.stopPropagation()}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                <span className="text-xs font-semibold text-gray-300">System Monitor</span>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => { fetchInfo(); setStatusRefreshKey(k => k + 1) }}
                        disabled={loading}
                        className="p-1 hover:bg-white/10 rounded transition-colors disabled:opacity-50"
                        title="Refresh"
                    >
                        <RefreshCw size={12} className={`text-gray-400 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={onClose}
                        className="p-1 hover:bg-white/10 rounded transition-colors"
                        title="Close"
                    >
                        <X size={12} className="text-gray-400" />
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="p-3 space-y-3">
                {loading && !info ? (
                    <div className="flex items-center justify-center py-6">
                        <RefreshCw size={16} className="text-gray-500 animate-spin" />
                        <span className="text-xs text-gray-500 ml-2">Loading...</span>
                    </div>
                ) : info ? (
                    <>
                        {/* CPU */}
                        <MonitorRow
                            icon={<Cpu size={13} />}
                            label="CPU"
                            value={`${info.cpu.usage.total}%`}
                            percent={info.cpu.usage.total}
                            detail={`${info.cpu.count} cores`}
                        />

                        {/* RAM */}
                        <MonitorRow
                            icon={<MemoryStick size={13} />}
                            label="RAM"
                            value={`${info.memory.usedGB} / ${info.memory.totalGB} GB`}
                            percent={info.memory.usagePercent}
                        />

                        {/* Disk */}
                        <MonitorRow
                            testId="disk"
                            icon={<HardDrive size={13} />}
                            label="Disk"
                            value={`${info.disk.used} / ${info.disk.total}`}
                            percent={parsePercent(info.disk.usagePercent)}
                            detail={`${info.disk.available} free`}
                        />

                        {/* Battery - only show if available */}
                        {info.battery && (
                            <MonitorRow
                                icon={<Battery size={13} />}
                                label="Battery"
                                value={`${info.battery.percent}%`}
                                percent={info.battery.percent}
                                detail={formatBatteryStatus(info.battery)}
                                color={getBatteryColor(info.battery.percent)}
                            />
                        )}

                        {/* Divider */}
                        <div className="border-t border-white/5" />

                        {/* Terminal Info */}
                        <div className="flex items-center gap-2 text-xs" data-system-monitor="sessions">
                            <Terminal size={13} className="text-gray-500 flex-shrink-0" />
                            <span className="text-gray-400">Sessions</span>
                            <span className="text-gray-200 ml-auto font-medium" data-system-monitor-total>{info.terminal.activeSessionCount}</span>
                        </div>
                        {/* Right now: the same working / waiting rule as the sidebar status dots, counted on open */}
                        <div className="flex items-center gap-2 text-xs pl-5" data-system-monitor="activity">
                            <span className="text-gray-500">Now</span>
                            <span className="ml-auto flex items-center gap-2 font-medium">
                                <span
                                    className={info.terminal.workingCount > 0 ? 'text-blue-300' : 'text-gray-500'}
                                    data-system-monitor-working={info.terminal.workingCount}
                                >
                                    {info.terminal.workingCount} working
                                </span>
                                <span className="text-gray-600">·</span>
                                <span
                                    className={info.terminal.waitingCount > 0 ? 'text-amber-300' : 'text-gray-500'}
                                    data-system-monitor-waiting={info.terminal.waitingCount}
                                >
                                    {info.terminal.waitingCount} waiting
                                </span>
                            </span>
                        </div>

                        {/* Uptime */}
                        <div className="flex items-center gap-2 text-xs">
                            <Clock size={13} className="text-gray-500 flex-shrink-0" />
                            <span className="text-gray-400">Uptime</span>
                            <span className="text-gray-200 ml-auto font-medium">{info.uptime.formatted}</span>
                        </div>
                    </>
                ) : (
                    <div className="text-xs text-gray-500 text-center py-4">
                        Failed to load system info
                    </div>
                )}
            </div>

            <StatusPanelSection refreshKey={statusRefreshKey} onConfiguredChange={handleStatusConfigured} />
        </div>,
        document.body
    )
}

// ============================================
// Sub-components
// ============================================

interface MonitorRowProps {
    icon: React.ReactNode
    label: string
    value: string
    percent: number
    detail?: string
    color?: string
    testId?: string
}

function MonitorRow({ icon, label, value, percent, detail, color, testId }: MonitorRowProps) {
    const barColor = color || getBarColor(percent)

    return (
        <div className="space-y-1" data-system-monitor={testId}>
            <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-500 flex-shrink-0">{icon}</span>
                <span className="text-gray-400">{label}</span>
                <span className="text-gray-200 ml-auto font-medium" data-system-monitor-value>{value}</span>
            </div>
            {/* Progress bar */}
            <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div
                    className={`h-full rounded-full transition-all duration-300 ${barColor}`}
                    style={{ width: `${Math.min(percent, 100)}%` }}
                />
            </div>
            {detail && (
                <div className="text-[10px] text-gray-600 pl-5" data-system-monitor-detail>{detail}</div>
            )}
        </div>
    )
}

// ============================================
// Helper functions
// ============================================

function parsePercent(value: string): number {
    const num = parseInt(value.replace('%', ''))
    return isNaN(num) ? 0 : num
}

function getBarColor(percent: number): string {
    if (percent >= 90) return 'bg-red-500'
    if (percent >= 70) return 'bg-yellow-500'
    return 'bg-blue-500'
}

function getBatteryColor(percent: number): string {
    if (percent <= 10) return 'bg-red-500'
    if (percent <= 30) return 'bg-yellow-500'
    return 'bg-green-500'
}

function formatBatteryStatus(battery: NonNullable<SystemInfo['battery']>): string {
    if (battery.status === 'charging') return 'Charging'
    if (battery.status === 'charged') return 'Fully charged'
    if (battery.powerSource === 'AC') return 'On AC power'
    return 'On battery'
}
