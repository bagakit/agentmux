import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserActivityState, BrowserOperation, BrowserReplayPlan } from '../src/shared/browser-operation.js'
import {
  BrowserOperationRail,
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
  startedAt: 1_700_000_000_000,
  phase: 'running',
  summary: 'Inspect settings',
  url: 'https://example.test/settings',
  steps: [
    {
      sequence: 1,
      method: 'snapshot',
      label: 'Read page',
      startedAt: 1_700_000_000_100,
      finishedAt: 1_700_000_000_300,
      status: 'completed',
      summary: '12 semantic nodes'
    },
    {
      sequence: 2,
      method: 'click',
      label: 'Open settings',
      startedAt: 1_700_000_001_100,
      status: 'running',
      target: { role: 'button', name: 'Open settings', ordinal: 1, count: 1 }
    }
  ]
}

const activity: BrowserActivityState = { operation, control: 'agent' }

const plan: BrowserReplayPlan = {
  schema: 'agentmux.browser-replay.v1',
  operationId: 'op-1',
  url: operation.url,
  steps: [
    { method: 'click', url: operation.url, target: { role: 'button', name: 'Open settings', ordinal: 1, count: 1 }, args: [] },
    { method: 'fillInput', url: operation.url, inputKey: 'email', args: [], blockedReason: 'Requires a value' }
  ]
}

describe('BrowserOperationRail', () => {
  it('leaves an idle human-owned Browser page unobscured', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationRail, {
      activity: { operation: null, control: 'human' },
      onOpenTimeline: vi.fn()
    }))
    expect(markup).toContain('browser-rsi-rail--quiet')
    expect(markup).toContain('Open browser activity timeline')
    expect(markup).not.toContain('Browser ready')
    expect(markup).not.toContain('You have control')
  })

  it('does not claim the Browser is idle while Agent control is active but activity is loading', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationRail, {
      activity: { operation: null, control: 'agent' },
      onOpenTimeline: vi.fn()
    }))
    expect(markup).toContain('Agent control active')
    expect(markup).toContain('Activity details are loading')
    expect(markup).toContain('Open browser activity timeline')
    expect(markup).not.toContain('No Agent operation')
  })

  it('keeps operator identity, phase and semantic target visible', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationRail, {
      activity,
      onTakeControl: vi.fn(),
      onStop: vi.fn(),
      onOpenTimeline: vi.fn()
    }))
    expect(markup).toContain('Navigator')
    expect(markup).toContain('Operating page')
    expect(markup).toContain('button “Open settings”')
    expect(markup).toContain('Take control')
    expect(markup).toContain('Stop browser operation')
    expect(markup).toContain('Open browser activity timeline')
  })

  it('shows explicit return affordance only while the human owns control', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationRail, {
      activity: { operation: { ...operation, phase: 'human' }, control: 'human' },
      onReturnControl: vi.fn()
    }))
    expect(markup).toContain('Return to Agent')
    expect(markup).not.toContain('Take control')
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
    expect(markup).toContain('12 semantic nodes')
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
