import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { allStyles } from './helpers/styles.js'

const chromeSource = readFileSync(
  new URL('../src/renderer/src/components/TopRowChrome.tsx', import.meta.url),
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

  it('uses Tasks as the visible demand surface name without changing the board route', () => {
    expect(chromeSource).toContain('<strong>Tasks</strong>')
    expect(chromeSource).toContain("onClick={() => setMainSurface('board')}")
  })
})
