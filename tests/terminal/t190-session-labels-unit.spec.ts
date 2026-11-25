import { test, expect } from '@playwright/test'
import {
    MAX_TAGS_PER_SESSION,
    MAX_TAG_LENGTH,
    applySessionLabels,
    describeSessionLabels,
    matchesSessionLabels,
    normalizeTag,
    normalizeTags,
    parseSessionWorkRole,
    splitTagInput,
    tagsInUse,
    type SessionLabels
} from '../../src/shared/sessionLabels'

/**
 * T190 — a session's role and tags (decision 0015), Electron-free. Every write path (the menu, the
 * editor, the Control API) goes through these functions, so what they keep is what the store keeps.
 */

test.describe('T190 session role and tags — unit', () => {
    test('a role is read from an id or a label in any case; empty, none and null clear; the rest is invalid', () => {
        expect(parseSessionWorkRole('work')).toBe('work')
        expect(parseSessionWorkRole('  Lead ')).toBe('lead')
        expect(parseSessionWorkRole('WATCH')).toBe('watch')
        expect(parseSessionWorkRole(null)).toBeNull()
        expect(parseSessionWorkRole('')).toBeNull()
        expect(parseSessionWorkRole('none')).toBeNull()
        for (const bad of ['worker', '팀장', 'master', 3, {}, ['work'], undefined]) {
            expect(parseSessionWorkRole(bad), String(bad)).toBe('invalid')
        }
    })

    test('a tag is one line, without # or outer spaces, inner spaces folded, cut to the limit', () => {
        expect(normalizeTag('  #night-1125 ')).toBe('night-1125')
        expect(normalizeTag('##a  b\nc\td')).toBe('a b c d')
        expect(normalizeTag('#   ')).toBe('')
        const long = 'x'.repeat(MAX_TAG_LENGTH + 10)
        expect(normalizeTag(long)).toHaveLength(MAX_TAG_LENGTH)
        // Cut by characters, not UTF-16 units: a Korean or emoji tag is not split mid-character.
        const korean = '가'.repeat(MAX_TAG_LENGTH + 3)
        expect(Array.from(normalizeTag(korean))).toHaveLength(MAX_TAG_LENGTH)
        expect(normalizeTag('😀'.repeat(MAX_TAG_LENGTH + 1))).toBe('😀'.repeat(MAX_TAG_LENGTH))
    })

    test('a tag list drops non-strings, empties and case duplicates (first spelling wins) and keeps at most the limit', () => {
        expect(normalizeTags(['Night', 'night', '#NIGHT', ' ', 7, null, 'phone'])).toEqual(['Night', 'phone'])
        expect(normalizeTags('night')).toEqual([])
        expect(normalizeTags(undefined)).toEqual([])
        const many = Array.from({ length: MAX_TAGS_PER_SESSION + 4 }, (_, i) => `t${i}`)
        expect(normalizeTags(many)).toEqual(many.slice(0, MAX_TAGS_PER_SESSION))
        expect(splitTagInput('a, b c ,, #d')).toEqual(['a', 'b c', 'd'])
    })

    test('applying a change keeps omitted keys, clears with null / [], deletes empty fields and reports a change', () => {
        const session: SessionLabels = {}
        expect(applySessionLabels(session, { role: 'work', tags: ['b', 'a'] })).toBe(true)
        expect(session).toEqual({ role: 'work', tags: ['b', 'a'] })
        // Same values again: nothing changed, so the caller does not write the store.
        expect(applySessionLabels(session, { role: 'work', tags: ['#b', 'a'] })).toBe(false)
        expect(applySessionLabels(session, { tags: ['a', 'b'] })).toBe(true)
        expect(session).toEqual({ role: 'work', tags: ['a', 'b'] })
        expect(applySessionLabels(session, { role: null })).toBe(true)
        expect(session).toEqual({ tags: ['a', 'b'] })
        expect('role' in session).toBe(false)
        expect(applySessionLabels(session, { tags: [] })).toBe(true)
        expect(session).toEqual({})
        expect('tags' in session).toBe(false)
        expect(applySessionLabels(session, {})).toBe(false)
    })

    test('the filter matches the role and the tag (case and # ignored); an empty filter matches all', () => {
        const a: SessionLabels = { role: 'work', tags: ['Night-1125', 'phone'] }
        const b: SessionLabels = { role: 'talk' }
        const c: SessionLabels = {}
        expect([a, b, c].filter(s => matchesSessionLabels(s, {}))).toHaveLength(3)
        expect([a, b, c].filter(s => matchesSessionLabels(s, { role: 'work' }))).toEqual([a])
        expect([a, b, c].filter(s => matchesSessionLabels(s, { tag: '#night-1125' }))).toEqual([a])
        expect([a, b, c].filter(s => matchesSessionLabels(s, { role: 'talk', tag: 'phone' }))).toEqual([])
        expect([a, b, c].filter(s => matchesSessionLabels(s, { role: null, tag: null }))).toHaveLength(3)
    })

    test('tags in use: most used first, then by name, one spelling per tag', () => {
        expect(tagsInUse([{ tags: ['b', 'night'] }, { tags: ['Night', 'a'] }, {}, { tags: ['a'] }])).toEqual(['a', 'night', 'b'])
    })

    test('the tooltip names the role and every tag, or is empty', () => {
        expect(describeSessionLabels({ role: 'watch', tags: ['x', 'y'] })).toBe('Role: Watch · #x #y')
        expect(describeSessionLabels({ tags: ['x'] })).toBe('#x')
        expect(describeSessionLabels({})).toBe('')
    })
})
