// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

import { ConversationMessage } from '../src/renderer/src/components/ConversationMessage.js'

describe('conversation message reading surface', () => {
  it('gives human turns a distinct speaker role and every non-empty turn a copy action', () => {
    const html = renderToStaticMarkup(createElement(ConversationMessage, {
      messageId: 'm-1', speaker: { role: 'human', id: 'human' }, name: 'You', content: 'Please inspect this line.',
      status: 'complete', createdAt: 1, origin: 1, onAnnotate: () => {}
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
})
