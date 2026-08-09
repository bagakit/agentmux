import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContinuousProgressPanel } from '../src/renderer/src/components/ContinuousProgressPanel'

describe('continuous progress recovery projection', () => {
  it('renders paused state without a fake countdown', () => {
    const html = renderToStaticMarkup(<ContinuousProgressPanel loop={{ loopId: 'l', providerLabel: 'Codex', executionState: 'unknown', loopState: 'paused', lastDecision: 'Needs inspection' }} />)
    expect(html).toContain('unknown · paused')
    expect(html).toContain('Resume continuous progress')
    expect(html).not.toContain('Next check')
  })
})
