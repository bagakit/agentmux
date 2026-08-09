import { describe, expect, it } from 'vitest'
import { resolveAppAppearance } from '../src/renderer/src/lib/app-appearance.js'

describe('application appearance', () => {
  it('resolves explicit modes and follows the OS when requested', () => {
    expect(resolveAppAppearance('dark', false)).toBe('dark')
    expect(resolveAppAppearance('light', true)).toBe('light')
    expect(resolveAppAppearance('system', true)).toBe('dark')
    expect(resolveAppAppearance('system', false)).toBe('light')
    expect(resolveAppAppearance(undefined, false)).toBe('dark')
  })
})
