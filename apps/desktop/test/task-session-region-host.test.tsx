// @vitest-environment happy-dom
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { SessionRegionHost, sessionRegionHostClassName } from '../src/renderer/src/components/SessionRegionHost.js'

describe('SessionRegionHost', () => {
  it('keeps the three supported arrangements explicit', () => {
    expect(sessionRegionHostClassName('columns')).toBe('session-region-host session-region-host--columns')
    expect(sessionRegionHostClassName('grid')).toBe('session-region-host session-region-host--grid')
    expect(sessionRegionHostClassName('balanced')).toBe('session-region-host session-region-host--balanced')
  })

  it('is only a presentation host and does not manufacture Session lifecycle props', () => {
    const element = createElement(SessionRegionHost, { arrangement: 'grid', children: createElement('span', null, 'existing session') })
    expect(element.props.arrangement).toBe('grid')
    expect(element.props.children.props.children).toBe('existing session')
    expect(Object.keys(element.props)).not.toContain('sessionId')
  })
})
