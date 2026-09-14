import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const STYLES = readFile(
  fileURLToPath(new URL('../src/renderer/src/styles/agent.css', import.meta.url)),
  'utf8'
)
const NAV = readFile(
  fileURLToPath(new URL('../src/renderer/src/components/TopRowChrome.tsx', import.meta.url)),
  'utf8'
)
const PLUGINS = readFile(
  fileURLToPath(new URL('../src/renderer/src/components/SurfaceNavigation.tsx', import.meta.url)),
  'utf8'
)

describe('five-part bottom navigation density contract', () => {
  it('keeps one continuous container, compact labels and non-color selected state', async () => {
    const styles = await STYLES
    const nav = await NAV
    const plugins = await PLUGINS
    expect(styles).toContain('.surface-navigation {')
    expect(styles).toContain('.surface-navigation__slot')
    expect(styles).toContain('border: 1px solid var(--line-soft)')
    expect(styles).toContain('@media (max-width: 560px)')
    expect(styles).toContain('.surface-navigation__tooltip')
    expect(styles).toContain('backdrop-filter: blur(14px)')
    expect(styles).toContain('scale(1.14)')
    expect(styles).toContain('prefers-reduced-motion: reduce')
    expect(styles).toContain('.surface-navigation__slot--launcher .pmo-teams-topic-compact-launcher__button img { width: 27px; height: 26px;')
    expect(nav.match(/aria-current=/g)?.length ?? 0).toBeGreaterThan(0)
    expect(nav).toContain('surface-navigation')
    expect(nav).not.toContain('surface-switch--left')
    expect(nav).not.toContain('surface-switch--right')
    expect(plugins).toContain('SURFACE_NAVIGATION_PLUGINS')
    expect(plugins).toContain("id: 'pmo-teams'")
    expect(plugins).toContain("id: 'survey'")
    expect(plugins).toContain("id: 'work'")
  })
})
