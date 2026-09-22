// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BrowserDemonstrationSurface } from '../src/renderer/src/components/BrowserDemonstrationSurface'
import type { BrowserDemonstrationDraft } from '../src/shared/browser-demonstration'

const draft: BrowserDemonstrationDraft = { id: 'draft-1', browserId: 'browser-1', navigationId: 'nav-1', url: 'https://example.test', status: 'recording', revision: 2, startedAt: 1, updatedAt: 2, steps: [
  { id: 'step-1', sequence: 1, recordedAt: 2, navigationId: 'nav-1', source: 'native-human', method: 'fillInput', url: 'https://example.test', args: [], inputKey: 'input-1', blockedReason: 'Supply a fresh parameter before replay; input values were not recorded.', target: { role: 'text input', name: 'Display name', ordinal: 1, count: 1 } },
  { id: 'step-2', sequence: 2, recordedAt: 3, navigationId: 'nav-1', source: 'native-human', method: 'click', url: 'https://example.test', args: [], blockedReason: 'The demonstrated target could not be verified; locate it before replay.' }
] }
const render = (input: BrowserDemonstrationDraft | null, warning?: string) => renderToStaticMarkup(createElement(BrowserDemonstrationSurface, { draft: input, onStart() {}, onStop() {}, ...(warning ? { warning } : {}) }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
describe('BrowserDemonstrationSurface', () => {
  it('leaves one real recording entry when unused, with visible warnings and the original busy boundary', async () => {
    const host = document.createElement('div'), root = createRoot(host), onStart = vi.fn(), onStop = vi.fn()
    const props = { draft: null, onStart, onStop }
    try {
      await act(async () => root.render(createElement(BrowserDemonstrationSurface, props)))
      expect(host.querySelector('header')).toBeNull()
      expect(host.querySelector('ol')).toBeNull()
      expect(host.textContent).toBe('Record demonstration')
      const button = host.querySelector<HTMLButtonElement>('[aria-label="Start recording demonstration"]')!
      expect(button.disabled).toBe(false)
      await act(async () => button.click())
      expect(onStart).toHaveBeenCalledTimes(1)
      expect(onStart.mock.calls[0]?.[0].nativeEvent.type).toBe('click')
      expect(onStop).not.toHaveBeenCalled()
      await act(async () => root.render(createElement(BrowserDemonstrationSurface, {
        ...props, busy: true, warning: 'Draft storage is unavailable; inspect before retrying.'
      })))
      expect(host.querySelector('[role="status"]')?.textContent).toContain('Draft storage is unavailable')
      expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
    } finally { await act(async () => root.unmount()) }
  })
  it('shows nonempty recorded semantic steps, fresh parameter and unknown target reasons with no execute affordance', () => {
    const html = render(draft)
    expect(html).toContain('data-demonstration-id="draft-1"')
    expect(html).toContain('data-sequence="1"')
    expect(html).toContain('data-sequence="2"')
    expect(html).toContain('Display name')
    expect(html).toContain('input-1')
    expect(html).toContain('value not recorded')
    expect(html).toContain('could not be verified')
    expect(html).toContain('Stop recording demonstration')
    expect(html).not.toContain('Run replay')
  })
  it('distinguishes no draft, stopped, interrupted and storage warning without silently resuming recording', () => {
    expect(render(null)).toContain('Start recording demonstration')
    expect(render({ ...draft, status: 'stopped' })).toContain('Draft saved for review')
    const interrupted = render({ ...draft, status: 'interrupted', warning: 'Review after restart' }, 'Storage unavailable; live draft retained')
    expect(interrupted).toContain('Interrupted')
    expect(interrupted).toContain('Storage unavailable')
    expect(interrupted).toContain('Start recording demonstration')
    expect(interrupted).not.toContain('Stop recording demonstration')
  })
})
