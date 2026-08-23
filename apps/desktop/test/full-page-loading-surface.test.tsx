import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FullPageLoadingSurface } from '../src/renderer/src/components/FullPageLoadingSurface.js'

describe('FullPageLoadingSurface', () => {
  it.each([
    ['loading', 'status', 'true'],
    ['recovering', 'status', 'true'],
    ['failed', 'alert', 'false']
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
    expect(markup).not.toContain('sessionId')
    expect(markup).not.toContain('runId')
  })
})
