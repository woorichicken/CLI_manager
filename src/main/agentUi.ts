import { AGENT_UI_COMPONENTS, AgentUi, AgentUiComponent, AgentUiComponentName } from '../shared/types'

/**
 * Agent-sent UI (decision 0016): an agent describes a small card as A2UI v1.0 components — data,
 * not code — and the app draws it with its own parts. This file is the security boundary: the
 * renderer library's schema is not trusted for it. Everything here is an allowlist.
 *
 * - Only the components in AGENT_UI_COMPONENTS, only their listed properties.
 * - Values are literals or `{ "@path": "/…" }` into the card's own data. No `@call`, no
 *   `functionCall` (the basic catalog's `openUrl` would navigate), no `userMessage`.
 * - The components form one tree under `root`: every id is used once, nothing is unreachable,
 *   so a cycle or a diamond that renders exponentially cannot be sent.
 * - Small caps — a card lives in config.json with up to 200 inbox requests.
 *
 * A button press does not send what the renderer says. Main looks the button up in the stored
 * card and writes one fixed-format line from its declared event name and context
 * (`agentUiActionLine`); only `@path` values come from what the user typed.
 */

export const AGENT_UI_MAX_COMPONENTS = 40
export const AGENT_UI_MAX_DEPTH = 8
export const AGENT_UI_MAX_CHILDREN = 12
export const AGENT_UI_MAX_OPTIONS = 12
export const AGENT_UI_MAX_CONTEXT_KEYS = 8
export const AGENT_UI_MAX_STRING = 500
/** The whole card (components + data) as JSON. */
export const AGENT_UI_MAX_BYTES = 16 * 1024
/** The answer line that goes into the session. */
export const AGENT_UI_MAX_LINE = 2000
/** What the user typed into one field, as it goes into the answer. */
export const AGENT_UI_MAX_ANSWER_VALUE = 1000

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const EVENT_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/
const CONTEXT_KEY_PATTERN = /^[A-Za-z0-9_]{1,32}$/
const DATA_PATH_PATTERN = /^\/[A-Za-z0-9_\-/]{0,127}$/
const DATA_MAX_DEPTH = 5
const ROOT_ID = 'root'

/** Prefix of every answer line, so the agent (and the person reading the terminal) knows where it came from. */
export const AGENT_UI_ANSWER_PREFIX = '[CLI Manager card]'

export type AgentUiCheck = { ok: true; ui: AgentUi } | { ok: false; message: string }

class UiError extends Error {}

const fail = (message: string): never => {
    throw new UiError(message)
}

type PropKind =
    | 'dynamicString'
    | 'dynamicBoolean'
    | 'dynamicStringList'
    | 'child'
    | 'children'
    | 'weight'
    | 'action'
    | 'options'
    | 'boolean'
    | { enum: readonly string[] }

interface ComponentRule {
    required: Record<string, PropKind>
    optional: Record<string, PropKind>
}

const JUSTIFY = ['start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'] as const
const ALIGN = ['start', 'center', 'end', 'stretch'] as const

