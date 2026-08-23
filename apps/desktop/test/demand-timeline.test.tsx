import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Demand timeline projection', () => {
  it('renders activities and decisions in the fixed detail workspace', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/renderer/src/components/GlobalBoardSurface.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('global-demand-workspace__timeline')
    expect(source).toContain('demand.activities')
    expect(source).toContain('demand.decisions')
  })
})
