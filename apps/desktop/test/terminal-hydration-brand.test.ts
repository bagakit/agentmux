import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { allStyles } from './helpers/styles.js'

const styles = allStyles()
const terminalView = readFileSync(
  new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url),
  'utf8'
)
const loadingComponent = readFileSync(
  new URL('../src/renderer/src/components/FullPageLoadingSurface.tsx', import.meta.url),
  'utf8'
)

function restoringBlock(): string {
  const start = terminalView.indexOf("startupPhase === 'restoring'")
  const end = terminalView.indexOf("startupPhase === 'starting-agent'", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return terminalView.slice(start, end)
}

describe('Terminal Restoring uses the shared full-page surface', () => {
  it('scans real sources and never accepts an empty slice', () => {
    expect(terminalView.length).toBeGreaterThan(10_000)
    expect(loadingComponent.length).toBeGreaterThan(500)
    expect(styles).toContain('.full-page-loading--region')
    expect(restoringBlock()).toContain('<FullPageLoadingSurface')
  })

  it('uses the Region recovering contract and keeps terminal facts in TerminalView', () => {
    const restoring = restoringBlock()
    expect(terminalView).toContain("import { FullPageLoadingSurface } from './FullPageLoadingSurface'")
    expect(restoring).toContain('scope="region"')
    expect(restoring).toContain('phase="recovering"')
    expect(restoring).toContain('title="Restoring terminal"')
    expect(restoring).toContain('Replaying retained output')
    expect(restoring).not.toContain('terminal-hydration')
    expect(restoring).not.toContain('LoaderCircle')
  })

  it('keeps reduced-motion and static readability in the shared surface', () => {
    expect(styles).toMatch(/\.full-page-loading__grid::before[\s\S]*animation: full-page-loading-sweep var\(--dur-sweep\)/)
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.full-page-loading__grid::before[\s\S]*?animation: none/)
    expect(loadingComponent).toContain('aria-live="polite"')
    expect(loadingComponent).toContain('aria-busy={!failed}')
  })
})