/** Per component: the properties it takes (A2UI v1.0 basic catalog, minus `@checks`, templates and functions). */
const RULES: Record<AgentUiComponentName, ComponentRule> = {
    Card: { required: { child: 'child' }, optional: { weight: 'weight' } },
    Column: { required: { children: 'children' }, optional: { justify: { enum: JUSTIFY }, align: { enum: ALIGN }, weight: 'weight' } },
    Row: { required: { children: 'children' }, optional: { justify: { enum: JUSTIFY }, align: { enum: ALIGN }, weight: 'weight' } },
    Text: { required: { text: 'dynamicString' }, optional: { variant: { enum: ['caption', 'body'] }, weight: 'weight' } },
    Divider: { required: {}, optional: { axis: { enum: ['horizontal', 'vertical'] }, weight: 'weight' } },
    Button: {
        required: { child: 'child', action: 'action' },
        optional: { variant: { enum: ['default', 'primary', 'borderless'] }, weight: 'weight' }
    },
    // `obscured` is left out: a card is no place to ask for a password the agent would then read.
    TextField: {
        required: { label: 'dynamicString', value: 'dynamicString' },
        optional: { placeholder: 'dynamicString', variant: { enum: ['shortText', 'longText', 'number'] }, weight: 'weight' }
    },
    CheckBox: { required: { label: 'dynamicString', value: 'dynamicBoolean' }, optional: { weight: 'weight' } },
    ChoicePicker: {
        required: { options: 'options', value: 'dynamicStringList' },
        optional: {
            label: 'dynamicString',
            variant: { enum: ['mutuallyExclusive', 'multipleSelection'] },
            displayStyle: { enum: ['checkbox', 'chips'] },
            filterable: 'boolean',
            weight: 'weight'
        }
    }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

function checkString(value: unknown, where: string): string {
    if (typeof value !== 'string') fail(`${where} must be a string`)
    if ((value as string).length > AGENT_UI_MAX_STRING) fail(`${where} is limited to ${AGENT_UI_MAX_STRING} characters`)
    return value as string
}

/** What a bound slot shows: the data at its path must be that shape (or absent), or the renderer throws. */
type BindingShape = 'text' | 'boolean' | 'list' | 'any'
interface Binding {
    path: string
    shape: BindingShape
    where: string
}

/** `{ "@path": "/a/b" }` — the only binding allowed. Anything else with an `@` key (e.g. `@call`) is refused. */
function checkPath(value: Record<string, unknown>, where: string, bindings: Binding[], shape: BindingShape): void {
    const keys = Object.keys(value)
    if (keys.length !== 1 || keys[0] !== '@path') fail(`${where}: only { "@path": "/…" } bindings are allowed (no @call or functions)`)
    const path = value['@path']
    if (typeof path !== 'string' || !DATA_PATH_PATTERN.test(path)) fail(`${where}: @path must be an absolute path like "/form/note"`)
    bindings.push({ path: path as string, shape, where })
}

/**
 * The value at `/a/0/b` in the card's data, or undefined — read the way the renderer reads it: list
 * indexes too, and only the data's own keys (an inherited `toString` is not data).
 */
function valueAt(data: Record<string, unknown> | undefined, path: string): unknown {
    let current: unknown = data
    for (const part of path.split('/').filter(Boolean)) {
        if (Array.isArray(current)) {
            // "0", "12" — not "00" or "01", which the renderer does not read as an index
            if (!/^(0|[1-9]\d*)$/.test(part)) return undefined
            current = current[Number(part)]
        } else if (isPlainObject(current)) {
            if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined
            current = current[part]
        } else {
            return undefined
        }
    }
    return current
}

function checkBindingShape(binding: Binding, value: unknown): void {
    if (value === undefined || binding.shape === 'any') return
    const ok =
        binding.shape === 'text'
            ? typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            : binding.shape === 'boolean'
                ? typeof value === 'boolean'
                : Array.isArray(value) && value.every((item) => typeof item === 'string')
    if (!ok) {
        const want = binding.shape === 'text' ? 'a string or number' : binding.shape === 'boolean' ? 'true or false' : 'a list of strings'
        fail(`${binding.where}: data at ${binding.path} must be ${want}`)
    }
}

function checkProp(kind: PropKind, value: unknown, where: string, refs: string[], bindings: Binding[]): void {
    if (typeof kind === 'object') {
        if (typeof value !== 'string' || !kind.enum.includes(value)) fail(`${where} must be one of ${kind.enum.join(', ')}`)
        return
    }
    switch (kind) {
        case 'dynamicString':
            if (isPlainObject(value)) checkPath(value, where, bindings, 'text')
            else checkString(value, where)
            return
        case 'dynamicBoolean':
            if (isPlainObject(value)) checkPath(value, where, bindings, 'boolean')
            else if (typeof value !== 'boolean') fail(`${where} must be true, false or { "@path": "/…" }`)
            return
        case 'dynamicStringList':
            if (isPlainObject(value)) checkPath(value, where, bindings, 'list')
            else if (!Array.isArray(value) || value.length > AGENT_UI_MAX_OPTIONS) fail(`${where} must be a list of strings or { "@path": "/…" }`)
            else (value as unknown[]).forEach((item, i) => checkString(item, `${where}[${i}]`))
            return
        case 'child':
            if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail(`${where} must be a component id`)
            refs.push(value as string)
            return
        case 'children':
            // Templates ({ path, componentId }) are left out: they repeat a component per data row.
            if (!Array.isArray(value)) fail(`${where} must be a list of component ids`)
            if ((value as unknown[]).length > AGENT_UI_MAX_CHILDREN) fail(`${where} is limited to ${AGENT_UI_MAX_CHILDREN} children`)
            for (const [i, child] of (value as unknown[]).entries()) {
                if (typeof child !== 'string' || !ID_PATTERN.test(child)) fail(`${where}[${i}] must be a component id`)
                refs.push(child as string)
            }
            return
        case 'weight':
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) fail(`${where} must be a number from 0 to 100`)
            return
        case 'boolean':
            if (typeof value !== 'boolean') fail(`${where} must be true or false`)
            return
        case 'options':
            if (!Array.isArray(value) || value.length === 0) fail(`${where} must be a non-empty list`)
            if ((value as unknown[]).length > AGENT_UI_MAX_OPTIONS) fail(`${where} is limited to ${AGENT_UI_MAX_OPTIONS} options`)
            for (const [i, option] of (value as unknown[]).entries()) {
                if (!isPlainObject(option)) fail(`${where}[${i}] must be { label, value }`)
                const o = option as Record<string, unknown>
                const extra = Object.keys(o).filter((k) => k !== 'label' && k !== 'value')
                if (extra.length) fail(`${where}[${i}] has unknown property "${extra[0]}"`)
                checkProp('dynamicString', o.label, `${where}[${i}].label`, refs, bindings)
                checkString(o.value, `${where}[${i}].value`)
            }
            return
        case 'action':
            checkAction(value, where, bindings)
            return
    }
}

