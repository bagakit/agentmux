import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../src/renderer/src/', import.meta.url)
const sources = {
  app: readFileSync(new URL('App.tsx', root), 'utf8'),
  board: readFileSync(new URL('components/WorkspaceBoard.tsx', root), 'utf8'),
  terminal: readFileSync(new URL('components/TerminalView.tsx', root), 'utf8'),
  browser: readFileSync(new URL('components/BrowserPane.tsx', root), 'utf8'),
  pane: readFileSync(new URL('components/SessionPane.tsx', root), 'utf8'),
  connecting: readFileSync(new URL('components/SessionConnectingSurface.tsx', root), 'utf8'),
  shared: readFileSync(new URL('components/FullPageLoadingSurface.tsx', root), 'utf8')
}

describe('loading surface inventory', () => {
  it('keeps the primary loading and recovery callers visible to the shared contract', () => {
    const fullPageCallers = Object.entries(sources)
      .filter(([name, source]) => name !== 'shared' && source.includes('FullPageLoadingSurface'))
      .map(([name]) => name)
    expect(fullPageCallers).toEqual(expect.arrayContaining(['app', 'board', 'terminal', 'browser']))
    expect(fullPageCallers.length).toBeGreaterThan(0)
    expect(sources.pane).toContain('SessionConnectingSurface')
    expect(sources.connecting).toContain("phase: 'launch' | 'restore' | 'connect'")
    expect(sources.shared).toContain("phase === 'failed'")
  })
})
