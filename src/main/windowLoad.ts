/** The part of Electron's WebContents this needs — an EventEmitter in tests. */
export interface LoadEvents {
    once(event: string, listener: (...args: any[]) => void): unknown
    on(event: string, listener: (...args: any[]) => void): unknown
    removeListener(event: string, listener: (...args: any[]) => void): unknown
}

/** Chromium's net::ERR_ABORTED — a navigation replaced by another, not a failure. */
const ERR_ABORTED = -3

/**
 * Waits until a window's page has loaded. Rejects when the main frame fails to load, or when
 * nothing happens within `timeoutMs` — a wait that never ends would hold whoever waits on it
 * (Autocron's tick is shared, so one stuck wait stops every later run).
 */
export function waitForWindowLoad(contents: LoadEvents, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const done = (): void => {
            clearTimeout(timer)
            contents.removeListener('did-finish-load', onFinish)
            contents.removeListener('did-fail-load', onFail)
        }
        const onFinish = (): void => {
            done()
            resolve()
        }
        const onFail = (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean): void => {
            if (!isMainFrame || code === ERR_ABORTED) return
            done()
            reject(new Error(`the main window did not load: ${description} (${code}) ${url}`))
        }
        const timer = setTimeout(() => {
            done()
            reject(new Error(`the main window did not load within ${Math.round(timeoutMs / 1000)} s`))
        }, timeoutMs)
        contents.once('did-finish-load', onFinish)
        contents.on('did-fail-load', onFail)
    })
}
