import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { allStyles } from './helpers/styles'

// Read all stylesheets, not just focus.css: see focus-layout-contract.test.ts for rationale.
// stylesheet-organisation.test.ts enforces this pattern.
const surface = readFileSync(new URL('../src/renderer/src/components/GlobalFocusSurface.tsx', import.meta.url), 'utf8')
const styles = allStyles()

describe('Focus split resize contract', () => {
  it('wires bounded pointer and keyboard resizing to one accessible handle', () => {
    expect(surface).toContain('className="focus-workspace-resize-handle"')
    expect(surface).toContain('onPointerDown')
    expect(surface).toContain("event.key === 'ArrowLeft'")
    expect(surface).toContain("event.key === 'ArrowRight'")
    expect(surface).toContain('Math.min(0.76, Math.max(0.38, next))')
    expect(styles).toContain('--focus-workspace-width')
    expect(styles).toContain('cursor: col-resize')
  })
})
