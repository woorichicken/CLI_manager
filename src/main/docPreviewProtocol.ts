import { ipcMain, protocol, type WebContents } from 'electron'
import { DOC_PREVIEW_SCHEME } from '../shared/docPreview'
import { DocPreviewTokens, openDocPreview, serveDocPreview } from './docPreview'

/**
 * Wiring for the Mac's document frame (decision 0013). `registerDocPreviewScheme` must run before the app is ready —
 * Electron reads privileged schemes once, so this is the only call that may register one.
 */
export function registerDocPreviewScheme(): void {
    protocol.registerSchemesAsPrivileged([
        // standard: relative addresses resolve inside the folder. secure: the page is not "mixed content".
        // corsEnabled: a font or module beside the page is a CORS request from the `null` origin.
        // Not supportFetchAPI and not bypassCSP: the page's own fetch stays refused by its policy.
        { scheme: DOC_PREVIEW_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true, stream: true } }
    ])
}

const tokens = new DocPreviewTokens()

/** After ready: the scheme's answers and the renderer's way to ask for a document. */
export function setupDocPreview(): void {
    protocol.handle(DOC_PREVIEW_SCHEME, (request) => serveDocPreview(request.url, request.method, tokens))
    ipcMain.handle('doc-preview-open', (_event, target: unknown) => openDocPreview(target, tokens))
}

/**
 * A document's frame moves only inside its own scheme. The window's CSP already refuses other addresses (`frame-src`);
 * this is the same rule held in main, where a page cannot reach it.
 */
export function guardDocPreviewFrames(contents: WebContents): void {
    contents.on('will-frame-navigate', (event) => {
        if (event.isMainFrame) return
        const from = event.frame?.url ?? ''
        if (from.startsWith(`${DOC_PREVIEW_SCHEME}:`) && !event.url.startsWith(`${DOC_PREVIEW_SCHEME}:`)) event.preventDefault()
    })
}
