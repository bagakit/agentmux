import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

describe('new tab resume shortcut', () => {
  it('renders a resume action from recovery candidates', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../src/renderer/src/components/NewTabSurface.tsx'), 'utf8')
    expect(source).toContain('recoveryCandidates')
    expect(source).toContain('Resume')
  })
})
