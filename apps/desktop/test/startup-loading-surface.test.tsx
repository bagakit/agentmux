import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(import.meta.dirname, '..', 'src', 'renderer', 'src', 'App.tsx'), 'utf8')

describe('startup loading surface integration', () => {
  it('mounts the shared app stage for startup and failure without keeping the old spinner boot markup', () => {
    expect(source.length).toBeGreaterThan(0)
    expect(source).toContain('<FullPageLoadingSurface scope="app" phase="loading"')
    expect(source).toContain('<FullPageLoadingSurface scope="app" phase="failed"')
    expect(source).not.toContain('className="boot"')
    expect(source).not.toContain('LoaderCircle')
  })
})
