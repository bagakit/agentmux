import { describe, expect, it } from 'vitest'
import { monacoThemeForAppAppearance } from '../src/renderer/src/lib/monaco-theme.js'

describe('Monaco theme follows app appearance', () => {
  it('maps explicit and system appearance to Monaco themes', () => {
    expect(monacoThemeForAppAppearance('dark', false)).toBe('vs-dark')
    expect(monacoThemeForAppAppearance('light', true)).toBe('vs')
    expect(monacoThemeForAppAppearance('system', true)).toBe('vs-dark')
    expect(monacoThemeForAppAppearance('system', false)).toBe('vs')
    expect(monacoThemeForAppAppearance(undefined, false)).toBe('vs-dark')
  })
})
