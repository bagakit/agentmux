import { describe, expect, it } from 'vitest'
import { detectLanguage } from '../src/renderer/src/lib/language-detect.js'

describe('Monaco-based language detection', () => {
  it('maps Monaco built-in code and config languages case-insensitively', () => {
    expect(detectLanguage('src/App.TSX')).toBe('typescript')
    expect(detectLanguage('scripts/build.mjs')).toBe('javascript')
    expect(detectLanguage('config/settings.jsonc')).toBe('json')
    expect(detectLanguage('rtl/TOP.SV')).toBe('systemverilog')
    expect(detectLanguage('api/service.proto')).toBe('proto')
  })

  it('maps exact filenames on POSIX and Windows paths', () => {
    expect(detectLanguage('/repo/Dockerfile')).toBe('dockerfile')
    expect(detectLanguage('/repo/.gitignore')).toBe('ini')
  })

  it('covers the custom language registrations beyond Monaco built-ins', () => {
    expect(detectLanguage('src/App.vue')).toBe('vue')
    expect(detectLanguage('src/Widget.svelte')).toBe('svelte')
    expect(detectLanguage('src/Page.astro')).toBe('astro')
    expect(detectLanguage('sessions/log.JSONL')).toBe('jsonl')
  })

  it('does not advertise languages whose tokenizer was intentionally omitted', () => {
    expect(detectLanguage('src/main.nim')).toBe('plaintext')
    expect(detectLanguage('Makefile')).toBe('plaintext')
    expect(detectLanguage('CMakeLists.txt')).toBe('plaintext')
    expect(detectLanguage('diagram.mermaid')).toBe('plaintext')
    expect(detectLanguage('src/main.erl')).toBe('plaintext')
    expect(detectLanguage('src/Main.hs')).toBe('plaintext')
    expect(detectLanguage('data.csv')).toBe('plaintext')
  })

  it('uses registered Monaco ids for notebook and MDX source files', () => {
    expect(detectLanguage('analysis.ipynb')).toBe('json')
    expect(detectLanguage('docs/page.mdx')).toBe('mdx')
  })

  it('returns plaintext for extensionless and unknown files', () => {
    expect(detectLanguage('bin/tool')).toBe('plaintext')
    expect(detectLanguage('notes/file.unknownext')).toBe('plaintext')
  })
})
