import type { TerminalTemplate } from '../../../shared/types'
import { getTemplateIcon } from '../constants/icons'

/**
 * A template's mark in menus and lists: its logo when it has one, else its glyph.
 * The logo is a 32×32 PNG drawn at `size` (sharp on 2x screens).
 */
export function TemplateIcon({ template, size = 12 }: { template: Pick<TerminalTemplate, 'icon' | 'logo'>; size?: number }) {
    if (template.logo) {
        return <img src={template.logo} alt="" draggable={false} width={size} height={size} className="shrink-0 object-contain" style={{ width: size, height: size }} />
    }
    return getTemplateIcon(template.icon)
}
