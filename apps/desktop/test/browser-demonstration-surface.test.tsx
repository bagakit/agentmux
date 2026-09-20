import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BrowserDemonstrationSurface } from '../src/renderer/src/components/BrowserDemonstrationSurface'
import type { BrowserDemonstrationDraft } from '../src/shared/browser-demonstration'

const draft: BrowserDemonstrationDraft = { id: 'draft-1', browserId: 'browser-1', navigationId: 'nav-1', url: 'https://example.test', status: 'recording', revision: 2, startedAt: 1, updatedAt: 2, steps: [
  { id: 'step-1', sequence: 1, recordedAt: 2, navigationId: 'nav-1', source: 'native-human', method: 'fillInput', url: 'https://example.test', args: [], inputKey: 'input-1', blockedReason: 'Supply a fresh parameter before replay; input values were not recorded.', target: { role: 'text input', name: 'Display name', ordinal: 1, count: 1 } },
  { id: 'step-2', sequence: 2, recordedAt: 3, navigationId: 'nav-1', source: 'native-human', method: 'click', url: 'https://example.test', args: [], blockedReason: 'The demonstrated target could not be verified; locate it before replay.' }
] }
const render = (input: BrowserDemonstrationDraft | null, warning?: string) => renderToStaticMarkup(createElement(BrowserDemonstrationSurface, { draft: input, onStart() {}, onStop() {}, ...(warning ? { warning } : {}) }))
describe('BrowserDemonstrationSurface', () => {
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
