import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/renderer/src/components/FileSourceEditor.tsx', import.meta.url), 'utf8')

describe('EditorPane Monaco theme wiring', () => {
  it('uses one resolved theme for edit and diff surfaces', () => {
    const shell = readFileSync(new URL('../src/renderer/src/components/EditorPane.tsx', import.meta.url), 'utf8')
    const hook = readFileSync(new URL('../src/renderer/src/hooks/useMonacoTheme.ts', import.meta.url), 'utf8')
    expect(hook).toContain('monacoThemeForAppAppearance')
    expect(shell).toContain('useMonacoTheme()')
    expect(shell).toContain('theme={monacoTheme}')
    expect(source).toContain('useMonacoTheme()')
    expect(source).toContain('theme={monacoTheme}')
    expect(source).not.toContain('theme="vs-dark"')
  })
})
