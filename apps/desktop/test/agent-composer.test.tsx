import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentComposer } from '../src/renderer/src/components/AgentComposer.js'

const styles = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

describe('AgentComposer reusable surface', () => {
  it('renders from controlled props without a Session Store', () => {
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: 'Review this file',
      disabled: false,
      placeholder: 'Ask the Agent…',
      activeFile: 'src/review.ts',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onInterrupt: vi.fn(),
      onReferenceActiveFile: vi.fn()
    }))

    expect(markup).toContain('data-agent-composer="true"')
    expect(markup).toContain('aria-label="Message Agent"')
    expect(markup).toContain('Review this file')
    expect(markup).toContain('review.ts')
    expect(markup).toContain('Stop turn')
    expect(markup).toContain('Send')
    expect(markup).not.toMatch(/<textarea[^>]*disabled=""/)
  })

  it('keeps the whole rich-input surface visible while disabled', () => {
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: '',
      disabled: true,
      placeholder: 'Agent is not running',
      onChange: vi.fn()
    }))

    expect(markup).toContain('data-agent-composer="true"')
    expect(markup).toContain('placeholder="Agent is not running"')
    expect(markup).toMatch(/<textarea[^>]*disabled=""/)
    expect(markup).toContain('File')
    expect(markup).toContain('Attach')
    expect(markup).toContain('Stop turn')
    expect(markup).toContain('Send')
  })

  it('uses a transparent surface without a black drop shadow', () => {
    const baseRule = styles.match(/\.composer \{([^}]*)\}/)?.[1]
    const focusRule = styles.match(/\.composer:focus-within \{([^}]*)\}/)?.[1]

    expect(baseRule).toContain('background: transparent')
    expect(baseRule).toContain('box-shadow: none')
    expect(focusRule).toContain('box-shadow: var(--focus-ring)')
    expect(focusRule).not.toMatch(/#[0-9a-f]+/i)
  })
})
