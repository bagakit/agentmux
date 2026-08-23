import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const component = readFileSync(join(import.meta.dirname, '../src/renderer/src/components/FullPageLoadingSurface.tsx'), 'utf8')
const terminal = readFileSync(join(import.meta.dirname, '../src/renderer/src/components/TerminalView.tsx'), 'utf8')
const styles = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/full-page-loading.css'), 'utf8')

function restoringBlock(): string {
  const start = terminal.indexOf("startupPhase === 'restoring'")
  const end = terminal.indexOf("startupPhase === 'starting-agent'", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const block = terminal.slice(start, end)
  expect(block.length).toBeGreaterThan(120)
  return block
}

describe('terminal restoring full-page contract', () => {
  it('has a non-empty shared component, source block, and style surface', () => {
    expect(component.length).toBeGreaterThan(500)
    expect(restoringBlock()).toContain('<FullPageLoadingSurface')
    expect(styles).toContain('.full-page-loading--region')
  })

  it('mounts the region recovering phase with truthful replay copy', () => {
    const block = restoringBlock()
    expect(terminal).toContain("import { FullPageLoadingSurface } from './FullPageLoadingSurface'")
    expect(block).toContain('scope="region"')
    expect(block).toContain('phase="recovering"')
    expect(block).toContain('eyebrow="Terminal recovery"')
    expect(block).toContain('title="Restoring terminal"')
    expect(block).toContain('Replaying retained output')
    expect(block).not.toContain('terminal-hydration')
    expect(block).not.toContain('LoaderCircle')
  })

  it('keeps durable and terminal behavior outside the presentation component', () => {
    expect(component).not.toContain('api.')
    expect(component).not.toContain('useAppStore')
    expect(terminal).toContain('replayGap')
    expect(terminal).toContain('ServiceWindowNotice')
    expect(terminal).toContain('!hydrating && replayGap')
  })

  it('has a reduced-motion path and a production caller', () => {
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(styles).toMatch(/\.full-page-loading__grid::before[\s\S]*animation: none/)
    const productionCallers = [terminal, readFileSync(join(import.meta.dirname, '../src/renderer/src/App.tsx'), 'utf8')]
      .filter((source) => source.includes('FullPageLoadingSurface'))
    expect(productionCallers.length).toBeGreaterThan(0)
  })
})
