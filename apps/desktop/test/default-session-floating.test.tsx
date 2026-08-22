// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { clampDefaultSessionFloatingState } from '../src/renderer/src/lib/default-session-floating.js'

describe('Default Session floating workspace state', () => {
  afterEach(() => window.localStorage.clear())

  it('clamps the persisted Orca-style window inside the viewport', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 })
    const next = clampDefaultSessionFloatingState({ open: true, position: { left: 880, top: 680 }, size: { width: 900, height: 700 } })
    expect(next.size).toEqual({ width: 868, height: 652 })
    expect(next.position).toEqual({ left: 16, top: 32 })
  })
})
