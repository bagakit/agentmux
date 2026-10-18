import { fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserActivityState, BrowserOperation, BrowserReplayPlan } from '../src/shared/browser-operation.js'
import {
  BrowserOperationStatus,
  BrowserOperationHistory,
  BrowserOperationTimeline,
  BrowserReplayPreview,
  formatClock,
  phaseLabel
} from '../src/renderer/src/components/BrowserOperationSurface.js'

const operation: BrowserOperation = {
  id: 'op-1',
  browserId: 'browser-1',
  operator: { id: 'session-1', name: 'Navigator', providerId: 'codex' },
  startedAt: _hygiene_fixtureTime(-67225600000),
  phase: 'running',
  summary: 'Inspect settings',
  url: 'https://example.test/settings',
  steps: [
    {
      sequence: 1,
      method: 'snapshot',
      label: 'Read page',
      startedAt: _hygiene_fixtureTime(-67225599900),
      finishedAt: _hygiene_fixtureTime(-67225599700),
      status: 'completed',
      summary: '12 semantic nodes'
    },
    {
      sequence: 2,
      method: 'click',
      label: 'Open settings',
      startedAt: _hygiene_fixtureTime(-67225598900),
      status: 'running',
      target: { role: 'button', name: 'Open settings', ordinal: 1, count: 1 }
    }
  ]
}

const activity: BrowserActivityState = { operation, control: 'agent' }
const agentControl = { owner: 'agent', activeOperationId: operation.id, revision: 1, inputIsolation: 'isolated' } as const
const humanControl = { owner: 'human', activeOperationId: null, revision: 2, inputIsolation: 'inactive' } as const
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const plan: BrowserReplayPlan = {
  schema: 'agentmux.browser-replay.v1',
  operationId: 'op-1',
  url: operation.url,
  steps: [
    { method: 'click', url: operation.url, target: { role: 'button', name: 'Open settings', ordinal: 1, count: 1 }, args: [] },
    { method: 'fillInput', url: operation.url, inputKey: 'email', args: [], blockedReason: 'Requires a value' }
  ]
}

describe('BrowserOperationStatus', () => {
  it.each([
    ['snapshot', 'Observing', 'action.inspect'],
    ['js', 'Script', 'object.source-code'],
    ['cdp', 'Command', 'object.source-code'],
    ['gotoUrl', 'Navigating', 'object.browser']
  ])('shows the actual current %s step beside its operator without reviving historical work', (method, cue, icon) => {
    const current = { ...operation, steps: [{ ...operation.steps[1]!, method }] }
    const render = (control: typeof agentControl | typeof humanControl) => renderToStaticMarkup(createElement(BrowserOperationStatus, {
      browserId: operation.browserId, activity: { ...activity, operation: current }, control
    }))
    expect(render(agentControl)).toContain(`browser-operation-status__cue\">${cue}</span>`)
    expect(render(agentControl)).toContain(`data-semantic-icon=\"${icon}\"`)
    expect(render(humanControl)).not.toContain(`browser-operation-status__cue\">${cue}</span>`)
    const foreign = renderToStaticMarkup(createElement(BrowserOperationStatus, {
      browserId: 'another-browser', activity: { ...activity, operation: current }, control: agentControl
    }))
    expect(foreign).toContain('Activity details are loading')
    expect(foreign).not.toContain(`browser-operation-status__cue\">${cue}</span>`)
  })

  it('states the completed handoff while keeping the original result available', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationStatus, {
      browserId: operation.browserId, activity: { ...activity, operation: { ...operation, phase: 'completed' } }, control: humanControl
    }))
    expect(markup).toContain('Completed · You have control')
    expect(markup).toContain('browser-operation-status__cue\">Done</span>')
    expect(markup).not.toContain('data-icon-animation="execute"')
  })

  it('leaves an idle human-owned Browser page unobscured', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationStatus, {
      activity: { operation: null, control: 'human' },
      control: humanControl,
      onOpenTimeline: vi.fn()
    }))
    expect(markup).toContain('data-phase="idle"')
    expect(markup).toContain('Browser activity: You have control')
    expect(markup).not.toContain('Browser ready')
    expect(markup).not.toContain('browser-rsi-rail')
  })

  it('does not claim the Browser is idle while Agent control is active but activity is loading', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationStatus, {
      activity: { operation: null, control: 'agent' },
      control: agentControl,
      onOpenTimeline: vi.fn()
    }))
    expect(markup).toContain('Agent control active')
    expect(markup).toContain('Activity details are loading')
    expect(markup).toContain('data-phase="unknown"')
    expect(markup).not.toContain('No Agent operation')
  })

  it('keeps operator identity, phase and semantic target in the compact disclosure name', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationStatus, {
      activity,
      control: agentControl,
      onTakeControl: vi.fn(),
      onStop: vi.fn(),
      onOpenTimeline: vi.fn()
    }))
    expect(markup).toContain('Navigator')
    expect(markup).toContain('Operating page')
    expect(markup).toContain('button “Open settings”')
    expect(markup).toContain('aria-haspopup="menu"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('Stop browser operation')
  })

  it('states human control without mounting a second action row', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationStatus, {
      activity: { operation: { ...operation, phase: 'human' }, control: 'human' },
      control: humanControl,
      onReturnControl: vi.fn()
    }))
    expect(markup).toContain('Human has control')
    expect(markup).toContain('data-phase="human"')
    expect(markup).not.toContain('Take control')
  })

  it.each(['running', 'completed', 'absent'] as const)('returns a human-owned %s Browser directly without opening its menu or replaying work', async phase => {
    const host = document.createElement('div'), root = createRoot(host)
    const onReturnControl = vi.fn(), onTakeControl = vi.fn(), onStop = vi.fn()
    try {
      await act(async () => root.render(createElement(BrowserOperationStatus, {
        activity: { operation: phase === 'absent' ? null : { ...operation, phase }, control: 'human' },
        control: humanControl, onReturnControl, onTakeControl, onStop
      })))
      const button = host.querySelector<HTMLButtonElement>('button[aria-label="Return to Agent"]')
      expect(button).not.toBeNull()
      expect(button?.closest('[role="menu"]')).toBeNull()
      expect(host.querySelector('[aria-haspopup="menu"]')?.getAttribute('aria-expanded')).toBe('false')
      await act(async () => button!.click())
      expect(onReturnControl).toHaveBeenCalledTimes(1)
      expect(onTakeControl).not.toHaveBeenCalled(); expect(onStop).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
  })

  it.each(['agent', 'unknown', 'human-without-callback'] as const)('does not offer a direct Return for %s', owner => {
    const control = owner === 'human-without-callback' ? humanControl : owner === 'agent' ? agentControl
      : { owner: 'unknown' as const, activeOperationId: null, revision: 3, inputIsolation: 'unconfirmed' as const }
    const markup = renderToStaticMarkup(createElement(BrowserOperationStatus, {
      activity, control, ...(owner === 'human-without-callback' ? {} : { onReturnControl: vi.fn() })
    }))
    expect(markup).not.toContain('aria-label="Return to Agent"')
  })
})

