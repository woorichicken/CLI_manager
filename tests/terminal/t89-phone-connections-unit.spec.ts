import { test, expect } from '@playwright/test'
import { describeBrowser, PhoneConnections } from '../../src/main/phone/phoneConnections'

/**
 * T89 — Settings › Phone lists the phones connected now (phone-fixes C-2), without Electron.
 * Before, only «Paired devices (0)» showed: the owner's own phone over Tailscale needs no pairing,
 * so a phone in use looked like none.
 */

const OWNER = { label: 'owner@example.com', kind: 'owner' as const, route: 'tailscale' as const, browser: 'Chrome · Android', role: 'drive' as const }
const DEVICE = { label: 'Galaxy M23', kind: 'device' as const, route: 'local' as const, browser: 'Samsung Internet · Android', role: 'watch' as const }
const WINDOW = 60_000

test.describe('T89 connections', () => {
    test('a request makes a connection: label, route, browser, since', () => {
        const c = new PhoneConnections(WINDOW)
        expect(c.seen('tailscale:owner', OWNER, 1_000)).toBe(true)
        expect(c.list(2_000)).toEqual([{ key: 'tailscale:owner', ...OWNER, since: new Date(1_000).toISOString(), lastSeen: new Date(1_000).toISOString(), live: false }])
        expect(c.count(2_000)).toBe(1)
    })

    test('requests while connected keep the first time; after the window it is gone, and comes back as new', () => {
        const c = new PhoneConnections(WINDOW)
        c.seen('k', OWNER, 1_000)
        expect(c.seen('k', OWNER, 30_000)).toBe(false)
        expect(c.list(40_000)[0]).toMatchObject({ since: new Date(1_000).toISOString(), lastSeen: new Date(30_000).toISOString() })
        expect(c.list(30_000 + WINDOW + 1)).toEqual([])
        expect(c.seen('k', OWNER, 200_000)).toBe(true)
        expect(c.list(200_000)[0].since).toBe(new Date(200_000).toISOString())
    })

    test('an open socket keeps it connected past the window, and live; closing starts the window again', () => {
        const c = new PhoneConnections(WINDOW)
        c.seen('d', DEVICE, 1_000)
        c.opened('d')
        expect(c.list(500_000)).toMatchObject([{ key: 'd', live: true, since: new Date(1_000).toISOString() }])
        c.opened('d')
        c.closed('d', 500_000)
        expect(c.list(500_000 + WINDOW + 5)[0]?.live).toBe(true)
        c.closed('d', 600_000)
        expect(c.list(600_000 + WINDOW - 1)).toMatchObject([{ key: 'd', live: false }])
        expect(c.list(600_000 + WINDOW + 1)).toEqual([])
    })

    test('oldest connection first; forget() drops a revoked device at once', () => {
        const c = new PhoneConnections(WINDOW)
        c.seen('b', DEVICE, 2_000)
        c.seen('a', OWNER, 1_000)
        expect(c.list(3_000).map((x) => x.key)).toEqual(['a', 'b'])
        c.forget((key) => key === 'b')
        expect(c.list(3_000).map((x) => x.key)).toEqual(['a'])
        c.clear()
        expect(c.count(3_000)).toBe(0)
    })
})

test.describe('T89 browser names from the user agent', () => {
    const cases: [string, string | null][] = [
        ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36', 'Chrome · Android'],
        ['Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-M236B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36', 'Samsung Internet · Android'],
        ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', 'Safari · iPhone'],
        ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1', 'Chrome · iPhone'],
        ['Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', 'Safari · iPad'],
        ['Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0', 'Firefox · Android'],
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0', 'Edge · Mac'],
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) cli-manager/1.26.0 Chrome/138.0 Electron/39.8.10 Safari/537.36', 'Electron · Mac'],
        ['curl/8.7.1', null],
        ['', null]
    ]
    for (const [ua, name] of cases) {
        test(`${name ?? 'unknown'} ← ${ua.slice(0, 50) || '(empty)'}`, () => expect(describeBrowser(ua)).toBe(name))
    }
})
