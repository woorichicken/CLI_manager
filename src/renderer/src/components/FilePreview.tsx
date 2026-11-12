import React, { useEffect, useState, useCallback } from 'react'
import { X, FileText, Loader2, AlertCircle, ExternalLink, Globe, Image } from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { BROWSER_PAGE_EXTENSIONS, IMAGE_EXTENSIONS, fileExtension } from '../../../shared/fileKinds'
import { Markdown } from './ChatView/markdown/Markdown'
import './ChatView/chat.css'

/** Files drawn as their words with `renderMarkdown` (the phone file panel's list, PhoneFilePanel MARKDOWN_NAME). */
const MARKDOWN_NAME = /\.(?:md|mdx|markdown)$/i

const isImageFile = (filePath: string): boolean => {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    return IMAGE_EXTENSIONS.includes(ext)
}

interface FilePreviewProps {
    isOpen: boolean
    onClose: () => void
    filePath: string
    relativePath?: string
    line?: number
    onOpenInEditor?: () => void
    /**
     * A Markdown file opens drawn (headings, lists, tables), with Preview / Source above it — as the phone's
     * file panel (fb d89cfc4a). Asked for by the Chat's preview; ⌘P file search keeps its source view.
     */
    renderMarkdown?: boolean
}

// Map file extensions to Prism language identifiers
const getLanguageFromPath = (filePath: string): string => {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    const langMap: Record<string, string> = {
        // JavaScript/TypeScript
        'js': 'javascript',
        'jsx': 'jsx',
        'ts': 'typescript',
        'tsx': 'tsx',
        'mjs': 'javascript',
        'cjs': 'javascript',
        // Web
        'html': 'html',
        'htm': 'html',
        'css': 'css',
        'scss': 'scss',
        'sass': 'sass',
        'less': 'less',
        'vue': 'javascript',
        'svelte': 'javascript',
        // Data
        'json': 'json',
        'yaml': 'yaml',
        'yml': 'yaml',
        'toml': 'toml',
        'xml': 'xml',
        // Config
        'md': 'markdown',
        'mdx': 'markdown',
        'env': 'bash',
        'gitignore': 'git',
        // Shell
        'sh': 'bash',
        'bash': 'bash',
        'zsh': 'bash',
        'ps1': 'powershell',
        // Other languages
        'py': 'python',
        'rb': 'ruby',
        'go': 'go',
        'rs': 'rust',
        'java': 'java',
        'kt': 'kotlin',
        'swift': 'swift',
        'c': 'c',
        'cpp': 'cpp',
        'h': 'c',
        'hpp': 'cpp',
        'cs': 'csharp',
        'php': 'php',
        'sql': 'sql',
        'graphql': 'graphql',
        'gql': 'graphql',
        'dockerfile': 'docker',
        'makefile': 'makefile',
    }

    // Check for special filenames
    const filename = filePath.split('/').pop()?.toLowerCase() || ''
    if (filename === 'dockerfile') return 'docker'
    if (filename === 'makefile') return 'makefile'
    if (filename.startsWith('.env')) return 'bash'

    return langMap[ext] || 'text'
}

