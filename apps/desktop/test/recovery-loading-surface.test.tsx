import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(import.meta.dirname, '..', 'src', 'renderer', 'src', 'components', 'WorkspaceBoard.tsx'), 'utf8')

describe('region loading surface integration', () => {
  it('uses the shared stage for branch and Topic full-region loading while leaving local refreshes alone', () => {
    expect(source.length).toBeGreaterThan(0)
    expect(source.match(/<FullPageLoadingSurface/g) ?? []).toHaveLength(3)
    expect(source).toContain('scope="region" phase="loading"')
    expect(source).toContain('scope="region" phase="failed"')
    expect(source).toContain('className="board-inline-warning"')
  })
})
