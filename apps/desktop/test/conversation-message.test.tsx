import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { ConversationMessage } from '../src/renderer/src/components/ConversationMessage.js'

const base = {
  speaker: { role: 'agent' as const, id: 'agent-review' },
  name: 'Review agent',
  providerId: 'codex' as const,
  origin: 1_000,
  createdAt: 2_000,
  workspaceRoot: '/workspace'
}

describe('ConversationMessage', () => {
  it('renders one shared message shape with identity, markdown and quiet time', () => {
    const markup = renderToStaticMarkup(createElement(ConversationMessage, {
      ...base,
      status: 'complete',
      content: 'Answer **ready**.'
    }))
    expect(markup).toContain('class="log-turn" data-speaker-role="agent" data-status="complete"')
    expect(markup).toContain('Review agent')
    expect(markup).toContain('Answer <strong>ready</strong>.')
    expect(markup).toMatch(/>\d{2}:00:02<\/span>/)
    expect(markup).toMatch(/title="\d{2}:00:02 · \+1\.0s from start"/)
  })

  it('keeps streaming and failed states visible as semantic status', () => {
    const streaming = renderToStaticMarkup(createElement(ConversationMessage, { ...base, status: 'streaming', content: 'Still working' }))
    const failed = renderToStaticMarkup(createElement(ConversationMessage, { ...base, status: 'failed', content: 'Partial answer' }))
    expect(streaming).toContain('Streaming')
    expect(streaming).toContain('data-status="streaming"')
    expect(failed).toContain('Failed')
    expect(failed).toContain('data-status="failed"')
  })

  it('preserves a Continue action as a host callback', () => {
    const markup = renderToStaticMarkup(createElement(ConversationMessage, {
      ...base,
      status: 'complete',
      content: 'Continueable',
      onContinue: () => {}
    }))
    expect(markup).toContain('Continue from here')
    expect(markup).toContain('log-turn__continue')
  })
})
