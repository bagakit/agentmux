import { describe, expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles.js'

function declarations(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const blocks = [...allStyleRules().matchAll(new RegExp(`(?:^|[{},])\\s*${escaped}\\s*\\{([^{}]+)\\}`, 'g'))]
    .map((match) => match[1]!)
  expect(blocks.length, selector).toBeGreaterThan(0)
  return blocks
}

describe('left-corner bottom navigation density contract', () => {
  it('gives the independent PMO entry more space than each main surface at both densities', () => {
    const slots = declarations('.surface-navigation__slot')
    const launchers = declarations('.surface-navigation__slot--launcher')
    expect(slots).toHaveLength(2)
    expect(launchers).toHaveLength(2)
    slots.forEach((slot, index) => {
      const width = slot.match(/\bwidth:\s*(\d+)px/)
      const height = slot.match(/\bheight:\s*(\d+)px/)
      const launcherWidth = launchers[index]!.match(/\bwidth:\s*(\d+)px/)
      const launcherHeight = launchers[index]!.match(/\bheight:\s*(\d+)px/)
      expect(width).not.toBeNull()
      expect(height).not.toBeNull()
      expect(launcherWidth).not.toBeNull()
      expect(launcherHeight).not.toBeNull()
      expect(Number(launcherWidth![1])).toBeGreaterThan(Number(width![1]))
      expect(Number(launcherHeight![1])).toBeGreaterThan(Number(height![1]))
    })
    const button = declarations('.surface-navigation__slot--launcher .pmo-teams-topic-compact-launcher__button')[0]!
    expect(button).toContain('border-radius: 10px')
    expect(button).toContain('background: var(--surface-2)')
    expect(declarations('.surface-navigation__surfaces')[0]).toContain('border: 1px solid var(--line-soft)')
    expect(declarations('.surface-navigation__slot--surface.selected')[0]).toContain('background: var(--green)')
  })

  it('uses natural footer flow and contains the tooltip within the window', () => {
    const dock = declarations('.window-status-bar__surface-switch')[0]!
    expect(dock).toContain('flex: 0 0 auto')
    expect(dock).not.toContain('position: absolute')
    expect(dock).not.toContain('left: 50%')
    const tooltip = declarations('.surface-navigation__tooltip')[0]!
    expect(tooltip).toContain('max-width: calc(100vw - 16px)')
    expect(tooltip).toContain('transform: translateY(-100%)')
    expect(tooltip).not.toContain('translate(-50%')
  })
})
