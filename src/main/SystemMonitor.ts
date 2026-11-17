import { exec } from 'child_process'
import { ipcMain } from 'electron'
import { SystemInfo } from '../shared/types'
import { promisify } from 'util'
import os from 'os'
import { existsSync } from 'fs'
import Store from 'electron-store'
import { MAC_DATA_VOLUME, diskCommand, parseDiskUsage } from './systemMonitorInfo'

const execAsync = promisify(exec)

/**
 * SystemMonitor - On-demand system information collector
 *
 * Collects CPU, RAM, Disk, Battery, Uptime, and Terminal info
 * only when requested (no background polling).
 * Uses Node.js os module + macOS shell commands.
 */
export class SystemMonitor {
    private store: any
    /** Working / waiting counts from the screen mirrors; read once per popover open. */
    private readonly sessionActivity: () => { working: number; waiting: number }

    constructor(store: Store, sessionActivity: () => { working: number; waiting: number } = () => ({ working: 0, waiting: 0 })) {
        this.store = store
        this.sessionActivity = sessionActivity

        // Register IPC handler - fetches data only when popover opens
        ipcMain.handle('get-system-info', async () => {
            return this.getSystemInfo()
        })
    }

    /**
     * Collect all system info in parallel for speed
     */
    private async getSystemInfo(): Promise<SystemInfo> {
        const [cpuInfo, diskInfo, batteryInfo] = await Promise.all([
            this.getCPUUsage(),
            this.getDiskInfo(),
            this.getBatteryInfo()
        ])

        // These are synchronous (Node.js os module) - no need to await
        const memoryInfo = this.getMemoryInfo()
        const uptimeInfo = this.getUptimeInfo()
        const terminalInfo = this.getTerminalInfo()

        return {
            cpu: cpuInfo,
            memory: memoryInfo,
            disk: diskInfo,
            battery: batteryInfo,
            uptime: uptimeInfo,
            terminal: terminalInfo
        }
    }

    /**
     * CPU usage via macOS `top` command
     * Returns real-time percentage (user/sys/idle)
     */
    private async getCPUUsage(): Promise<SystemInfo['cpu']> {
        const cpus = os.cpus()
        const defaultCpu: SystemInfo['cpu'] = {
            model: cpus[0]?.model || 'Unknown',
            count: cpus.length,
            usage: { user: 0, sys: 0, idle: 100, total: 0 }
        }

        try {
            // top -l 1 -n 0: single snapshot, no process list (faster)
            const { stdout } = await execAsync('top -l 1 -n 0', { timeout: 5000 })
            const cpuMatch = stdout.match(/CPU usage: ([\d.]+)%\s+user,\s+([\d.]+)%\s+sys,\s+([\d.]+)%\s+idle/)

            if (cpuMatch) {
                const user = parseFloat(cpuMatch[1])
                const sys = parseFloat(cpuMatch[2])
                const idle = parseFloat(cpuMatch[3])
                return {
                    ...defaultCpu,
                    usage: { user, sys, idle, total: Math.round((user + sys) * 10) / 10 }
                }
            }
        } catch (error) {
            console.error('[SystemMonitor] Failed to get CPU usage:', error)
        }

        return defaultCpu
    }

    /**
     * Memory info via Node.js os module (built-in, fast)
     */
    private getMemoryInfo(): SystemInfo['memory'] {
        const total = os.totalmem()
        const free = os.freemem()
        const used = total - free

        return {
            totalGB: (total / 1024 / 1024 / 1024).toFixed(1),
            usedGB: (used / 1024 / 1024 / 1024).toFixed(1),
            freeGB: (free / 1024 / 1024 / 1024).toFixed(1),
            usagePercent: Math.round((used / total) * 100)
        }
    }

    /**
     * Disk usage via `df`, read from the data volume on macOS — `/` is the sealed system
     * volume and reports a few GB used on a nearly full disk (fb-1117 9aebd089).
     */
    private async getDiskInfo(): Promise<SystemInfo['disk']> {
        const defaultDisk: SystemInfo['disk'] = {
            total: '-', used: '-', available: '-', usagePercent: '-'
        }

        try {
            const { stdout } = await execAsync(diskCommand(existsSync(MAC_DATA_VOLUME)), { timeout: 3000 })
            return parseDiskUsage(stdout) ?? defaultDisk
        } catch (error) {
            console.error('[SystemMonitor] Failed to get disk info:', error)
        }

        return defaultDisk
    }

    /**
     * Battery info via macOS `pmset` command
     * Returns null for desktop Macs (iMac, Mac mini, Mac Pro)
     */
    private async getBatteryInfo(): Promise<SystemInfo['battery']> {
        try {
            const { stdout } = await execAsync('pmset -g batt', { timeout: 3000 })

            const powerSource = stdout.includes('AC Power') ? 'AC' as const : 'Battery' as const
            const batteryMatch = stdout.match(/(\d+)%/)
            const statusMatch = stdout.match(/(charging|discharging|charged)/)

            // If no battery percentage found, this is likely a desktop Mac
            if (!batteryMatch) return null

            return {
                percent: parseInt(batteryMatch[1]),
                status: (statusMatch ? statusMatch[1] : 'unknown') as SystemInfo['battery'] extends null ? never : NonNullable<SystemInfo['battery']>['status'],
                powerSource
            }
        } catch {
            // No battery available (desktop Mac)
            return null
        }
    }

    /**
     * System uptime via Node.js os module (built-in)
     */
    private getUptimeInfo(): SystemInfo['uptime'] {
        const seconds = os.uptime()
        const days = Math.floor(seconds / 86400)
        const hours = Math.floor((seconds % 86400) / 3600)
        const minutes = Math.floor((seconds % 3600) / 60)

        let formatted = ''
        if (days > 0) formatted += `${days}d `
        formatted += `${hours}h ${minutes}m`

        return { formatted: formatted.trim(), seconds }
    }

    /**
     * Terminal session/workspace counts from electron-store
     */
    private getTerminalInfo(): SystemInfo['terminal'] {
        try {
            const workspaces = this.store.get('workspaces') as any[] || []
            // Count only non-worktree workspaces
            const workspaceCount = workspaces.filter((w: any) => !w.parentWorkspaceId).length
            // Count all sessions across all workspaces
            const activeSessionCount = workspaces.reduce(
                (sum: number, w: any) => sum + (w.sessions?.length || 0), 0
            )

            const { working, waiting } = this.readSessionActivity()
            return { activeSessionCount, workspaceCount, workingCount: working, waitingCount: waiting }
        } catch {
            return { activeSessionCount: 0, workspaceCount: 0, workingCount: 0, waitingCount: 0 }
        }
    }

    /** A bad screen read must not cost the whole popover its numbers. */
    private readSessionActivity(): { working: number; waiting: number } {
        try {
            return this.sessionActivity()
        } catch (error) {
            console.error('[SystemMonitor] Failed to read session activity:', error)
            return { working: 0, waiting: 0 }
        }
    }
}
