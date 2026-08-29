import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workbenchSource = readFileSync(
  new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url),
  'utf8'
)

describe('native Browser visibility during renderer overlays', () => {
  it('hides window-level native surfaces only while an overlay lease is held', () => {
    const start = workbenchSource.indexOf('const nativeSurfaceOverlayCount')
    const end = workbenchSource.indexOf('nativeSurfacesVisible={', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const wiring = workbenchSource.slice(start, end + 120)
    expect(wiring).toContain('useAppStore((state) => state.nativeSurfaceOverlayCount)')
    expect(wiring).toContain('nativeSurfaceOverlayCount === 0')
  })
})
