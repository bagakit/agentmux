// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

import { ConversationMessage } from '../src/renderer/src/components/ConversationMessage.js'
import { api } from '../src/renderer/src/lib/api.js'

describe('conversation message reading surface', () => {
  it('gives human turns a distinct speaker role and every non-empty turn a copy action', () => {
    const html = renderToStaticMarkup(createElement(ConversationMessage, {
      messageId: 'm-1', speaker: { role: 'human', id: 'human' }, name: 'You', content: 'Please inspect this line.',
      status: 'complete', createdAt: 1, origin: 1, onSelectAnnotation: () => {}
    }))
    expect(html).toContain('data-speaker-role="human"')
    expect(html).toContain('aria-label="Copy message"')
    expect(html).toContain('log-turn__body')
  })

  it('keeps agent turns in the same reusable message component', () => {
    const html = renderToStaticMarkup(createElement(ConversationMessage, {
      messageId: 'm-2', speaker: { role: 'agent', id: 'agent-1' }, name: 'Agent', content: 'Done.',
      status: 'complete', createdAt: 1, origin: 1
    }))
    expect(html).toContain('data-speaker-role="agent"')
    expect(html).toContain('aria-label="Copy message"')
  })

  it('copies a live string exactly and does not collect read-only selection state', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    const selectionRead = vi.spyOn(window, 'getSelection')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const text = '  exact **live** text\nwith a trailing newline\n'
    try {
      await act(async () => root.render(<ConversationMessage speaker={{ role: 'agent', id: 'actual-live' }}
        content={text} status="streaming" createdAt={2_000} origin={1_000} />))
      const body = host.querySelector('.log-turn__body')!
      expect(body).not.toBeNull()
      await act(async () => body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
      expect(selectionRead).not.toHaveBeenCalled()
      expect(host.querySelector('.log-turn__annotation')).toBeNull()
      expect(host.querySelector('.log-turn')?.getAttribute('data-status')).toBe('streaming')
      expect(host.querySelector('.log-turn__time')?.getAttribute('title')).toContain('+1.0s from start')
      const copy = host.querySelector<HTMLButtonElement>('[title="Copy message"]')!
      expect(copy).not.toBeNull()
      vi.useFakeTimers()
      await act(async () => copy.click())
      expect(clipboard).toHaveBeenCalledExactlyOnceWith(text)
      await act(async () => { await vi.runOnlyPendingTimersAsync() })
    } finally {
      await act(async () => root.unmount())
      host.remove()
      vi.useRealTimers()
      clipboard.mockRestore()
      selectionRead.mockRestore()
    }
  })
})