/** `{ event: { name, context? } }` only. `functionCall` (openUrl and friends) and `userMessage` are refused. */
function checkAction(value: unknown, where: string, bindings: Binding[]): void {
    if (!isPlainObject(value) || Object.keys(value).length !== 1 || !isPlainObject(value.event)) {
        fail(`${where} must be { "event": { "name": "…", "context": { … } } } — functionCall is not allowed`)
    }
    const event = (value as { event: Record<string, unknown> }).event
    const extra = Object.keys(event).filter((k) => k !== 'name' && k !== 'context')
    if (extra.length) fail(`${where}.event has unknown property "${extra[0]}"`)
    if (typeof event.name !== 'string' || !EVENT_NAME_PATTERN.test(event.name)) {
        fail(`${where}.event.name must be 1–64 letters, digits or _ . : -`)
    }
    if (event.context === undefined) return
    if (!isPlainObject(event.context)) fail(`${where}.event.context must be an object`)
    const entries = Object.entries(event.context as Record<string, unknown>)
    if (entries.length > AGENT_UI_MAX_CONTEXT_KEYS) fail(`${where}.event.context is limited to ${AGENT_UI_MAX_CONTEXT_KEYS} keys`)
    for (const [key, item] of entries) {
        if (!CONTEXT_KEY_PATTERN.test(key)) fail(`${where}.event.context key "${key}" must be 1–32 letters, digits or _`)
        const at = `${where}.event.context.${key}`
        if (isPlainObject(item)) checkPath(item, at, bindings, 'any')
        else if (typeof item === 'string') checkString(item, at)
        else if (item !== null && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item))) {
            fail(`${at} must be a string, number, boolean, null or { "@path": "/…" }`)
        }
    }
}

function checkData(value: unknown, depth: number, where: string): void {
    if (depth > DATA_MAX_DEPTH) fail(`data is nested deeper than ${DATA_MAX_DEPTH}`)
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return
    if (typeof value === 'string') {
        checkString(value, where)
        return
    }
    if (Array.isArray(value)) {
        value.forEach((item, i) => checkData(item, depth + 1, `${where}[${i}]`))
        return
    }
    if (isPlainObject(value)) {
        for (const [key, item] of Object.entries(value)) {
            if (!CONTEXT_KEY_PATTERN.test(key)) fail(`${where} key "${key}" must be 1–32 letters, digits or _`)
            checkData(item, depth + 1, `${where}.${key}`)
        }
        return
    }
    fail(`${where} must be JSON (strings, numbers, booleans, null, lists, objects)`)
}

/**
 * Checks an agent's card. Returns a copy holding only what was checked (so nothing unlisted is
 * stored), or the first problem in words the agent can act on.
 */
