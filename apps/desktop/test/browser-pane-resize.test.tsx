import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hasPositiveBrowserStageGeometry } from '../src/renderer/src/lib/browser-bounds-sync.js'

const browserPaneSource = readFileSync(
  new URL('../src/renderer/src/components/BrowserPane.tsx', import.meta.url),
  'utf8'
)

describe('Browser resize continuity', () => {
  it('recognizes transient zero geometry without treating it as a valid viewport', () => {
    expect(hasPositiveBrowserStageGeometry({ width: 0, height: 500 })).toBe(false)
    expect(hasPositiveBrowserStageGeometry({ width: 800, height: 0 })).toBe(false)
    expect(hasPositiveBrowserStageGeometry({ width: 800, height: 500 })).toBe(true)
  })

  it('defers a transient zero stage before the next valid native bounds update', () => {
    const start = browserPaneSource.indexOf('const rect = stage.getBoundingClientRect()')
    const end = browserPaneSource.indexOf('const stageBounds', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const wiring = browserPaneSource.slice(start, end)
    expect(wiring).toContain('hasPositiveBrowserStageGeometry(rect)')
    expect(wiring).toContain('if (!hasPositiveBrowserStageGeometry(rect)) return')
  })
})
