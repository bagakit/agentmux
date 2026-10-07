// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { api } from '../src/renderer/src/lib/api'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

describe('original detail feedback', () => {
  it('shows success only after the original host acknowledgement and never applies a late result to a new payload', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
    let acknowledge!: () => void
    const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve }))
    const render = async (input: string) => act(async () => root.render(<ConversationMessage messageId="feedback" content={[{ kind: 'tool-call', name: 'inspect', callId: 'feedback-call', input }]} />))
    try {
      await render('Original payload')
      await act(async () => host.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!.click())
      const button = host.querySelector<HTMLButtonElement>('[aria-label="Copy tool input"]')!
      button.focus()
      await act(async () => button.click())
      expect(button.getAttribute('data-copy-state')).toBe('copying')
      expect(button.textContent).toBe('Copying…')
      expect(document.activeElement).toBe(button)
      await act(async () => acknowledge())
      expect(button.getAttribute('data-copy-state')).toBe('copied')
      expect(button.textContent).toBe('Copied')
      expect(document.activeElement).toBe(button)
      await act(async () => button.click())
      const originalAcknowledgement = acknowledge
      await render('Changed payload')
      const next = host.querySelector<HTMLButtonElement>('[aria-label="Copy tool input"]')!
      expect(next).toBe(button)
      expect(document.activeElement).toBe(next)
      expect(next.getAttribute('data-copy-state')).toBe('idle')
      await act(async () => originalAcknowledgement())
      expect(next.getAttribute('data-copy-state')).toBe('idle')
      expect(next.textContent).toBe('Copy')
      clipboard.mockRejectedValueOnce(new Error('Clipboard unavailable'))
      await act(async () => next.click())
      expect(next.getAttribute('data-copy-state')).toBe('failed')
      expect(next.textContent).toBe('Retry copy')
      clipboard.mockResolvedValueOnce(undefined)
      await act(async () => next.click())
      expect(next.getAttribute('data-copy-state')).toBe('copied')
      expect(clipboard.mock.calls.map(([text]) => text)).toEqual(['Original payload', 'Original payload', 'Changed payload', 'Changed payload'])
      await act(async () => host.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!.click())
      expect(host.querySelector('.conversation-tool-trace__payload')).toBeNull()
    } finally { await act(async () => root.unmount()); host.remove(); clipboard.mockRestore() }
  })

  it('unmounts reasoning immediately on close and keeps redacted bodies and their copy absent', async () => {
    const host = document.createElement('div'); const root = createClientUiRoot(host)
    try {
      await act(async () => root.render(<ConversationMessage content={[{ kind: 'reasoning', text: '**Original reasoning**' }, { kind: 'reasoning', text: 'Private source', redacted: true }]} />))
      const details = [...host.querySelectorAll<HTMLDetailsElement>('details.log-turn__trace')]
      expect(details).toHaveLength(2)
      expect(host.querySelector('.log-turn__trace-payload')).toBeNull()
      await act(async () => { details[0]!.open = true; details[0]!.dispatchEvent(new Event('toggle')) })
      expect(details[0]!.querySelector('.log-turn__trace-body .md')!.textContent).toBe('Original reasoning')
      await act(async () => { details[0]!.open = false; details[0]!.dispatchEvent(new Event('toggle')) })
      expect(details[0]!.querySelector('.log-turn__trace-payload')).toBeNull()
      await act(async () => { details[1]!.open = true; details[1]!.dispatchEvent(new Event('toggle')) })
      expect(details[1]!.querySelector('.content-copy')).toBeNull()
      expect(host.textContent).not.toContain('Private source')
    } finally { await act(async () => root.unmount()); host.remove() }
  })

  it('keeps a late same-text reasoning acknowledgement with its exact original Session record', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
    const part = { kind: 'reasoning' as const, text: 'Original reasoning bytes' }
    let acknowledge!: () => void
    const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve }))
    const render = async (session: string) => act(async () => root.render(<ConversationMessage messageId="same-reasoning-id" conversationSessionId={session}
      itemRef={{ hostId: 'local', agentSessionId: session, source: { kind: 'captured', recordId: 'same-record-id' } }} content={[part]} />))
    try {
      await render('original-session')
      const details = host.querySelector<HTMLDetailsElement>('details.log-turn__trace')!
      await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
      const copy = host.querySelector<HTMLButtonElement>('[aria-label="Copy reasoning"]')!
      copy.focus(); await act(async () => copy.click())
      expect(copy.getAttribute('data-copy-state')).toBe('copying')
      await render('different-session')
      expect(host.querySelector('[aria-label="Copy reasoning"]')).toBe(copy)
      expect(document.activeElement).toBe(copy)
      expect(copy.getAttribute('data-copy-state')).toBe('idle')
      await act(async () => acknowledge())
      expect(copy.getAttribute('data-copy-state')).toBe('idle')
      expect(copy.textContent).toBe('Copy')
      expect(clipboard).toHaveBeenCalledExactlyOnceWith(part.text)
    } finally { await act(async () => root.unmount()); host.remove(); clipboard.mockRestore() }
  })
})
