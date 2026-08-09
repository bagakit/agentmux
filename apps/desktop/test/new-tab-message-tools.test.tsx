import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

describe('new tab message tools wiring', () => {
  it('keeps the shared composer tool available to the new-tab surface', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../src/renderer/src/components/NewTabSurface.tsx'), 'utf8')
    expect(source).toContain('AgentComposerTools')
  })
})
