import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FullPageLoadingSurface } from '../src/renderer/src/components/FullPageLoadingSurface.js'

describe('FullPageLoadingSurface', () => {
  it.each([
    ['loading', 'status', 'true'],
    ['recovering', 'status', 'true'],
    ['failed', 'alert', 'false'],
    ['parked', 'status', 'false']
  ] as const)('renders %s as an accessible shared stage', (phase, role, busy) => {
    const markup = renderToStaticMarkup(createElement(FullPageLoadingSurface, {
      phase,
      scope: 'app',
      eyebrow: 'AgentMux boot sequence',
      title: 'Starting AgentMux',
      detail: 'Starting the local Runtime.',
      actions: phase === 'failed' ? createElement('button', { className: 'small-button' }, 'Retry startup') : undefined
    }))
    expect(markup).toContain(`data-loading-phase="${phase}"`)
    expect(markup).toContain('data-loading-scope="app"')
    expect(markup).toContain(`role="${role}"`)
    expect(markup).toContain(`aria-busy="${busy}"`)
    expect(markup).toContain('AgentMux boot sequence')
    expect(markup).toContain('Starting the local Runtime.')
    expect(markup.includes('full-page-loading__activity')).toBe(busy === 'true')
    expect(markup).toContain('full-page-loading__atmosphere')
    expect(markup).toContain('settings-banner.png')
    if (phase === 'failed') expect(markup).toContain('Retry startup')
  })

  it('keeps region scope and the stage copy independent of Runtime facts', () => {
    const markup = renderToStaticMarkup(createElement(FullPageLoadingSurface, {
      phase: 'recovering',
      scope: 'region',
      eyebrow: 'Project board',
      title: 'Loading branches',
      detail: 'Reading Git truth from Alpha.'
    }))
    expect(markup).toContain('full-page-loading--region')
    expect(markup).toContain('Loading branches')
    expect(markup).toContain('Reading Git truth from Alpha.')
    expect(markup).not.toContain('full-page-loading__atmosphere')
    expect(markup).not.toContain('settings-banner.png')
    expect(markup).not.toContain('sessionId')
    expect(markup).not.toContain('runId')
  })

  it('keeps original actions before secondary reading and details without replacing children semantics', () => {
    const props = { phase: 'recovering' as const, scope: 'region' as const, title: 'Original title', detail: 'Original detail',
      supplement: createElement('p', {}, 'Observed recap'),
      details: { summary: 'Original diagnostics', content: createElement('p', {}, 'Owner facts') },
      actions: createElement('button', {}, 'Original action') }
    const markup = renderToStaticMarkup(createElement(FullPageLoadingSurface, props))
    const positions = ['Original title', 'full-page-loading__activity', 'Original action', 'Original detail', 'Observed recap', 'Original diagnostics']
      .map(text => markup.indexOf(text))
    expect(positions).toHaveLength(6)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    for (const position of positions) expect(position).toBeGreaterThan(-1)
    const custom = renderToStaticMarkup(createElement(FullPageLoadingSurface, props, createElement('p', {}, 'Original custom stage')))
    expect(custom).toContain('Original custom stage')
    expect(custom).toContain('Observed recap')
    expect(custom).not.toContain('Original title')
    expect(custom).not.toContain('Original detail')
  })
})
