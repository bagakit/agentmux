import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContinuousProgressPanel } from '../src/renderer/src/components/ContinuousProgressPanel'

describe('continuous progress panel', () => {
  it('shows provider, split status, next check and actions', () => {
    const html = renderToStaticMarkup(<ContinuousProgressPanel loop={{ loopId: 'l', providerLabel: 'Codex', executionState: 'working', loopState: 'active', nextCheckAt: Date.now(), lastDecision: 'Skipped while busy' }} />)
    expect(html).toContain('Continuous progress · Codex')
    expect(html).toContain('working · active')
    expect(html).toContain('Pause continuous progress')
    expect(html).toContain('Skipped while busy')
  })
})
