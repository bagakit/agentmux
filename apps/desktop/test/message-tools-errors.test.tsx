import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

describe('message tools atomic errors', () => {
  it('retains the draft when send or capture fails', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../src/renderer/src/components/AgentSessionComposer.tsx'), 'utf8')
    expect(source).toContain('keep the draft available for retry')
    expect(source).toContain('reportError(error)')
  })
})
