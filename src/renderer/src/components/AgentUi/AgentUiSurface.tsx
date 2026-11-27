import React, { useEffect, useState } from 'react'
import { MessageProcessor } from '@a2ui/web_core'
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1'
import { A2uiSurface } from '@a2ui/react'
import type { AgentUi } from '../../../../shared/types'

/** What the library hands back when a Button's `event` action fires: the button's id and its resolved context. */
interface A2uiActionEvent {
    name?: string
    sourceComponentId?: string
    context?: Record<string, unknown>
}

export interface AgentUiSurfaceProps {
    surfaceId: string
    ui: AgentUi
    onAction: (componentId: string, context: Record<string, unknown>) => void
}

/**
 * Draws one agent card with the A2UI renderer (decision 0016). Loaded lazily from AgentUiCard so
 * the library (Lit, zod) stays out of the main chunk. Main already checked the card; this only
 * turns it into the three A2UI v1.0 messages and passes button presses up.
 */
export default function AgentUiSurface({ surfaceId, ui, onAction }: AgentUiSurfaceProps) {
    const onActionRef = React.useRef(onAction)
    onActionRef.current = onAction
    const [processor] = useState(() => {
        const p = new MessageProcessor([basicCatalog], (action: A2uiActionEvent) => {
            if (typeof action.sourceComponentId === 'string') onActionRef.current(action.sourceComponentId, action.context ?? {})
        })
        p.processMessages([
            { version: '1.0', createSurface: { surfaceId, catalogId: basicCatalog.id } },
            { version: '1.0', updateComponents: { surfaceId, components: ui.components } },
            { version: '1.0', updateDataModel: { surfaceId, value: ui.data ?? {} } }
        ] as Parameters<typeof p.processMessages>[0])
        return p
    })
    const [surfaces, setSurfaces] = useState(() => Array.from(processor.model.surfacesMap.values()))
    useEffect(() => {
        const update = (): void => setSurfaces(Array.from(processor.model.surfacesMap.values()))
        const subscription = processor.onSurfaceCreated(update)
        return () => subscription.unsubscribe()
    }, [processor])

    return (
        <>
            {surfaces.map((surface) => (
                <A2uiSurface key={surface.id} surface={surface} />
            ))}
        </>
    )
}
