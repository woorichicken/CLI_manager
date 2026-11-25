import { test, expect } from '@playwright/test'
import * as mod from '../../src/renderer/src/hooks/useSessionViewMode'
import { templateOpensInChat } from '../../src/shared/agentCommand'

/**
 * T171 (unit, no Electron) — the open-in-Chat hint (fbe10f54).
 *
 *  - `applyOpenInChat` switches a flagged session to Chat once and returns its id (the caller has main delete the
 *    flag); an unflagged session is never touched, and a Terminal choice made right after is not undone by the
 *    flag still sitting in the renderer's copy
 *  - `templateOpensInChat`: only a template that asks for Chat AND starts Claude Code / Codex (aliases count) flags
 *    its sessions — a shell command never does, so a `claude` typed into it later cannot flip it
 */

test('T171 applyOpenInChat switches a flagged session once and hands back its id', () => {
    const sessions = [{ id: 'flagged', openInChat: true }, { id: 'plain' }]
    expect(mod.applyOpenInChat(sessions)).toEqual(['flagged'])
    expect(mod.getSessionViewMode('flagged')).toBe('chat')
    expect(mod.getSessionViewMode('plain')).toBe('terminal')

    // main has not answered yet and the person goes back to the terminal: the same list again changes nothing
    mod.setSessionViewMode('flagged', 'terminal')
    expect(mod.applyOpenInChat(sessions)).toEqual([])
    expect(mod.getSessionViewMode('flagged')).toBe('terminal')

    // a session that shows up later is handled on its own
    expect(mod.applyOpenInChat([...sessions, { id: 'later', openInChat: true }])).toEqual(['later'])
    expect(mod.getSessionViewMode('later')).toBe('chat')
})

test('T171 only a Chat template that starts Claude Code or Codex flags its sessions', () => {
    const alias = (name: string): string | undefined => (name === 'cld' ? 'claude --dangerously-skip-permissions' : undefined)
    expect(templateOpensInChat({ openIn: 'chat', command: 'claude' })).toBe(true)
    expect(templateOpensInChat({ openIn: 'chat', command: 'codex --model x' })).toBe(true)
    expect(templateOpensInChat({ openIn: 'chat', command: 'cld' }, alias)).toBe(true)
    expect(templateOpensInChat({ openIn: 'chat', command: 'cld' })).toBe(false)
    expect(templateOpensInChat({ openIn: 'chat', command: 'npm run dev' }, alias)).toBe(false)
    expect(templateOpensInChat({ openIn: 'chat', command: '' })).toBe(false)
    expect(templateOpensInChat({ openIn: 'terminal', command: 'claude' })).toBe(false)
    expect(templateOpensInChat({ command: 'claude' })).toBe(false)
})
