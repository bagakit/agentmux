import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { allStyles } from './helpers/styles.js'

const chromeSource = readFileSync(
  new URL('../src/renderer/src/components/TopRowChrome.tsx', import.meta.url),
  'utf8'
)
// Peer extracted the surface-switch plugins (Work/Focus/Workspaces...) out of TopRowChrome into
// a shared SurfaceNavigation component; the `setMainSurface('board')` route now lives there as
// data (`{ surface: 'board', title: 'Work — ...' }`), invoked via a generic
// `onClick={() => setMainSurface(plugin.surface)}` in the shared component. The intent this
// test guards ("Work maps to the board route") is preserved but split across two files.
const surfaceNavigationSource = readFileSync(
  new URL('../src/renderer/src/components/SurfaceNavigation.tsx', import.meta.url),
  'utf8'
)
const styles = allStyles().replace(/\/\*[\s\S]*?\*\//g, '')

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return styles.match(new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^{}]*)\\}`, 'm'))?.[1] ?? ''
}

describe('global surface titlebar inset', () => {
  it('self-checks that the shared chrome source and stylesheet are present', () => {
    expect(chromeSource.length).toBeGreaterThan(500)
    expect(styles.length).toBeGreaterThan(10_000)
    expect(declarationsFor('.top-row-leading-chrome--global-inset').length).toBeGreaterThan(0)
  })

  it('applies the native traffic-light inset only through the shared global chrome modifier', () => {
    expect(chromeSource).toContain('top-row-leading-chrome--global-inset')
    expect(chromeSource).toContain("mainSurface === 'agents' || mainSurface === 'board'")
    expect(declarationsFor('.top-row-leading-chrome--global-inset')).toMatch(/padding-left\s*:\s*80px/)
  })

  it('uses Work as the visible request surface name without changing the board route', () => {
    expect(chromeSource).toContain('<strong>Work</strong>')
    // The click that navigates to board is now `onClick={() => setMainSurface(plugin.surface)}`
    // in TopRowChrome's shared plugin loop, dispatched by a `{ surface: 'board', title: 'Work
    // — ...' }` entry defined in SurfaceNavigation. Both anchors have to be true — a generic
    // dispatch without a board entry, or a board entry without a dispatch, would fail one half.
    // That is the exact acceptance: the visible name is "Work" but the route it takes is 'board'.
    expect(chromeSource).toContain('setMainSurface(plugin.surface)')
    expect(surfaceNavigationSource).toContain("surface: 'board'")
    expect(surfaceNavigationSource).toContain("title: 'Work — ")
  })
})