export function FilePreview({ isOpen, onClose, filePath, relativePath, line, onOpenInEditor, renderMarkdown = false }: FilePreviewProps) {
    const [content, setContent] = useState<string>('')
    const markdown = renderMarkdown && MARKDOWN_NAME.test(filePath)
    // the preview shows a page's source; the browser draws it (90043d9d)
    const webPage = BROWSER_PAGE_EXTENSIONS.has(fileExtension(filePath))
    // a line asked for is a place in the source: the drawn words have no line numbers
    const [source, setSource] = useState(!markdown || line !== undefined)
    useEffect(() => setSource(!markdown || line !== undefined), [filePath, line, markdown])
    const [imageData, setImageData] = useState<{ data: string; mimeType: string } | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const isImage = isImageFile(filePath)

    // Load file content (text or image)
    const loadContent = useCallback(async () => {
        if (!filePath) return

        setLoading(true)
        setError(null)
        setContent('')
        setImageData(null)

        try {
            if (isImageFile(filePath)) {
                // Load image as base64
                const result = await window.api.readImageAsBase64(filePath)
                if (result.success && result.data && result.mimeType) {
                    setImageData({ data: result.data, mimeType: result.mimeType })
                } else {
                    setError(result.error || 'Failed to read image')
                }
            } else {
                // Load text content
                const result = await window.api.readFileContent(filePath)
                if (result.success && result.content !== undefined) {
                    setContent(result.content)
                } else {
                    setError(result.error || 'Failed to read file')
                }
            }
        } catch (e: any) {
            setError(e.message)
        } finally {
            setLoading(false)
        }
    }, [filePath])

    // Load content when opened
    useEffect(() => {
        if (isOpen && filePath) {
            loadContent()
        }
    }, [isOpen, filePath, loadContent])

    // Scroll to line when content is loaded
    useEffect(() => {
        if (content && line) {
            setTimeout(() => {
                const lineElement = document.querySelector(`.line-${line}`)
                if (lineElement) {
                    lineElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }
            }, 100)
        }
    }, [content, line])

    // Handle keyboard events with delay to prevent immediate trigger
    useEffect(() => {
        if (!isOpen) return

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' || e.key === ' ') {
                e.preventDefault()
                onClose()
            } else if (e.key === 'Enter' && !e.metaKey && onOpenInEditor) {
                // Only open in editor if Enter pressed WITHOUT Cmd
                e.preventDefault()
                onOpenInEditor()
            }
        }

        // Small delay to prevent catching the same keypress that opened the preview
        const timer = setTimeout(() => {
            window.addEventListener('keydown', handleKeyDown)
        }, 100)

        return () => {
            clearTimeout(timer)
            window.removeEventListener('keydown', handleKeyDown)
        }
    }, [isOpen, onClose, onOpenInEditor])

    if (!isOpen) return null

    const displayPath = relativePath || filePath.split('/').slice(-3).join('/')
    const language = getLanguageFromPath(filePath)

    return (
        <div
            className="fixed inset-0 z-[60] flex items-center justify-center p-8"
            onClick={onClose}
        >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

            {/* Modal - Smaller size like macOS Quick Look */}
            <div
                className="relative w-full max-w-2xl max-h-[60vh] bg-[#1e1e1e] rounded-lg shadow-2xl border border-white/20 flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-[#252526]">
                    <div className="flex items-center gap-2 min-w-0">
                        {isImage ? (
                            <Image size={14} className="text-green-400 flex-shrink-0" />
                        ) : (
                            <FileText size={14} className="text-blue-400 flex-shrink-0" />
                        )}
                        <span className="text-xs text-white truncate font-mono">
                            {displayPath}
                            {line && !isImage && <span className="text-gray-400">:{line}</span>}
                        </span>
                    </div>
                    <div className="flex items-center gap-1">
                        {markdown && (
                            <div className="flex items-center mr-1 rounded border border-white/10 overflow-hidden text-[11px]" role="group" aria-label="Preview or source">
                                <button
                                    type="button"
                                    aria-pressed={!source}
                                    data-testid="file-preview-rendered"
                                    onClick={() => setSource(false)}
                                    className={`px-2 py-0.5 transition-colors ${!source ? 'bg-white/15 text-white' : 'text-gray-400 hover:text-white'}`}
                                >
                                    Preview
                                </button>
                                <button
                                    type="button"
                                    aria-pressed={source}
                                    data-testid="file-preview-source"
                                    onClick={() => setSource(true)}
                                    className={`px-2 py-0.5 transition-colors ${source ? 'bg-white/15 text-white' : 'text-gray-400 hover:text-white'}`}
                                >
                                    Source
                                </button>
                            </div>
                        )}
                        {webPage && (
                            <button
                                type="button"
                                data-testid="file-preview-browser"
                                onClick={() => void window.api.openChatPath(filePath)}
                                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-white/10 rounded transition-colors"
                                title="Open in browser — see it as a page"
                            >
                                <Globe size={12} /> Browser
                            </button>
                        )}
                        {onOpenInEditor && (
                            <button
                                onClick={onOpenInEditor}
                                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-white/10 rounded transition-colors"
                                title="Open in Editor (Enter)"
                            >
                                <ExternalLink size={12} />
                            </button>
                        )}
                        <button
                            onClick={onClose}
                            className="p-1 text-gray-400 hover:text-white hover:bg-white/10 rounded transition-colors"
                            title="Close (Esc or Space)"
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-auto">
                    {loading && (
                        <div className="flex items-center justify-center h-32">
                            <Loader2 size={20} className="text-blue-400 animate-spin" />
                        </div>
                    )}

                    {error && (
                        <div className="flex items-center justify-center h-32">
                            <div className="flex items-center gap-2 text-red-400 text-sm">
                                <AlertCircle size={16} />
                                <span>{error}</span>
                            </div>
                        </div>
                    )}

                    {/* Image Preview */}
                    {!loading && !error && imageData && (
                        <div className="flex items-center justify-center p-4 min-h-[200px]">
                            <img
                                src={`data:${imageData.mimeType};base64,${imageData.data}`}
                                alt={displayPath}
                                className="max-w-full max-h-[50vh] object-contain rounded"
                                style={{ imageRendering: 'auto' }}
                            />
                        </div>
                    )}

                    {/* Markdown, drawn */}
                    {!loading && !error && content && !source && (
                        <div className="chat-file-document" data-testid="file-preview-document">
                            <Markdown>{content}</Markdown>
                        </div>
                    )}

                    {/* Code Preview */}
                    {!loading && !error && content && source && (
                        <SyntaxHighlighter
                            language={language}
                            style={vscDarkPlus}
                            showLineNumbers
                            wrapLines
                            lineProps={(lineNumber) => ({
                                className: `line-${lineNumber}${lineNumber === line ? ' bg-yellow-500/20' : ''}`,
                                style: { display: 'block' }
                            })}
                            customStyle={{
                                margin: 0,
                                padding: '0.75rem',
                                fontSize: '12px',
                                lineHeight: '1.4',
                                background: 'transparent',
                            }}
                            codeTagProps={{
                                style: {
                                    fontFamily: "'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace"
                                }
                            }}
                        >
                            {content}
                        </SyntaxHighlighter>
                    )}
                </div>

                {/* Footer - Minimal hints */}
                <div className="px-3 py-1.5 border-t border-white/10 flex items-center gap-3 text-[10px] text-gray-500 bg-[#252526]">
                    <span><kbd className="px-1 py-0.5 bg-white/10 rounded">Space</kbd> Close</span>
                    <span><kbd className="px-1 py-0.5 bg-white/10 rounded">Enter</kbd> Open</span>
                </div>
            </div>
        </div>
    )
}
