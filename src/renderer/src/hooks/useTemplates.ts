import { useState, useEffect } from 'react'
import { TerminalTemplate } from '../../../shared/types'
import { publishTemplateLogos } from './useTemplateLogos'

/**
 * 커스텀 터미널 템플릿을 관리하는 커스텀 훅
 */
export function useTemplates(settingsOpen?: boolean) {
    const [customTemplates, setTemplatesState] = useState<TerminalTemplate[]>([])
    // Sidebar rows read logos from a shared store; every load refreshes it.
    const setCustomTemplates = (templates: TerminalTemplate[]) => {
        publishTemplateLogos(templates)
        setTemplatesState(templates)
    }

    // 초기 로드
    useEffect(() => {
        window.api.getTemplates()
            .then(setCustomTemplates)
            .catch((err: Error) => {
                console.error('Failed to load templates:', err)
            })
    }, [])

    // 설정 창이 닫힐 때 템플릿 재로드
    useEffect(() => {
        if (settingsOpen === false) {
            window.api.getTemplates()
                .then(setCustomTemplates)
                .catch((err: Error) => {
                    console.error('Failed to reload templates:', err)
                })
        }
    }, [settingsOpen])

    return customTemplates
}
