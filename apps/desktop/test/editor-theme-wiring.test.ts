import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/renderer/src/components/EditorPane.tsx', import.meta.url), 'utf8')

describe('EditorPane Monaco theme wiring', () => {
  it('uses one resolved theme for edit and diff surfaces', () => {
    expect(source).toContain('monacoThemeForAppAppearance')
    expect(source).toContain('theme={theme}')
    expect(source).toContain('theme={monacoTheme}')
    expect(source).not.toContain('theme="vs-dark"')
  })
})
