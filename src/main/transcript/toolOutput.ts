// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/tool-output.ts — types point at src/shared/conversation; the "fetch the rest" endpoint is not ported.
import type { ToolPart } from '../../shared/conversation'

/** Past this a tool's output is cut in the chat; the rest stays in the transcript file. */
export const TOOL_OUTPUT_CHARS = 4000

/**
 * omo's goal calls answer with the goal as JSON the chat reads, its objective alone up to 4000
 * characters: cut at the usual length, a finished goal's answer lost its status.
 */
const WHOLE_OUTPUT_TOOLS = new Set(['create_goal', 'update_goal', 'get_goal'])
const WHOLE_OUTPUT_CHARS = 16_000

/** Sets a tool part's output, cut to what a page carries, keeping what it takes to name the rest. */
export function trimOutput(tool: ToolPart, output: string, ref: string, fullSize?: number): void {
    const limit = WHOLE_OUTPUT_TOOLS.has(tool.name) ? WHOLE_OUTPUT_CHARS : TOOL_OUTPUT_CHARS
    const size = fullSize ?? output.length
    if (size <= limit) {
        tool.output = output
        return
    }
    tool.output = `${output.slice(0, limit)}\n… trimmed`
    tool.output_ref = ref
    tool.output_size = size
}
