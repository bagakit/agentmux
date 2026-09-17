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
    const group = declarations('.surface-navigation__surfaces')[0]!
    expect(group).not.toMatch(/border:|box-shadow:|background:/)
    const heights = declarations('.window-status-bar').flatMap((rule) => [...rule.matchAll(/\bheight:\s*(\d+)px/g)].map((match) => Number(match[1])))
    expect(heights).toEqual([32])
    expect(declarations('.surface-navigation')[0]).toContain('height: 26px')
    launchers.forEach((launcher) => expect(Number(launcher.match(/\bheight:\s*(\d+)px/)![1])).toBeGreaterThan(32))
    expect(declarations('.surface-navigation__slot--surface.selected')[0]).toContain('background: var(--surface-3)')
  })

  it('uses natural footer flow and contains the tooltip within the window', () => {
    const dock = declarations('.window-status-bar__surface-switch')[0]!
    expect(dock).toContain('flex: 0 0 auto')
    expect(dock).toContain('position: relative')
    const launcher = declarations('.surface-navigation__slot--launcher')[0]!
    expect(launcher).toContain('position: absolute')
    expect(launcher).toContain('bottom: 0')
    expect(launcher).toContain('left: 0')
    expect(dock).not.toContain('position: absolute')
    expect(dock).not.toContain('left: 50%')
    const tooltip = declarations('.surface-navigation__tooltip')[0]!
    expect(tooltip).toContain('max-width: calc(100vw - 16px)')
    expect(tooltip).toContain('transform: translateY(-100%)')
    expect(tooltip).not.toContain('translate(-50%')
  })
})
