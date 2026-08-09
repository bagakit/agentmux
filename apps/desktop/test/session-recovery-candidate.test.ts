import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

describe('session recovery candidate', () => {
  it('keeps candidate identity visible on failure', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../src/renderer/src/store.ts'), 'utf8')
    expect(source).toContain('recoveryCandidateSession')
    expect(source).toContain('provider-resume-unsupported')
  })
})