describe('BrowserOperationHistory', () => {
  it('renders selectable durable operations and exposes recovery errors', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationHistory, {
      operations: [operation],
      selectedOperationId: operation.id,
      error: 'Operation history is unavailable.',
      onRetry: vi.fn(),
      onSelect: vi.fn()
    }))
    expect(markup).toContain('Recent operations')
    expect(markup).toContain('Navigator')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('Operation history is unavailable.')
    expect(markup).toContain('Retry')
  })
})

describe('BrowserOperationTimeline', () => {
  it('shows a repeated method label once after real inspection, retaining differing methods, time and failure facts', async () => {
    const host = document.createElement('div'), root = createRoot(host), inspect = vi.fn()
    const steps = [
      { ...operation.steps[0]!, method: 'extractStructured', label: 'extractStructured' },
      { ...operation.steps[1]!, status: 'failed' as const, summary: 'The action failed; recorded fields remain available.' }
    ]
    try {
      await act(async () => root.render(createElement(BrowserOperationTimeline, { operation: { ...operation, steps }, onSelectStep: inspect })))
      expect(host.querySelectorAll('[data-sequence]')).toHaveLength(2)
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Inspect step 1: extractStructured"]')!.click())
      const first = host.querySelector('[data-sequence="1"]')!
      expect(first.querySelector('.browser-rsi-timeline__step-content strong')?.textContent).toBe('extractStructured')
      expect(first.querySelector('.browser-rsi-timeline__step-detail code')).toBeNull()
      expect(first.querySelector('.browser-rsi-timeline__step-detail time')?.textContent).toBe(formatClock(steps[0]!.startedAt))
      expect(inspect.mock.calls).toEqual([[steps[0]]])
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Inspect step 2: Open settings"]')!.click())
      const second = host.querySelector('[data-sequence="2"]')!
      expect(second.querySelector('code')?.textContent).toBe('click')
      expect(second.querySelector('.browser-rsi-timeline__status')?.textContent).toBe('failed')
      expect(second.textContent).toContain('The action failed; recorded fields remain available.')
    } finally { await act(async () => root.unmount()) }
  })
  it('renders ordered facts and keeps step inspection optional', () => {
    const inspect = vi.fn()
    const markup = renderToStaticMarkup(createElement(BrowserOperationTimeline, {
      operation,
      onSelectStep: inspect,
      onReplay: vi.fn()
    }))
    expect(markup).toContain('Activity timeline')
    expect(markup).toContain('data-sequence="1"')
    expect(markup).toContain('data-sequence="2"')
    expect(markup).not.toContain('12 semantic nodes')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('Inspect step 2: Open settings')
    expect(markup).toContain('Replay')
  })

  it('shows semantic target ordinals as one-based positions', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationTimeline, {
      operation: {
        ...operation,
        steps: [{
          ...operation.steps[1]!,
          target: { role: 'button', name: 'Open settings', ordinal: 1, count: 2 }
        }]
      }
    }))
    expect(markup).toContain('button “Open settings” · 1/2')
  })

  it('states the empty timeline instead of rendering a vacuous list', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationTimeline, {
      operation: { ...operation, steps: [] }
    }))
    expect(markup).toContain('Waiting for the first observed action')
    expect(markup).not.toContain('data-sequence=')
  })
})

