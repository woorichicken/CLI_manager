import React from 'react'
import { createPortal } from 'react-dom'
import { MENU_Z_INDEX } from '../../constants/styles'

interface BranchPromptModalProps {
    onSubmit: (branchName: string) => void
    onCancel: () => void
}

/**
 * Worktree 브랜치명 입력 모달
 */
export function BranchPromptModal({ onSubmit, onCancel }: BranchPromptModalProps) {
    const [branchName, setBranchName] = React.useState('')

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        if (branchName) {
            onSubmit(branchName)
            setBranchName('')
        }
    }

    return createPortal(
        <div className={`fixed inset-0 z-[${MENU_Z_INDEX}] flex items-center justify-center bg-black/50 backdrop-blur-sm`}>
            <div
                className="bg-[#1e1e20] border border-white/10 rounded-lg p-4 w-80 shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                <h3 className="text-sm font-medium text-white mb-3">Enter Branch Name</h3>
                <form onSubmit={handleSubmit}>
                    <input
                        type="text"
                        autoFocus
                        value={branchName}
                        onChange={e => setBranchName(e.target.value)}
                        placeholder="feature/my-branch"
                        className="w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 mb-3"
                    />
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={onCancel}
                            className="px-3 py-1 text-xs text-gray-400 hover:text-white"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500"
                            disabled={!branchName}
                        >
                            Create
                        </button>
                    </div>
                </form>
            </div>
        </div>,
        document.body
    )
}

interface PRPromptModalProps {
    onSubmit: (title: string, body: string) => void
    onCancel: () => void
}

/**
 * Pull Request 생성 모달
 */
export function PRPromptModal({ onSubmit, onCancel }: PRPromptModalProps) {
    const [prTitle, setPRTitle] = React.useState('')
    const [prBody, setPRBody] = React.useState('')

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        if (prTitle) {
            onSubmit(prTitle, prBody)
            setPRTitle('')
            setPRBody('')
        }
    }

    return createPortal(
        <div className={`fixed inset-0 z-[${MENU_Z_INDEX}] flex items-center justify-center bg-black/50 backdrop-blur-sm`}>
            <div
                className="bg-[#1e1e20] border border-white/10 rounded-lg p-4 w-96 shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                <h3 className="text-sm font-medium text-white mb-3">Create Pull Request</h3>
                <form onSubmit={handleSubmit}>
                    <div className="mb-3">
                        <label className="text-xs text-gray-400 mb-1 block">Title</label>
                        <input
                            type="text"
                            autoFocus
                            value={prTitle}
                            onChange={e => setPRTitle(e.target.value)}
                            placeholder="PR title"
                            className="w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                        />
                    </div>
                    <div className="mb-3">
                        <label className="text-xs text-gray-400 mb-1 block">Description (optional)</label>
                        <textarea
                            value={prBody}
                            onChange={e => setPRBody(e.target.value)}
                            placeholder="PR description"
                            rows={4}
                            className="w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 resize-none"
                        />
                    </div>
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={onCancel}
                            className="px-3 py-1 text-xs text-gray-400 hover:text-white"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500"
                            disabled={!prTitle}
                        >
                            Create PR
                        </button>
                    </div>
                </form>
            </div>
        </div>,
        document.body
    )
}

interface ConfirmationModalProps {
    title: string
    message: string
    onConfirm: () => void
    onCancel: () => void
    confirmText?: string
    cancelText?: string
    isDangerous?: boolean
    /**
     * Opt-in: Esc and a click on the backdrop cancel, and Cancel takes the focus so a stray
     * Enter does nothing harmful. Off by default so existing callers behave exactly as before.
     */
    dismissible?: boolean
    /** Prefix for test ids: `<id>`, `<id>-cancel`, `<id>-confirm`. */
    testId?: string
}

/**
 * 확인 모달
 */
export function ConfirmationModal({
    title,
    message,
    onConfirm,
    onCancel,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    isDangerous = false,
    dismissible = false,
    testId
}: ConfirmationModalProps) {
    const cancelRef = React.useRef<HTMLButtonElement>(null)
    React.useEffect(() => {
        if (!dismissible) return
        cancelRef.current?.focus()
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            onCancel()
        }
        // Capture phase: the terminal and app shortcuts must not see this Esc.
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [dismissible, onCancel])
    return createPortal(
        <div
            className={`fixed inset-0 z-[${MENU_Z_INDEX}] flex items-center justify-center bg-black/50 backdrop-blur-sm`}
            data-testid={testId}
            onClick={dismissible ? onCancel : undefined}
        >
            <div
                className="bg-[#1e1e20] border border-white/10 rounded-lg p-4 w-80 shadow-2xl"
                role={dismissible ? 'alertdialog' : undefined}
                aria-modal={dismissible ? true : undefined}
                aria-label={dismissible ? title : undefined}
                onClick={e => e.stopPropagation()}
            >
                <h3 className="text-sm font-medium text-white mb-2">{title}</h3>
                <p className="text-xs text-gray-400 mb-4">{message}</p>
                <div className="flex justify-end gap-2">
                    <button
                        ref={cancelRef}
                        onClick={onCancel}
                        data-testid={testId ? `${testId}-cancel` : undefined}
                        className="px-3 py-1 text-xs text-gray-400 hover:text-white rounded focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/40"
                    >
                        {cancelText}
                    </button>
                    <button
                        onClick={onConfirm}
                        data-testid={testId ? `${testId}-confirm` : undefined}
                        className={`px-3 py-1 text-xs text-white rounded ${isDangerous
                                ? 'bg-red-600 hover:bg-red-500'
                                : 'bg-blue-600 hover:bg-blue-500'
                            }`}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    )
}
