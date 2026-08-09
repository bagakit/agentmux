import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

describe('global message tools contract', () => {
  it('exposes capture, skills and provider commands from the shared composer tool', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../src/renderer/src/components/AgentComposerTools.tsx'), 'utf8')
    expect(source).toContain('Capture')
    expect(source).toContain('Skills')
    expect(source).toContain('Commands')
  })
})
