const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { createElement } from 'react'
import { renderClientUiMarkup as renderToStaticMarkup } from './helpers/client-ui-render'
import { describe, expect, it, vi } from 'vitest'
import { allStyles } from './helpers/styles.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'

const base = {
  speaker: { role: 'agent' as const, id: 'agent-review' },
  name: 'Review agent',
  providerId: 'codex' as const,
  origin: 1_000,
  createdAt: 2_000,
  workspaceRoot: _hygiene_fixturePath("workspace")
}

describe('ConversationMessage', () => {
  it('keeps a right-docked human bubble while left-aligning its readable body', () => {
    // 整张表而不是 activity-conversation.css 一个文件：这几条规则按表面再拆一刀就会搬走，
    // 而硬编码单文件时扫描面变空、`toContain` / `toMatch` 一条都不红。
    const styles = allStyles()
    expect(styles).toMatch(/\.log-turn__body \{[^}]*white-space: pre-wrap/)
    expect(styles).toContain(".log-turn:not([data-compact='true']):is([data-speaker-role='human'], [data-speaker-relation='other-agent']) {")
    expect(styles).toContain('margin-inline-start: auto')
  })
  it('renders one shared message shape with identity, markdown and quiet time', () => {
    const markup = renderToStaticMarkup(createElement(ConversationMessage, {
      ...base,
      status: 'complete',
      content: 'Answer **ready**.'
    }))
    expect(markup).toContain('class="log-turn"');expect(markup).toContain('data-speaker-role="agent"');expect(markup).toContain('data-status="complete"')
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
