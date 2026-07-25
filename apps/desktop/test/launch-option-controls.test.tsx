import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LaunchOption } from '@agentmux/core'
import {
  CLAUDE_LAUNCH_OPTIONS,
  CODEX_LAUNCH_OPTIONS,
  CURSOR_LAUNCH_OPTIONS,
  describeLaunchOptions
} from '@agentmux/core'
import { LaunchRefine } from '../src/renderer/src/components/LaunchOptionControls.js'

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

describe('LaunchRefine', () => {
  it('renders nothing for a Provider that declares no options', () => {
    // Absence hides — a Provider with no declaration must draw no toggle, no panel, no placeholder.
    const markup = renderToStaticMarkup(createElement(LaunchRefine, {
      options: [],
      selection: {},
      expanded: false,
      onToggle: vi.fn(),
      onSelect: vi.fn()
    }))
    expect(markup).toBe('')
  })

  it('shows a collapsed toggle with the option count and no panel while collapsed', () => {
    const markup = renderToStaticMarkup(createElement(LaunchRefine, {
      options: [sandbox, approval],
      selection: {},
      expanded: false,
      onToggle: vi.fn(),
      onSelect: vi.fn()
    }))
    // The ghost toggle is always present, labelled, and announces the count for aria/glance.
    expect(markup).toContain('Launch options')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('launch-refine__count')
    // Collapsed = no expanded panel and no per-option controls rendered.
    expect(markup).not.toContain('launch-refine__panel')
    expect(markup).not.toContain('launch-option__segment')
  })

  it('summarises the untouched posture as provider defaults', () => {
    const markup = renderToStaticMarkup(createElement(LaunchRefine, {
      options: [sandbox, approval],
      selection: {},
      expanded: false,
      onToggle: vi.fn(),
      onSelect: vi.fn()
    }))
    // No choice picked => honest empty state that contributes no argv, inviting expansion.
    expect(markup).toContain('launch-refine__summary--empty')
    expect(markup).toContain('2 options · provider defaults')
  })

  it('summarises a touched posture with tier-tinted value labels', () => {
    const markup = renderToStaticMarkup(createElement(LaunchRefine, {
      options: [sandbox, approval],
      selection: { sandbox: 'danger-full-access', approval: 'never' },
      expanded: false,
      onToggle: vi.fn(),
      onSelect: vi.fn()
    }))
    // Values only (glanceable), each carrying its tier so a dangerous posture reads without expanding.
    expect(markup).toContain('Full access')
    expect(markup).toContain('Never')
    expect(markup).not.toContain('launch-refine__summary--empty')
    expect((markup.match(/data-tier="danger"/g) ?? []).length).toBe(2)
  })

  it('renders one hairline row per option with every choice as a segment when expanded', () => {
    const markup = renderToStaticMarkup(createElement(LaunchRefine, {
      options: [sandbox, approval],
      selection: {},
      expanded: true,
      onToggle: vi.fn(),
      onSelect: vi.fn()
    }))
    expect(markup).toContain('launch-refine__panel')
    expect(markup).toContain('Sandbox')
    expect(markup).toContain('Approval policy')
    expect(markup).toContain('Read only')
    expect(markup).toContain('Workspace write')
    expect(markup).toContain('Full access')
    expect(markup).toContain('On request')
    expect(markup).toContain('Never')
    // Tiers surface as data attributes on the segments for status-colour, never as provider branches.
    expect(markup).toContain('data-tier="danger"')
    expect(markup).toContain('data-tier="caution"')
  })

  it('marks the selected choice pressed and leaves the rest unpressed when expanded', () => {
    const markup = renderToStaticMarkup(createElement(LaunchRefine, {
      options: [sandbox],
      selection: { sandbox: 'workspace-write' },
      expanded: true,
      onToggle: vi.fn(),
      onSelect: vi.fn()
    }))
    expect(markup).toMatch(/Workspace write<\/button>/)
    expect(markup).toContain('launch-option__segment--selected')
    // Exactly one segment is pressed.
    expect((markup.match(/aria-pressed="true"/g) ?? []).length).toBe(1)
  })

  it('fires onToggle when the collapsed toggle is clicked', () => {
    const onToggle = vi.fn()
    const tree = LaunchRefine({
      options: [sandbox],
      selection: {},
      expanded: false,
      onToggle,
      onSelect: vi.fn()
    }) as unknown as { props: { children: [{ props: { onClick(): void } }, unknown] } }
    tree.props.children[0].props.onClick()
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('sends the picked choice id when an unselected choice is clicked', () => {
    const onSelect = vi.fn()
    const tree = LaunchRefine({
      options: [sandbox],
      selection: {},
      expanded: true,
      onToggle: vi.fn(),
      onSelect
    }) as unknown as {
      props: { children: [unknown, { props: { children: Array<{ props: { children: [unknown, { props: { children: Array<{ props: { onClick(): void } }> } }] } }> } }] }
    }
    // The expanded panel is the second child; its first row renders the segment group as its second child.
    const rowNode = tree.props.children[1].props.children[0]
    const segments = rowNode.props.children[1].props.children
    segments[2].props.onClick() // "Full access"
    expect(onSelect).toHaveBeenCalledWith('sandbox', 'danger-full-access')
  })

  it('clears the option (returns to provider default) when the active choice is clicked again', () => {
    const onSelect = vi.fn()
    const tree = LaunchRefine({
      options: [sandbox],
      selection: { sandbox: 'read-only' },
      expanded: true,
      onToggle: vi.fn(),
      onSelect
    }) as unknown as {
      props: { children: [unknown, { props: { children: Array<{ props: { children: [unknown, { props: { children: Array<{ props: { onClick(): void } }> } }] } }> } }] }
    }
    const rowNode = tree.props.children[1].props.children[0]
    const segments = rowNode.props.children[1].props.children
    segments[0].props.onClick() // "Read only" — already selected
    expect(onSelect).toHaveBeenCalledWith('sandbox', null)
  })
})

// The launcher (NewTabSurface) reads options purely from the selected Provider's catalog declaration —
// `providerCatalog.find(entry => entry.id === selectedProviderId)?.launchOptions`, no providerId branch.
// The catalog carries the DESCRIBE half projected through describeLaunchOptions (agent-provider.ts), so
// projecting the SAME SSOT constant here reproduces exactly what the launcher hands LaunchRefine when each
// Provider is selected. This proves the T-001 declaration reaches the launcher through the sealed contract
// with NO renderer change — and that codex/cursor, declaring no model/effort, grow no such control.
describe('claude model/effort reach the launcher through the sealed catalog projection', () => {
  const launcherOptionsFor = (declarations: Parameters<typeof describeLaunchOptions>[0]): LaunchOption[] =>
    describeLaunchOptions(declarations)

  it('renders model and effort groups when claude is the selected Provider', () => {
    const markup = renderToStaticMarkup(createElement(LaunchRefine, {
      options: launcherOptionsFor(CLAUDE_LAUNCH_OPTIONS),
      selection: {},
      expanded: true,
      onToggle: vi.fn(),
      onSelect: vi.fn()
    }))
    // The two new option groups are present by their declared labels, alongside the unchanged permission-mode.
    expect(markup).toContain('Model')
    expect(markup).toContain('Effort')
    expect(markup).toContain('Permission mode')
    // Each group's enumerated choices render as segments — proving the whole declaration crossed, not a stub.
    for (const label of ['Fable', 'Opus', 'Sonnet', 'Low', 'Medium', 'High', 'Extra high', 'Max']) {
      expect(markup).toContain(label)
    }
    // argv NEVER reaches the renderer: the DESCRIBE half carries labels only, so the flag tokens the spawn
    // path uses are absent from what the user's browser ever sees.
    expect(markup).not.toContain('--model')
    expect(markup).not.toContain('--effort')
  })

  it('grows no model or effort control for codex or cursor — absence hides, it never disables', () => {
    for (const declarations of [CODEX_LAUNCH_OPTIONS, CURSOR_LAUNCH_OPTIONS]) {
      const options = launcherOptionsFor(declarations)
      // Neither provider declares a model or effort option, so the launcher hands LaunchRefine none.
      expect(options.some((option) => option.id === 'model' || option.id === 'effort')).toBe(false)
      const markup = renderToStaticMarkup(createElement(LaunchRefine, {
        options,
        selection: {},
        expanded: true,
        onToggle: vi.fn(),
        onSelect: vi.fn()
      }))
      // The expanded panel draws these providers' real options but no Model/Effort group heading, and no
      // launch argv leaks into the markup.
      expect(markup).not.toContain('>Model<')
      expect(markup).not.toContain('>Effort<')
      expect(markup).not.toContain('--model')
      expect(markup).not.toContain('--effort')
    }
  })
})
