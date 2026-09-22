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
  it('leaves an idle human-owned Browser page unobscured', () => {
    const markup = renderToStaticMarkup(createElement(BrowserOperationStatus, {
      activity: { operation: null, control: 'human' },
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
      onReturnControl: vi.fn()
    }))
    expect(markup).toContain('Human has control')
    expect(markup).toContain('data-phase="human"')
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
