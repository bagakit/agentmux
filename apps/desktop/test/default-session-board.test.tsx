import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Default Session task CUI caller', () => {
  it('uses the canonical task CUI and launcher Topic', () => {
    const source = readFileSync(new URL('../src/renderer/src/components/DefaultSessionEntry.tsx', import.meta.url), 'utf8')
    expect(source).toContain("openScratchTopic('launcher:default')")
    const cli = readFileSync(new URL('../../../packages/core/src/agentmux.ts', import.meta.url), 'utf8')
    expect(cli).toContain("if (args[0] === 'task')")
  })
})
