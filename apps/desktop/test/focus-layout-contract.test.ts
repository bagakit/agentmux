import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { allStyles } from './helpers/styles'

// Read all stylesheets, not just focus.css: split-by-surface refactors move rules across files,
// and hardcoding one filename here would let the "did the rule land somewhere" contract fall over
// silently when the rule moves. stylesheet-organisation.test.ts enforces this pattern across the tree.
const source = allStyles()
const surface = readFileSync(new URL('../src/renderer/src/components/GlobalFocusSurface.tsx', import.meta.url), 'utf8')

describe('Focus layout contract', () => {
  it('contains a non-empty fixed split and a non-animated workspace projection', () => {
    expect(source).toContain('.global-focus-surface.global-board-surface--session-open')
    expect(source).toContain('minmax(0, .382fr) minmax(0, .618fr)')
    expect(source).toContain('.global-focus-surface .global-session-workspace')
    expect(source).toContain('animation: none')
    expect(source).toContain('.focused-tab-workspace')
    expect(source).toContain('.focus-project-lanes__row')
    expect(source).toContain('.recent-focus')
    expect(surface).toContain('<RecentFocusTimeline')
    expect(surface).toContain('<FocusProjectLanes')
  })
})
