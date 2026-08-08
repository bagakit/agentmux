// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { TerminalReplayGapNotice } from '../src/renderer/src/components/TerminalReplayGapNotice'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
afterEach(() => { document.body.replaceChildren() })
it.each(['success', 'unavailable', 'failure'] as const)('reports the actual %s outcome of the Redraw button', async (outcome) => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let resolve!: (accepted: boolean) => void, reject!: (error: Error) => void
  const onRedraw = vi.fn(() => new Promise<boolean>((yes, no) => { resolve = yes; reject = no }))
  try {
    await act(async () => root.render(<TerminalReplayGapNotice canRedraw onRedraw={onRedraw} />))
    const button = container.querySelector('button')!
    await act(async () => button.click())
    expect(onRedraw).toHaveBeenCalledOnce()
    expect(button.disabled).toBe(true)
    expect(container.textContent).toContain('Requesting')
    await act(async () => { if (outcome === 'failure') reject(new Error('resize failed')); else resolve(outcome === 'success') })
    if (outcome === 'success') {
      expect(container.querySelector('button')).toBeNull()
      expect(container.textContent).not.toContain('Earlier scrollback')
      expect(container.querySelector('[role="status"]')?.getAttribute('title')).toContain('cannot restore missing history')
      expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toContain('Screen redraw requested')
    } else {
      expect(button.disabled).toBe(false)
      expect(container.textContent).toContain(outcome === 'failure' ? 'resize failed' : 'not ready')
    }
  } finally { await act(async () => root.unmount()) }
})
it('TerminalView returns the real viewport outcome to the visible notice', () => {
  const source = readFileSync('apps/desktop/src/renderer/src/components/TerminalView.tsx', 'utf8')
  expect(source.length).toBeGreaterThan(0)
  expect(source).toContain('return await viewport.requestContentRedraw()')
  expect(source).toContain('onRedraw={redrawCurrentScreen}')
})
