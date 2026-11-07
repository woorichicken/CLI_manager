import { useEffect, useMemo, useRef } from 'react'
import type { PhoneDocMessage } from '../../../shared/phone'
import { PHONE_DOC_SANDBOX } from '../../../shared/phone'
import { docStoreKey, frameAddress, fromDocFrame, parseDocMessage, phoneDocStorage, readDocStore } from './docMessages'

/**
 * The document, in a frame whose code has no origin of its own: it cannot read this page, call the phone API or leave
 * the frame (decision 0011). It can only post messages here, and those are read as what a stranger says.
 *
 * A page has its kept comments only if they come in its address, and a link or a script inside the frame brings none. So
 * a page that arrives without them, when some are kept, is loaded again with them; until then what it stores is not kept,
 * or an empty page would overwrite them.
 */
export function PhoneDocFrame({ url, rel, storeKey, title, inert, onMessage }: { url: string; rel: string; storeKey: string; title: string; inert: boolean; onMessage: (message: PhoneDocMessage) => void }) {
    const frame = useRef<HTMLIFrameElement>(null)
    const handler = useRef(onMessage)
    handler.current = onMessage
    const reloading = useRef(false)
    // once: a new address would reload the page and lose what is being written
    const address = useMemo(() => frameAddress(url, readDocStore(storeKey, phoneDocStorage())), [url, storeKey])
    useEffect(() => {
        const folder = url.slice(0, url.lastIndexOf('/') + 1)
        const listen = (event: MessageEvent): void => {
            const page = frame.current?.contentWindow
            if (!fromDocFrame(event.source, event.origin, page)) return
            const message = parseDocMessage(event.data)
            if (!message) return
            if (message.type === 'doc-ready') {
                const kept = message.seeded ? '' : readDocStore(docStoreKey(storeKey, rel, message.path), phoneDocStorage())
                if (kept) {
                    if (!reloading.current) {
                        reloading.current = true
                        const target = `${folder}${message.path.split('/').map(encodeURIComponent).join('/')}`
                        // a frame's Location can be replaced from outside it; replace adds no stop to the panel's back
                        page?.location.replace(frameAddress(target, kept, message.hash))
                    }
                    return
                }
                reloading.current = false
            } else if (reloading.current && message.type === 'doc-store') {
                return
            }
            handler.current(message)
        }
        window.addEventListener('message', listen)
        return () => window.removeEventListener('message', listen)
    }, [url, rel, storeKey])
    return <iframe ref={frame} className="phone-doc-frame" data-testid="phone-doc-frame" title={title} sandbox={PHONE_DOC_SANDBOX} src={address} referrerPolicy="no-referrer" inert={inert} />
}
