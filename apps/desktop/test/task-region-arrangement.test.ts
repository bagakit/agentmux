import { describe, expect, it } from 'vitest'
import { sessionRegionHostClassName } from '../src/renderer/src/components/SessionRegionHost.js'

describe('task Region arrangement', () => {
  it('maps each persisted arrangement to one stable host class', () => {
    expect(['columns', 'grid', 'balanced'].map(sessionRegionHostClassName)).toEqual([
      'session-region-host session-region-host--columns',
      'session-region-host session-region-host--grid',
      'session-region-host session-region-host--balanced'
    ])
  })
})
