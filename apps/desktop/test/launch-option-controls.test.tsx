import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LaunchOption } from '@agentmux/core'
import { LaunchOptionControls } from '../src/renderer/src/components/LaunchOptionControls.js'

const sandbox: LaunchOption = {
  id: 'sandbox',
  label: 'Sandbox',
  description: 'How much of the machine the agent may touch.',
  choices: [
    { id: 'read-only', label: 'Read only', tier: 'safe' },
    { id: 'workspace-write', label: 'Workspace write', tier: 'caution' },
    { id: 'danger-full-access', label: 'Full access', tier: 'danger' }
  ]
}

const approval: LaunchOption = {
  id: 'approval',
  label: 'Approval policy',
  choices: [
    { id: 'on-request', label: 'On request', tier: 'caution' },
    { id: 'never', label: 'Never', tier: 'danger' }
  ]
}

describe('LaunchOptionControls', () => {
  it('renders nothing for a Provider that declares no options', () => {
    // Absence hides — a Provider with no declaration must draw no control at all, not a disabled one.
    const markup = renderToStaticMarkup(createElement(LaunchOptionControls, {
      options: [],
      selection: {},
      onSelect: vi.fn()
    }))
    expect(markup).toBe('')
  })

  it('renders one control per declared option, purely from the declaration', () => {
    const markup = renderToStaticMarkup(createElement(LaunchOptionControls, {
      options: [sandbox, approval],
      selection: {},
      onSelect: vi.fn()
    }))
    // One group per option, every choice as a segment, and the launch-time framing spelled out.
    expect(markup).toContain('Sandbox')
    expect(markup).toContain('Approval policy')
    expect(markup).toContain('Read only')
    expect(markup).toContain('Workspace write')
    expect(markup).toContain('Full access')
    expect(markup).toContain('On request')
    expect(markup).toContain('Never')
    expect(markup).toContain('Launch options')
    expect(markup).toContain('Applied when the agent starts')
    // Tiers surface as data attributes for status-colour, never as invented provider branches.
    expect(markup).toContain('data-tier="danger"')
    expect(markup).toContain('data-tier="caution"')
  })

  it('marks the selected choice pressed and leaves the rest unpressed', () => {
    const markup = renderToStaticMarkup(createElement(LaunchOptionControls, {
      options: [sandbox],
      selection: { sandbox: 'workspace-write' },
      onSelect: vi.fn()
    }))
    expect(markup).toMatch(/Workspace write<\/button>/)
    expect(markup).toContain('launch-option__segment--selected')
    // Exactly one segment is pressed.
    expect((markup.match(/aria-pressed="true"/g) ?? []).length).toBe(1)
  })

  it('sends the picked choice id when an unselected choice is clicked', () => {
    const onSelect = vi.fn()
    const tree = LaunchOptionControls({
      options: [sandbox],
      selection: {},
      onSelect
    }) as unknown as {
      props: { children: [unknown, Array<{ props: { children: [unknown, { props: { children: Array<{ props: { onClick(): void } }> } }] } }>] }
    }
    // options.map produces the second child; its first option renders the segment group last.
    const optionNode = tree.props.children[1][0]
    const segments = optionNode.props.children[1].props.children
    segments[2].props.onClick() // "Full access"
    expect(onSelect).toHaveBeenCalledWith('sandbox', 'danger-full-access')
  })

  it('clears the option (returns to provider default) when the active choice is clicked again', () => {
    const onSelect = vi.fn()
    const tree = LaunchOptionControls({
      options: [sandbox],
      selection: { sandbox: 'read-only' },
      onSelect
    }) as unknown as {
      props: { children: [unknown, Array<{ props: { children: [unknown, { props: { children: Array<{ props: { onClick(): void } }> } }] } }>] }
    }
    const optionNode = tree.props.children[1][0]
    const segments = optionNode.props.children[1].props.children
    segments[0].props.onClick() // "Read only" — already selected
    expect(onSelect).toHaveBeenCalledWith('sandbox', null)
  })
})
