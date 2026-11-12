import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { parseTailscaleDnsName, parseTailscaleOwner, parseTailscaleStopped } from './phoneAccess'

/**
 * What Tailscale on this Mac says about itself — read only: `tailscale status --json`.
 * The app never runs `tailscale serve`, `funnel` or `up`; Settings shows the serve
 * command for the person to run.
 *
 * Tests set CLIMANAGER_PHONE_TAILSCALE_STATUS to a JSON file (or `none`) so a test run
 * never touches the Mac's Tailscale — honored only with an isolated test userData.
 */

export interface TailscaleInfo {
    found: boolean
    owner: string | null
    dnsName: string | null
    /** installed but switched off: phones cannot reach the Mac (the cause of «why can't my phone connect?») */
    stopped: boolean
}

const CACHE_MS = 5 * 60_000
const TIMEOUT_MS = 3000
const CANDIDATES = [
    'tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale'
]

function run(binary: string): Promise<string | null> {
    return new Promise((resolve) => {
        execFile(binary, ['status', '--json'], { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
            // `status` exits 1 when logged out but still prints JSON naming no user
            resolve(stdout && stdout.trim().startsWith('{') ? stdout : error ? null : stdout)
        })
    })
}

function testStatus(): string | null | undefined {
    const file = process.env.CLIMANAGER_PHONE_TAILSCALE_STATUS
    if (!file || !process.env.CLIMANGER_TEST_USERDATA) return undefined
    if (file === 'none') return null
    try {
        return readFileSync(file, 'utf8')
    } catch {
        return null
    }
}

export class TailscaleStatus {
    private cached: { at: number; info: TailscaleInfo } | null = null
    private inflight: Promise<TailscaleInfo> | null = null

    /** Cached for five minutes; `fresh` reads again (Settings opening). */
    async read(fresh = false): Promise<TailscaleInfo> {
        if (!fresh && this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.info
        if (this.inflight) return this.inflight
        this.inflight = this.load().finally(() => {
            this.inflight = null
        })
        return this.inflight
    }

    /** The last read, without waiting (null before the first). */
    peek(): TailscaleInfo | null {
        return this.cached?.info ?? null
    }

    private async load(): Promise<TailscaleInfo> {
        const fake = testStatus()
        let json: string | null = null
        if (fake !== undefined) {
            json = fake
        } else {
            for (const binary of CANDIDATES) {
                if (binary.startsWith('/') && !existsSync(binary)) continue
                json = await run(binary)
                if (json) break
            }
        }
        const info: TailscaleInfo = { found: json !== null, owner: parseTailscaleOwner(json), dnsName: parseTailscaleDnsName(json), stopped: parseTailscaleStopped(json) }
        this.cached = { at: Date.now(), info }
        return info
    }
}
