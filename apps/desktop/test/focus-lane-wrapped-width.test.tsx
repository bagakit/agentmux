// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { allocateFocusLaneColumns } from '../src/renderer/src/lib/focus-lane-layout'
import { FocusLaneGroups } from '../src/renderer/src/components/FocusLaneGroups'

const metrics = (width: number) => ({ width, padding: 4, gap: 2, cardGap: 2 })

it('shares each wrapped row instead of leaving all states at minimum width', () => {
  const layout = allocateFocusLaneColumns([0, 1, 8, 2], metrics(500))
  expect(layout.columns).toEqual([0, 1, 1, 1])
  expect(layout.widths).toEqual([0, 247, 247, 320])
  expect(layout.maxRows).toBe(8)
  expect(allocateFocusLaneColumns([1, 1, 8, 2], metrics(500)).widths).toEqual([247, 247, 247, 247])
})

it('uses a readable full row when narrow and retains the existing cap when wide', () => {
  expect(allocateFocusLaneColumns([0, 1, 8, 2], metrics(320)).widths).toEqual([0, 316, 316, 316])
  expect(allocateFocusLaneColumns([1, 1, 1, 1], metrics(176)).widths).toEqual([172, 172, 172, 172])
  const wide = allocateFocusLaneColumns([0, 1, 8, 2], metrics(1000))
  expect(wide.columns).toEqual([0, 1, 3, 1])
  expect(wide.widths[1]! + wide.widths[2]! + wide.widths[3]! + 4).toBeCloseTo(996)
  expect(allocateFocusLaneColumns([0, 1, 0, 0], metrics(2000)).widths).toEqual([0, 320, 0, 0])
})

it('the mounted layout consumer resizes original card nodes without changing their identity', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createRoot(container)
  document.body.append(container)
  const render = (width: number) => act(async () => root.render(createElement(FocusLaneGroups, {
    counts: [0, 1, 8, 2], metrics: metrics(width), children: layout => createElement('button', {
      'data-session-id': 'original', className: 'focus-context', style: { width: layout.widths[1] }
    }, 'Original Session')
  })))
  try {
    await render(500)
    const card = container.querySelector('button')!
    expect(card.style.width).toBe('247px')
    await render(320)
    expect(container.querySelector('button')).toBe(card)
    expect(card.style.width).toBe('316px')
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})
