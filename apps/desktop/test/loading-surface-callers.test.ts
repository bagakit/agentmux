import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', 'src', 'renderer', 'src')
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .filter((entry): entry is string => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => join(dir, entry))
}

describe('full-page loading production callers', () => {
  it('has real callers outside the shared definition', () => {
    const definition = join(root, 'components', 'FullPageLoadingSurface.tsx')
    const callers = filesUnder(root).filter((file) => file !== definition && readFileSync(file, 'utf8').includes('FullPageLoadingSurface'))
    expect(callers.length).toBeGreaterThanOrEqual(2)
    expect(callers.map((file) => file.replace(`${root}/`, '')).sort()).toEqual([
      'App.tsx',
      'components/TerminalView.tsx',
      'components/WorkspaceBoard.tsx'
    ])
  })
})
