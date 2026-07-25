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

  it('offers a single ■ that names interrupting THIS turn, not stopping the session', () => {
    // The button calls Core's semantic interrupt, which ends the current turn and leaves the Run alive.
    // Terminating the whole session is a different action living in the Tabbar, so this one must not say
    // "Stop" — a word a user reads as "I lose the session", which makes them afraid to press it. The mark
    // is ■ and the accessible name says "current turn"; the two entry points stay tellable apart.
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: 'Some text',
      disabled: false,
      placeholder: 'Ask the Agent…',
      primaryAction: 'stop',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onInterrupt: vi.fn()
    }))

    expect(markup).toContain('composer-send--working')
    expect(markup).toContain('aria-label="Interrupt the current turn"')
    // The mark carries it: a filled ■ glyph, no word that could be read as ending the session.
    expect(markup).toContain('lucide-square')
    expect(markup).not.toContain('>Stop')
    // Exactly one primary action — Send is not also present while a turn is in flight.
    expect(markup).not.toContain('aria-label="Send"')
  })

  it('submits on Enter whether the primary action is Send or Stop — a working Agent can be steered', () => {
    // The bug: one !isWorking flag made the working state swallow Enter, so a running Agent could only be
    // stopped, never steered. Enter now submits in BOTH modes; Stop stays a button click, so mid-turn
    // Enter can never be an accidental stop. Delivery (incl. codex's mid-turn refusal) is Core's call.
    const onSubmit = vi.fn()
    const onInterrupt = vi.fn()

    const idleComposer = AgentComposer({
      value: 'Fix bug',
      disabled: false,
      placeholder: 'Ask the Agent…',
      primaryAction: 'send',
      onChange: vi.fn(),
      onSubmit,
      onInterrupt
    }) as unknown as { props: { children: [ { props: { onKeyDown(e: unknown): void } } ] } }

    const idleTextarea = idleComposer.props.children[0]
    const preventDefault = vi.fn()
    idleTextarea.props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onInterrupt).not.toHaveBeenCalled()

    onSubmit.mockClear()
    preventDefault.mockClear()

    // While working (primaryAction 'stop'): Enter STILL submits the steer, and never interrupts.
    const workingComposer = AgentComposer({
      value: 'Actually, try the other file',
      disabled: false,
      placeholder: 'Ask the Agent…',
      primaryAction: 'stop',
      onChange: vi.fn(),
      onSubmit,
      onInterrupt
    }) as unknown as { props: { children: [ { props: { onKeyDown(e: unknown): void } } ] } }

    const workingTextarea = workingComposer.props.children[0]
    workingTextarea.props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onInterrupt).not.toHaveBeenCalled()
  })

  it('does not submit while an IME is confirming a candidate', () => {
    const onSubmit = vi.fn()
    const composer = AgentComposer({
      value: '中文草稿',
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onSubmit
    }) as unknown as { props: { children: [{ props: { onKeyDown(e: unknown): void } }] } }
    const textarea = composer.props.children[0]
    const preventDefault = vi.fn()

    // macOS/Chromium reports the candidate-confirming Enter with isComposing. Some IMEs use the
    // legacy keyCode=229 instead, so both signals must remain submit-safe.
    textarea.props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      isComposing: true,
      nativeEvent: { isComposing: true },
      keyCode: 13,
      preventDefault
    })
    textarea.props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      nativeEvent: { isComposing: false },
      keyCode: 229,
      preventDefault
    })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
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