export function checkAgentUi(input: { components?: unknown; data?: unknown }): AgentUiCheck {
    try {
        const { components, data } = input
        if (!Array.isArray(components) || components.length === 0) fail('components must be a non-empty list')
        const list = components as unknown[]
        if (list.length > AGENT_UI_MAX_COMPONENTS) fail(`components is limited to ${AGENT_UI_MAX_COMPONENTS}`)
        if (data !== undefined && data !== null && !isPlainObject(data)) fail('data must be an object')
        let bytes = 0
        try {
            bytes = Buffer.byteLength(JSON.stringify({ components, data: data ?? null }), 'utf8')
        } catch {
            fail('components and data must be plain JSON')
        }
        if (bytes > AGENT_UI_MAX_BYTES) fail(`the card is limited to ${AGENT_UI_MAX_BYTES} bytes of JSON (got ${bytes})`)

        const byId = new Map<string, AgentUiComponent>()
        const bindings: Binding[] = []
        const childrenOf = new Map<string, string[]>()
        for (const [index, raw] of list.entries()) {
            const where = `components[${index}]`
            if (!isPlainObject(raw)) fail(`${where} must be an object`)
            const item = raw as Record<string, unknown>
            if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) fail(`${where}.id must be 1–64 letters, digits, _ or -`)
            const id = item.id as string
            if (byId.has(id)) fail(`component id "${id}" is used twice`)
            const name = item.component
            if (typeof name !== 'string' || !(AGENT_UI_COMPONENTS as readonly string[]).includes(name)) {
                fail(`${where}.component must be one of ${AGENT_UI_COMPONENTS.join(', ')}`)
            }
            const rule = RULES[name as AgentUiComponentName]
            const refs: string[] = []
            const copy: Record<string, unknown> = { id, component: name }
            for (const [key, value] of Object.entries(item)) {
                if (key === 'id' || key === 'component') continue
                const kind = rule.required[key] ?? rule.optional[key]
                if (!kind) fail(`${where} (${name}) has unknown property "${key}"`)
                checkProp(kind, value, `${where}.${key}`, refs, bindings)
                copy[key] = value
            }
            for (const key of Object.keys(rule.required)) {
                if (!(key in item)) fail(`${where} (${name}) needs "${key}"`)
            }
            byId.set(id, copy as AgentUiComponent)
            childrenOf.set(id, refs)
        }

        if (!byId.has(ROOT_ID)) fail('one component must have id "root" — it is drawn first')
        // One tree under root: each id is somebody's child at most once, root is nobody's child.
        const parentOf = new Map<string, string>()
        for (const [id, refs] of childrenOf) {
            for (const ref of refs) {
                if (!byId.has(ref)) fail(`"${id}" refers to "${ref}", which is not in components`)
                if (ref === ROOT_ID) fail(`"${id}" refers to "root" — root cannot be a child`)
                if (parentOf.has(ref)) fail(`"${ref}" is used by both "${parentOf.get(ref)}" and "${id}" — each component goes in one place`)
                parentOf.set(ref, id)
            }
        }
        const reached = new Set<string>()
        const walk = (id: string, depth: number): void => {
            if (depth > AGENT_UI_MAX_DEPTH) fail(`components are nested deeper than ${AGENT_UI_MAX_DEPTH}`)
            reached.add(id)
            for (const child of childrenOf.get(id) ?? []) walk(child, depth + 1)
        }
        walk(ROOT_ID, 1)
        for (const id of byId.keys()) {
            if (!reached.has(id)) fail(`"${id}" is not reachable from root`)
        }

        if (data !== undefined && data !== null) checkData(data, 1, 'data')
        // A bound slot gets what its part can show — an object where text goes makes the renderer throw.
        for (const binding of bindings) checkBindingShape(binding, valueAt(isPlainObject(data) ? data : undefined, binding.path))
        const ui: AgentUi = { components: [...byId.values()] }
        if (isPlainObject(data) && Object.keys(data).length > 0) ui.data = data as Record<string, unknown>
        return { ok: true, ui }
    } catch (error) {
        if (error instanceof UiError) return { ok: false, message: error.message }
        throw error
    }
}

export type AgentUiLine = { ok: true; action: string; line: string } | { ok: false; reason: 'not_a_button' | 'too_large'; message: string }

/** A value the user produced in a bound field, kept to plain JSON and capped. Anything else becomes null. */
function answerValue(value: unknown): unknown {
    if (typeof value === 'string') return value.slice(0, AGENT_UI_MAX_ANSWER_VALUE)
    if (typeof value === 'boolean' || value === null) return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (Array.isArray(value)) {
        return value
            .filter((item): item is string => typeof item === 'string')
            .slice(0, AGENT_UI_MAX_OPTIONS)
            .map((item) => item.slice(0, AGENT_UI_MAX_ANSWER_VALUE))
    }
    return null
}

/**
 * The line a button press types into the session: `[CLI Manager card] <event> <context JSON>`.
 * Event name and literal context come from the stored card — never from the renderer — and a
 * `@path` value is what the renderer resolved from the user's input (the only thing it supplies).
 * JSON keeps the line on one line: a newline typed in a field arrives as `\n`.
 */
export function agentUiActionLine(ui: AgentUi, componentId: unknown, resolved: unknown): AgentUiLine {
    const button = typeof componentId === 'string' ? ui.components.find((c) => c.id === componentId) : undefined
    if (!button || button.component !== 'Button') {
        return { ok: false, reason: 'not_a_button', message: 'That control does not send anything.' }
    }
    const event = (button.action as { event: { name: string; context?: Record<string, unknown> } }).event
    const fromRenderer = isPlainObject(resolved) ? resolved : {}
    const context: Record<string, unknown> = {}
    for (const [key, declared] of Object.entries(event.context ?? {})) {
        context[key] = isPlainObject(declared) ? answerValue(fromRenderer[key]) : declared
    }
    const line = `${AGENT_UI_ANSWER_PREFIX} ${event.name} ${JSON.stringify(context)}`
    if (line.length > AGENT_UI_MAX_LINE) {
        return { ok: false, reason: 'too_large', message: `The answer is longer than ${AGENT_UI_MAX_LINE} characters — shorten what you typed.` }
    }
    return { ok: true, action: event.name, line }
}
