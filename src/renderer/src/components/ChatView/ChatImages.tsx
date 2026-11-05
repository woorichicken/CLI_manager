import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Copy, Download, Image as ImageIcon, Maximize2, Minimize2, X } from 'lucide-react'
import { cachedChatImage, loadChatImage, useChatActions, type GalleryImage } from './chatContext'

/**
 * Pictures in the chat — one the person pasted into a prompt, one a tool returned (a Read of a
 * screenshot) — read from the transcript by their ref only when drawn, and opened full size in a
 * lightbox (ovis ImageLightbox: zoom, step through the message's pictures, copy, download).
 */
export function ChatImageStrip({ images, label }: { images: GalleryImage[]; label: string }) {
    const actions = useChatActions()
    if (images.length === 0) return null
    if (!actions) {
        return (
            <div className="chat-chip">
                <ImageIcon size={12} aria-hidden="true" /> {images.length === 1 ? 'Image' : `${images.length} images`}
            </div>
        )
    }
    return (
        <div className="chat-images" role="group" aria-label={label} data-testid="chat-images">
            {images.map((image, index) => (
                <ChatThumb key={image.ref} image={image} onOpen={() => actions.openGallery(images, index)} />
            ))}
        </div>
    )
}

function useImage(ref: string): string | null | undefined {
    const actions = useChatActions()
    const [url, setUrl] = useState<string | null | undefined>(() => (actions ? cachedChatImage(actions.sessionId, ref) : null))
    useEffect(() => {
        if (!actions) return
        let live = true
        void loadChatImage(actions.transport, actions.sessionId, ref).then((loaded) => {
            if (live) setUrl(loaded)
        })
        return () => {
            live = false
        }
    }, [actions, ref])
    return url
}

function ChatThumb({ image, onOpen }: { image: GalleryImage; onOpen: () => void }) {
    const url = useImage(image.ref)
    return (
        <button type="button" className="chat-image-thumb" data-testid="chat-image" data-loaded={url ? 'true' : 'false'} title="Open image" onClick={onOpen}>
            {url ? <img src={url} alt="" draggable={false} /> : url === null ? <span className="chat-image-missing">Image not found</span> : <span className="chat-image-loading" />}
        </button>
    )
}

/** Converts a picture to PNG: the clipboard takes PNG only. */
async function pngBlob(url: string): Promise<Blob | null> {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    canvas.getContext('2d')?.drawImage(image, 0, 0)
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export function ImageLightbox({ images, start, onClose }: { images: GalleryImage[]; start: number; onClose: () => void }) {
    const [index, setIndex] = useState(start)
    const [actual, setActual] = useState(false)
    const [note, setNote] = useState<string | null>(null)
    const image = images[index]
    const url = useImage(image.ref)
    const step = useCallback(
        (by: number) => {
            setIndex((current) => (current + by + images.length) % images.length)
            setActual(false)
            setNote(null)
        },
        [images.length]
    )

    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                onClose()
            } else if (event.key === 'ArrowLeft' && images.length > 1) step(-1)
            else if (event.key === 'ArrowRight' && images.length > 1) step(1)
        }
        // capture: the app's own Esc handlers (and the composer's Stop) must not see it
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [images.length, onClose, step])

    const copy = async (): Promise<void> => {
        if (!url) return
        try {
            const blob = await pngBlob(url)
            if (!blob) throw new Error('no image')
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
            setNote('Copied')
        } catch {
            setNote('Could not copy the image')
        }
    }

    return createPortal(
        <div className="chat-lightbox" role="dialog" aria-modal="true" aria-label="Image" data-testid="chat-lightbox" onClick={onClose}>
            <div className="chat-lightbox-bar" onClick={(event) => event.stopPropagation()}>
                <span className="chat-lightbox-count">{images.length > 1 ? `${index + 1} / ${images.length}` : ''}</span>
                {note && <span className="chat-lightbox-note" role="status">{note}</span>}
                <button type="button" title={actual ? 'Fit to window' : 'Actual size'} aria-label={actual ? 'Fit to window' : 'Actual size'} onClick={() => setActual(!actual)}>
                    {actual ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                </button>
                <button type="button" title="Copy image" aria-label="Copy image" disabled={!url} onClick={() => void copy()}>
                    <Copy size={15} />
                </button>
                <a
                    className={url ? '' : 'is-disabled'}
                    href={url ?? undefined}
                    download={`image-${index + 1}.${EXTENSIONS[image.media_type] ?? 'png'}`}
                    title="Download"
                    aria-label="Download"
                >
                    <Download size={15} />
                </a>
                <button type="button" title="Close (Esc)" aria-label="Close" onClick={onClose}>
                    <X size={16} />
                </button>
            </div>
            {images.length > 1 && (
                <>
                    <button type="button" className="chat-lightbox-step is-prev" aria-label="Previous image" onClick={(event) => (event.stopPropagation(), step(-1))}>
                        <ChevronLeft size={22} />
                    </button>
                    <button type="button" className="chat-lightbox-step is-next" aria-label="Next image" onClick={(event) => (event.stopPropagation(), step(1))}>
                        <ChevronRight size={22} />
                    </button>
                </>
            )}
            <div className={`chat-lightbox-stage${actual ? ' is-actual' : ''}`} onClick={(event) => event.stopPropagation()}>
                {url ? <img src={url} alt="" onClick={() => setActual(!actual)} /> : <span className="chat-image-missing">{url === null ? 'Image not found' : 'Loading…'}</span>}
            </div>
        </div>,
        document.body
    )
}
