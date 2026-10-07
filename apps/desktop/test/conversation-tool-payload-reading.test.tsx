// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { api } from '../src/renderer/src/lib/api'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

describe('original tool payload reading', () => {
  it('formats only whitespace, preserves JSON tokens and copies the exact original bytes', async () => {
    const input = '{\r\n\t"large":90071992547409931234567890,"negative":-0,"exp":1.00e+12,"dup":1,"dup":2,"escape":"\\u0061\\n","nested":[true,null,{"s":" spaced "}]}\r\n'
    const formatted = '{\n  "large": 90071992547409931234567890,\n  "negative": -0,\n  "exp": 1.00e+12,\n  "dup": 1,\n  "dup": 2,\n  "escape": "\\u0061\\n",\n  "nested": [\n    true,\n    null,\n    {\n      "s": " spaced "\n    }\n  ]\n}'.replaceAll('\n', '\r\n')
    const host = document.createElement('div'); document.body.append(host)
    const root = createClientUiRoot(host)
    const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    try {
      await act(async () => root.render(<ConversationMessage messageId="original-tool" content={[{ kind: 'tool-call', name: 'inspect', input, callId: 'original-call' }]} />))
      expect(host.querySelector('.conversation-tool-trace__payload')).toBeNull()
      await act(async () => host.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!.click())
      const pre = host.querySelector('pre')!
      const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Format JSON"]')!
      expect(toggle).not.toBeNull()
      expect(pre.textContent).toBe(input)
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
      await act(async () => toggle.click())
      expect(host.querySelector('pre')).toBe(pre)
      expect(pre.textContent).toBe(formatted)
      expect(toggle.getAttribute('aria-pressed')).toBe('true')
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy tool input"]')!.click())
      expect(clipboard).toHaveBeenCalledExactlyOnceWith(input)
      await act(async () => toggle.click())
      expect(pre.textContent).toBe(input)
      // A fresh native page with unchanged content preserves the local reading choice.
      await act(async () => toggle.click())
      await act(async () => root.render(<ConversationMessage messageId="original-tool" content={[{ kind: 'tool-call', name: 'inspect', input, callId: 'original-call' }]} />))
      expect(host.querySelector('[aria-label="Format JSON"]')!.getAttribute('aria-pressed')).toBe('true')
      const next = '{"next":[3,2,1]}'
      await act(async () => root.render(<ConversationMessage messageId="original-tool" content={[{ kind: 'tool-call', name: 'inspect', input: next, callId: 'original-call' }]} />))
      expect(host.querySelector('pre')!.textContent).toBe(next)
      expect(host.querySelector('[aria-label="Format JSON"]')!.getAttribute('aria-pressed')).toBe('false')
      // Returning to an earlier source does not revive that source's previous mode.
      await act(async () => root.render(<ConversationMessage messageId="original-tool" content={[{ kind: 'tool-call', name: 'inspect', input, callId: 'original-call' }]} />))
      expect(host.querySelector('pre')!.textContent).toBe(input)
      expect(host.querySelector('[aria-label="Format JSON"]')!.getAttribute('aria-pressed')).toBe('false')
    } finally { await act(async () => root.unmount()); host.remove(); clipboard.mockRestore() }
  })

  it('keeps malformed, non-JSON and empty output exact without inventing a structured view or result', async () => {
    const host = document.createElement('div'); const root = createClientUiRoot(host)
    try {
      for (const output of ['{"n":01}', '{"n":NaN}', '{"n":}', '{"n":1,}', '{"n":1 /*comment*/}', '[1,2', 'plain output', '']) {
        await act(async () => root.render(<ConversationMessage messageId="opaque-tool" content={[{ kind: 'tool-result', name: 'inspect', output, callId: 'opaque-call', failed: true }]} />))
        const row = host.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!
        if (row.getAttribute('aria-expanded') !== 'true') await act(async () => row.click())
        expect(host.querySelector('pre')!.textContent).toBe(output)
        expect(host.querySelector('[aria-label="Format JSON"]')).toBeNull()
        expect(host.querySelector('.conversation-tool-trace')!.getAttribute('data-status')).toBe('failed')
      }
      const output = '{"observed":false,"zero":0,"missing":null}'
      await act(async () => root.render(<ConversationMessage messageId="opaque-tool" content={[{ kind: 'tool-result', output, callId: 'opaque-call', failed: true }]} />))
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Format JSON"]')!.click())
      expect(host.querySelector('pre')!.textContent).toBe('{\n  "observed": false,\n  "zero": 0,\n  "missing": null\n}')
      expect(host.querySelector('.conversation-tool-trace__failure')!.textContent).toBe('Failed')
    } finally { await act(async () => root.unmount()); host.remove() }
  })

  it('resets same-text reading mode for a different original record without moving its controls', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
    const input = '{"same":"bytes","value":true}'
    const render = async (session: string, record: string) => act(async () => root.render(<ConversationMessage messageId="same-message-id" conversationSessionId={session}
      itemRef={{ hostId: 'local', agentSessionId: session, source: { kind: 'captured', recordId: record } }}
      content={[{ kind: 'tool-call', name: 'inspect', input, callId: 'same-call-id' }]} />))
    try {
      await render('first-session', 'first-record')
      await act(async () => host.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!.click())
      const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Format JSON"]')!
      await act(async () => toggle.click()); toggle.focus()
      expect(toggle.getAttribute('aria-pressed')).toBe('true')
      await render('first-session', 'first-record')
      expect(toggle.getAttribute('aria-pressed')).toBe('true')
      await render('second-session', 'first-record')
      expect(host.querySelector('[aria-label="Format JSON"]')).toBe(toggle)
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
      expect(document.activeElement).toBe(toggle)
      await act(async () => toggle.click())
      await render('second-session', 'second-record')
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
      await render('first-session', 'first-record')
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
    } finally { await act(async () => root.unmount()); host.remove() }
  })
})
