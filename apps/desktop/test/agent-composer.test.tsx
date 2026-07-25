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
    expect(markup).toContain('Send')
    expect(markup).not.toContain('composer-send--working')
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
    expect(markup).toContain('Attach')
    expect(markup).toContain('Send')
  })

  it('offers the active-file shortcut only when there is an active file to reference', () => {
    // The shortcut names the open file, so with nothing open it has nothing to say. It hides rather
    // than sitting greyed out next to Attach, which is what made the toolbar read as broken.
    const withoutFile = renderToStaticMarkup(createElement(AgentComposer, {
      value: '',
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onAttach: vi.fn()
    }))
    expect(withoutFile).toContain('Attach')
    expect(withoutFile).not.toContain('lucide-at-sign')

    const withFile = renderToStaticMarkup(createElement(AgentComposer, {
      value: '',
      disabled: false,
      placeholder: 'Ask the Agent…',
      activeFile: 'src/index.ts',
      onChange: vi.fn(),
      onAttach: vi.fn(),
      onReferenceActiveFile: vi.fn()
    }))
    expect(withFile).toContain('lucide-at-sign')
    expect(withFile).toContain('index.ts')
  })

  it('leaves Attach usable whenever the Agent can take input', () => {
    // Attach was permanently inert because no caller ever supplied its handler; it must now be gated
    // only by whether the Agent can accept input at all.
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: '',
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onAttach: vi.fn()
    }))

    expect(markup).not.toContain('not available yet')
    expect(markup).toMatch(/Attach/u)
    // The only disabled control in a live composer with an empty draft is Send.
    expect(markup.match(/disabled=""/gu) ?? []).toHaveLength(1)
  })

  it('switches primary action button to Stop and only displays single Stop action when isWorking is true', () => {
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: 'Some text',
      disabled: false,
      placeholder: 'Ask the Agent…',
      isWorking: true,
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onInterrupt: vi.fn()
    }))

    expect(markup).toContain('composer-send--working')
    expect(markup).toContain('aria-label="Stop turn"')
    expect(markup).toContain('Stop')
    expect(markup).not.toContain('aria-label="Send"')
  })

  it('handles Enter key appropriately for idle and working states', () => {
    const onSubmit = vi.fn()
    const onInterrupt = vi.fn()

    // When idle and non-empty: Enter submits
    const idleComposer = AgentComposer({
      value: 'Fix bug',
      disabled: false,
      placeholder: 'Ask the Agent…',
      isWorking: false,
      onChange: vi.fn(),
      onSubmit,
      onInterrupt
    }) as unknown as { props: { children: [ { props: { onKeyDown(e: unknown): void } } ] } }

    const textarea = idleComposer.props.children[0]
    const preventDefault = vi.fn()
    textarea.props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onInterrupt).not.toHaveBeenCalled()

    onSubmit.mockClear()
    preventDefault.mockClear()

    // When working: Enter does NOT submit and does NOT interrupt
    const workingComposer = AgentComposer({
      value: 'Fix bug',
      disabled: false,
      placeholder: 'Ask the Agent…',
      isWorking: true,
      onChange: vi.fn(),
      onSubmit,
      onInterrupt
    }) as unknown as { props: { children: [ { props: { onKeyDown(e: unknown): void } } ] } }

    const workingTextarea = workingComposer.props.children[0]
    workingTextarea.props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onInterrupt).not.toHaveBeenCalled()
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

