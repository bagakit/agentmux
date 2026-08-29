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
    const child = createElement('span', null, 'existing session')
    const element = createElement(SessionRegionHost, { arrangement: 'grid', children: child })
    expect(element.props.arrangement).toBe('grid')
    // 判「children 原样传过去」——比走 `children.props.children` 再挖一层强：那条链上每一节都是
    // `ReactNode`，要靠一串 `as` 才过 tsc，而每个 `as` 都是一处「我说它是这样」的无证断言。
    expect(element.props.children).toBe(child)
    expect(Object.keys(element.props)).not.toContain('sessionId')
  })
})