describe('BrowserReplayPreview', () => {
  it('exposes semantic steps and blocks unsafe plans until review is complete', () => {
    const markup = renderToStaticMarkup(createElement(BrowserReplayPreview, {
      plan,
      onPreview: vi.fn(),
      onStep: vi.fn(),
      onRun: vi.fn(),
      onClose: vi.fn()
    }))
    expect(markup).toContain('Replay preview')
    expect(markup).toContain('button “Open settings”')
    expect(markup).toContain('Requires email')
    expect(markup).toContain('1 needs review')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('Resolve blocked steps before running')
    expect(markup).toContain('Run replay step 1')
    expect(markup).toContain('Run step')
  })

  it('keeps non-completed receipts visible after replay', () => {
    const markup = renderToStaticMarkup(createElement(BrowserReplayPreview, {
      plan: { ...plan, steps: [plan.steps[0]!] },
      outcome: { kind: 'indeterminate', message: 'The page changed before the result was known.' }
    }))
    expect(markup).toContain('Replay needs review')
    expect(markup).toContain('The page changed before the result was known.')
  })
})

describe('Browser RSI labels', () => {
  it('has honest labels for every operation phase', () => {
    expect(phaseLabel('preparing')).toBe('Preparing operation')
    expect(phaseLabel('human')).toBe('Human has control')
    expect(phaseLabel('indeterminate')).toBe('Needs review')
  })

  it('formats invalid timestamps as an explicit unknown value', () => {
    expect(formatClock(Number.NaN)).toBe('—')
  })
})


describe('Browser protocol wait motion in the original surfaces', () => {
  it('animates only the exact current Agent wait and stops across original phase and control changes', async () => {
    const host = document.createElement('div'), root = createRoot(host), stop = vi.fn(), take = vi.fn()
    const waiting: BrowserActivityState = { operation: { ...operation, phase: 'waiting' }, control: 'agent' }
    const original = structuredClone(waiting)
    document.body.append(host)
    const render = (value: BrowserActivityState) => act(async () => root.render(createElement(BrowserOperationStatus, {
      activity: value, control: value.control === 'human' ? humanControl : agentControl, onStop: stop, onTakeControl: take
    })))
    try {
      await render(waiting)
      expect(host.querySelectorAll('[data-icon-animation="wait"] [data-semantic-icon="status.waiting"]')).toHaveLength(1)
      expect(host.querySelector('button')!.getAttribute('aria-label')).toContain('Navigator · Waiting for page')
      const transitions: BrowserActivityState[] = [
        { operation: { ...operation, phase: 'running' }, control: 'agent' },
        { ...waiting, control: 'human' },
        { operation: { ...operation, phase: 'completed' }, control: 'agent' },
        { operation: { ...operation, phase: 'indeterminate' }, control: 'agent' },
        { operation: null, control: 'agent' }
      ]
      expect(transitions).toHaveLength(5)
      for (const next of transitions) {
        await render(next)
        expect(host.querySelector('[data-icon-animation="wait"]')).toBeNull()
      }
      await render(waiting)
      expect(host.querySelectorAll('[data-icon-animation="wait"]')).toHaveLength(1)
      expect(waiting).toEqual(original)
      expect(stop).not.toHaveBeenCalled()
      expect(take).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()); host.remove() }
  })

  it('keeps recorded waits complete and still while retaining the original history selection', async () => {
    const host = document.createElement('div'), root = createRoot(host), select = vi.fn()
    const recorded = { ...operation, phase: 'waiting' as const }
    document.body.append(host)
    try {
      await act(async () => root.render(createElement(BrowserOperationHistory, {
        operations: [recorded], selectedOperationId: recorded.id, onSelect: select, onRetry: vi.fn()
      })))
      expect(host.querySelectorAll('[data-semantic-icon="status.waiting"]')).toHaveLength(1)
      expect(host.querySelector('[data-icon-animation]')).toBeNull()
      const item = host.querySelector<HTMLButtonElement>('.browser-rsi-history__item')!
      expect(item.getAttribute('aria-pressed')).toBe('true')
      await act(async () => item.click())
      expect(select).toHaveBeenCalledExactlyOnceWith(recorded)
    } finally { await act(async () => root.unmount()); host.remove() }
  })
})
