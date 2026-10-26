import { test, expect } from '@playwright/test'
import { deleteMemoPage, memoPagesOf, shortenUrl, splitMemoLinks, turnMemoPage } from '../../src/renderer/src/components/SessionMemo'

/**
 * T48 — memo link detection and shortening, pure logic (no Electron).
 */

const links = (text: string): string[] =>
    splitMemoLinks(text).filter((s): s is { type: 'link'; url: string } => s.type === 'link').map(s => s.url)

const rebuilt = (text: string): string =>
    splitMemoLinks(text).map(s => (s.type === 'link' ? s.url : s.text)).join('')

test.describe('T48 memo links', () => {
    test('finds http(s) links and leaves every other character where it was', () => {
        const text = 'see https://a.dev/x/y and http://b.dev/z\nnext line https://c.dev'
        expect(links(text)).toEqual(['https://a.dev/x/y', 'http://b.dev/z', 'https://c.dev'])
        expect(rebuilt(text)).toBe(text)
    })

    test('punctuation and brackets around a link are not part of it', () => {
        expect(links('read https://a.dev/doc.')).toEqual(['https://a.dev/doc'])
        expect(links('(https://a.dev/doc), then "https://b.dev/x"!')).toEqual(['https://a.dev/doc', 'https://b.dev/x'])
        // A bracket the URL itself opened stays: wiki-style links end in ")".
        expect(links('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
        expect(links('(see https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
    })

    test('only web links: other schemes and bare hosts stay text', () => {
        const text = 'file:///etc/passwd javascript:alert(1) vscode://file/x example.com/path'
        expect(links(text)).toEqual([])
        expect(rebuilt(text)).toBe(text)
        expect(splitMemoLinks('')).toEqual([])
    })

    test('shortened links keep the host and the last path piece within about 40 characters', () => {
        expect(shortenUrl('https://example.com')).toBe('example.com')
        expect(shortenUrl('https://www.example.com/a/b')).toBe('example.com/a/b')

        const long = 'https://docs.example.com/guides/getting-started/advanced/the-final-page-name?tab=2#section'
        const shortened = shortenUrl(long)
        expect(shortened).toBe('docs.example.com/…/the-final-page-name')
        expect(shortened.length).toBeLessThanOrEqual(40)

        // One long piece: no "…/" in the middle, the end is cut instead.
        const oneSegment = shortenUrl('https://example.com/' + 'x'.repeat(80))
        expect(oneSegment.startsWith('example.com/xxx')).toBe(true)
        expect(oneSegment.endsWith('…')).toBe(true)
        expect(oneSegment.length).toBe(40)

        // A last piece too long for the room is cut as well.
        expect(shortenUrl('https://example.com/a/' + 'y'.repeat(80)).length).toBe(40)
    })
})

test.describe('T48 memo pages', () => {
    test('page 1 is the memo field and the rest follow it; a memo never written is one empty page', () => {
        expect(memoPagesOf('one', ['two', 'three'])).toEqual(['one', 'two', 'three'])
        expect(memoPagesOf('only')).toEqual(['only'])
        expect(memoPagesOf(undefined, undefined)).toEqual([''])
        // A "-----" line is text: the old one-sheet memo stays one page.
        expect(memoPagesOf('a\n-----\nb')).toEqual(['a\n-----\nb'])
    })

    test('turning past either end wraps round', () => {
        expect(turnMemoPage(0, 1, 3)).toBe(1)
        expect(turnMemoPage(2, 1, 3)).toBe(0)
        expect(turnMemoPage(0, -1, 3)).toBe(2)
        expect(turnMemoPage(0, 1, 1)).toBe(0)
        expect(turnMemoPage(0, -1, 0)).toBe(0)
    })

    test('deleting a page shows the one that took its place, or the new last one', () => {
        expect(deleteMemoPage(['a', 'b', 'c'], 1)).toEqual({ pages: ['a', 'c'], index: 1 })
        expect(deleteMemoPage(['a', 'b', 'c'], 2)).toEqual({ pages: ['a', 'b'], index: 1 })
        expect(deleteMemoPage(['a', 'b'], 0)).toEqual({ pages: ['b'], index: 0 })
        // The last page left is cleared rather than removed: there is always a page to type on.
        expect(deleteMemoPage(['a'], 0)).toEqual({ pages: [''], index: 0 })
    })
})
