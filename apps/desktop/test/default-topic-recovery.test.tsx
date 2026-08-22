import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Default Topic recovery', () => {
  it('keeps the canonical launcher Topic and topbar recovery path', () => {
    const source = readFileSync(new URL('../src/renderer/src/components/DefaultSessionEntry.tsx', import.meta.url), 'utf8')
    expect(source).toContain("openScratchTopic('launcher:default')")
    expect(source).toContain('respectHidden')
  })
})
