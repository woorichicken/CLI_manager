import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Activity, Filter, Folder, XCircle, RefreshCw } from 'lucide-react'
import { PortInfo, UsageAlertSettings, DEFAULT_USAGE_ALERTS } from '../../../shared/types'
import { UsageIndicator } from './UsageIndicator'

interface PortFilter {
    enabled: boolean
    minPort: number
    maxPort: number
}

interface StatusBarProps {
    portFilter?: {
        enabled: boolean
        minPort: number
        maxPort: number
    }
    ignoredPorts?: number[]
    ignoredProcesses?: string[]
    onIgnorePort: (port: number) => void
    onIgnoreProcess: (processName: string, port: number) => void
    onKillProcess: (pid: number, port: number) => void
    onOpenSettings?: () => void
    /** Separate from onOpenSettings: usage opens the agent section, not ports. */
    onOpenUsageSettings?: () => void
    usageAlerts?: UsageAlertSettings
}

export function StatusBar({
    portFilter,
    ignoredPorts = [],
    ignoredProcesses = [],
    onIgnorePort,
    onIgnoreProcess,
    onKillProcess,
    onOpenSettings,
    onOpenUsageSettings,
    usageAlerts = DEFAULT_USAGE_ALERTS
}: StatusBarProps) {
    const [ports, setPorts] = useState<PortInfo[]>([])
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, port: PortInfo } | null>(null)
    const [isRefreshing, setIsRefreshing] = useState(false)

    useEffect(() => {
        // Subscribe to port updates
        const unsubscribe = window.api.onPortUpdate((updatedPorts) => {
            setPorts(updatedPorts)
        })

        // Cleanup subscription
        return () => {
            unsubscribe()
        }
    }, [])

    // Close context menu on click outside
    useEffect(() => {
        const handleClickOutside = () => setContextMenu(null)
        window.addEventListener('click', handleClickOutside)
        return () => window.removeEventListener('click', handleClickOutside)
    }, [])

    const handleContextMenu = (e: React.MouseEvent, port: PortInfo) => {
        e.preventDefault()
        const menuWidth = 140
        const menuHeight = port.cwd ? 110 : 85
        const padding = 4

        // Position near the cursor while keeping the menu inside the viewport.
        let x = e.clientX + padding
        let y = e.clientY + padding

        if (x + menuWidth > window.innerWidth) {
            x = Math.max(padding, e.clientX - menuWidth - padding)
        }
        if (y + menuHeight > window.innerHeight) {
            y = Math.max(padding, e.clientY - menuHeight - padding)
        }

        setContextMenu({ x, y, port })
    }

    const handleKillProcess = async () => {
        if (contextMenu) {
            onKillProcess(contextMenu.port.pid, contextMenu.port.port)
            setContextMenu(null)
        }
    }

    const handleIgnorePort = () => {
        if (contextMenu) {
            onIgnorePort(contextMenu.port.port)
            setContextMenu(null)
        }
    }

    const handleIgnoreProcess = () => {
        if (contextMenu) {
            const processName = getProcessName(contextMenu.port.cwd)
            if (processName) {
                onIgnoreProcess(processName, contextMenu.port.port)
            }
            setContextMenu(null)
        }
    }

    const getProcessName = (cwd?: string) => {
        if (!cwd) return ''
        const parts = cwd.split('/')
        return parts[parts.length - 1]
    }

    const handleRefresh = async () => {
        if (isRefreshing) return // 이미 새로고침 중이면 무시

        setIsRefreshing(true)

        // 3초 후에 무조건 멈추는 타임아웃
        const timeout = setTimeout(() => {
            setIsRefreshing(false)
        }, 3000)

        try {
            await window.api.refreshPorts()
        } catch (e) {
            console.error('Failed to refresh ports:', e)
        }

        // 완료 후 타임아웃 취소하고 애니메이션 딜레이 후 멈춤
        clearTimeout(timeout)
        setTimeout(() => setIsRefreshing(false), 500)
    }

    const filteredPorts = ports.filter(p => {
        // Filter by port range if enabled
        if (portFilter?.enabled) {
            if (p.port < portFilter.minPort || p.port > portFilter.maxPort) {
                return false
            }
        }
        
        // Filter ignored ports
        if (ignoredPorts.includes(p.port)) {
            return false
        }

        // Filter ignored processes
        const processName = getProcessName(p.cwd)
        if (processName && ignoredProcesses.includes(processName)) {
            return false
        }

        return true
    })

    return (
        <div className="h-6 bg-[#1e1e20] border-t border-white/10 flex items-center px-3 text-[10px] select-none relative">
            <div className="flex items-center gap-4 w-full">
                <div className="flex items-center gap-1.5 text-gray-400 shrink-0">
                    <Activity size={12} className="text-green-400" />
                    <span>Active Ports:</span>
                    <button
                        onClick={handleRefresh}
                        className="p-0.5 hover:bg-white/10 rounded transition-colors"
                        title="Refresh ports"
                        disabled={isRefreshing}
                    >
                        <RefreshCw
                            size={10}
                            className={`text-gray-500 hover:text-gray-300 ${isRefreshing ? 'animate-spin' : ''}`}
                        />
                    </button>
                    {portFilter?.enabled && (
                        <div
                            onClick={onOpenSettings}
                            className="flex items-center gap-1 text-gray-500 hover:text-blue-400 cursor-pointer transition-colors"
                            title="Click to configure port range"
                        >
                            <Filter size={10} />
                            <span>{portFilter.minPort}-{portFilter.maxPort}</span>
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-3 overflow-x-auto whitespace-nowrap min-w-0 flex-1">
                    {filteredPorts.map(p => (
                        <div
                            key={`${p.port}-${p.pid}`}
                            className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-white/5 cursor-context-menu transition-colors group relative"
                            title={`PID: ${p.pid}\nCommand: ${p.command}\nPath: ${p.cwd || 'Unknown'}\nClick to open in browser`}
                            onContextMenu={(e) => handleContextMenu(e, p)}
                        >
                            <span
                                className="text-blue-300 font-mono font-medium hover:text-blue-200 hover:underline cursor-pointer"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    window.api.openExternal(`http://localhost:${p.port}/`)
                                }}
                            >
                                {p.port}
                            </span>
                            {p.cwd && (
                                <span className="flex items-center gap-1 text-gray-500 group-hover:text-gray-300">
                                    <Folder size={10} />
                                    <span>{getProcessName(p.cwd)}</span>
                                </span>
                            )}
                        </div>
                    ))}
                    {filteredPorts.length === 0 && (
                        <span className="text-gray-600 italic">No active ports detected</span>
                    )}
                </div>
                <UsageIndicator
                    claudeThreshold={usageAlerts.claudeThresholdPercent}
                    codexThreshold={usageAlerts.codexThresholdPercent}
                    onOpenSettings={onOpenUsageSettings}
                />
            </div>

            {/* Custom Context Menu - 클릭 위치 바로 위에 표시 (메뉴 높이 약 130px) */}
            {contextMenu && createPortal(
                <div
                    className="fixed z-50 bg-[#252526] border border-white/10 rounded shadow-xl py-0.5 min-w-[140px]"
                    style={{
                        top: contextMenu.y,
                        left: contextMenu.x
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="px-2 py-1 text-[10px] text-gray-400 border-b border-white/5 mb-0.5">
                        Port {contextMenu.port.port} ({getProcessName(contextMenu.port.cwd)})
                    </div>
                    <button 
                        onClick={handleKillProcess}
                        className="w-full text-left px-2 py-1 text-xs text-red-400 hover:bg-white/5 flex items-center gap-1.5"
                    >
                        <XCircle size={12} />
                        Kill Process
                    </button>
                    <button 
                        onClick={handleIgnorePort}
                        className="w-full text-left px-2 py-1 text-xs text-gray-300 hover:bg-white/5 flex items-center gap-1.5"
                    >
                        <Filter size={12} />
                        Ignore Port {contextMenu.port.port}
                    </button>
                    {contextMenu.port.cwd && (
                        <button 
                            onClick={handleIgnoreProcess}
                            className="w-full text-left px-2 py-1 text-xs text-gray-300 hover:bg-white/5 flex items-center gap-1.5"
                        >
                            <Folder size={12} />
                            Ignore '{getProcessName(contextMenu.port.cwd)}'
                        </button>
                    )}
                </div>,
                document.body
            )}
        </div>
    )
}
