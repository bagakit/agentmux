import { describe, expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles.js'

function declarations(selector: string): string[] {
  const blocks = [...allStyleRules().matchAll(/([^{}]+)\{([^{}]+)\}/g)]
    .filter((match) => match[1]!.split(',').map((part) => part.trim()).includes(selector))
    .map((match) => match[2]!)
  expect(blocks.length, selector).toBeGreaterThan(0)
  return blocks
}

function pixels(rule: string, property: string): number {
  const values = [...rule.matchAll(new RegExp(`(?:^|;)\\s*${property}:\\s*(-?\\d+(?:\\.\\d+)?)(?:px)?(?:\\s|;|$)`, 'g'))]
  expect(values.length, property).toBeGreaterThan(0)
  return Number(values.at(-1)![1])
}

function geometry(selector: string): string[] {
  const rules = declarations(selector).filter((rule) => /(?:^|;)\s*width:/.test(rule))
  expect(rules.length, selector).toBeGreaterThan(0)
  return rules
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
    expect(declarations('.surface-navigation__slot--surface.selected')[0]).toContain('background: var(--surface-3)')
  })

  it('keeps the complete launcher, avatar, status and focus paint inside the original footer at both densities', () => {
    const footer = declarations('.window-status-bar').join(';')
    const navigation = declarations('.surface-navigation').join(';')
    const docks = declarations('.window-status-bar__surface-switch')
    const launchers = geometry('.surface-navigation__slot--launcher')
    const wrappers = geometry('.surface-navigation__slot--launcher .pmo-teams-topic-compact-launcher')
    const buttons = geometry('.surface-navigation__slot--launcher .pmo-teams-topic-compact-launcher__button')
    const avatars = geometry('.surface-navigation__slot--launcher .pmo-teams-topic-compact-launcher__button img')
    expect(launchers).toHaveLength(2)
    expect(wrappers).toHaveLength(launchers.length)
    expect(buttons).toHaveLength(launchers.length)
    expect(avatars.length).toBeLessThanOrEqual(launchers.length)
    expect(docks).toHaveLength(launchers.length)
    expect(footer).toContain('align-items: center')
    expect(footer).toMatch(/padding:\s*0\s/)
    expect(declarations('*').join(';')).toContain('box-sizing: border-box')
    const footerHeight = pixels(footer, 'height'), border = pixels(footer, 'border-top')
    const navigationHeight = pixels(navigation, 'height')
    const dockTop = border + (footerHeight - border - navigationHeight) / 2
    const status = declarations('.pmo-teams-topic-compact-launcher__status').join(';')
    const dot = declarations('.pmo-teams-topic-compact-launcher__status .status__dot').join(';')
    const statusHeight = pixels(dot, 'height') + 2 * pixels(status, 'padding')
    const statusWidth = pixels(dot, 'width') + 2 * pixels(status, 'padding')
    const launcherFocus = declarations('.surface-navigation__slot--launcher:focus-within').join(';')
    const buttonFocus = [...declarations('.pmo-teams-topic-compact-launcher__button:focus-visible'),
      ...declarations('.surface-navigation__slot--launcher .pmo-teams-topic-compact-launcher__button:focus-visible')].join(';')
    const focusOutset = Math.max(0, pixels(launcherFocus, 'outline') + pixels(launcherFocus, 'outline-offset'),
      pixels(buttonFocus, 'outline') + pixels(buttonFocus, 'outline-offset'))
    launchers.forEach((launcher, index) => {
      const width = pixels(launcher, 'width'), height = pixels(launcher, 'height')
      const avatar = avatars.slice(0, index + 1).join(';')
      const bottom = dockTop + navigationHeight - pixels(launchers.slice(0, index + 1).join(';'), 'bottom'), top = bottom - height
      expect(top - focusOutset).toBeGreaterThanOrEqual(0)
      expect(bottom + focusOutset).toBeLessThanOrEqual(footerHeight)
      expect(pixels(wrappers[index]!, 'width')).toBe(width)
      expect(pixels(wrappers[index]!, 'height')).toBe(height)
      expect(pixels(buttons[index]!, 'width')).toBe(width)
      expect(pixels(buttons[index]!, 'height')).toBe(height)
      expect(pixels(docks[index]!, 'padding-left')).toBeGreaterThan(width + focusOutset)
      const buttonBorder = pixels(buttons.slice(0, index + 1).join(';'), 'border')
      expect(pixels(avatar, 'height') + 2 * buttonBorder).toBeLessThanOrEqual(height)
      expect(pixels(avatar, 'width') + 2 * buttonBorder).toBeLessThanOrEqual(width)
      expect(top + (height - pixels(avatar, 'height')) / 2).toBeGreaterThanOrEqual(0)
      expect(bottom - (height - pixels(avatar, 'height')) / 2).toBeLessThanOrEqual(footerHeight)
      expect(pixels(status, 'top')).toBeGreaterThanOrEqual(0)
      expect(pixels(status, 'right')).toBeGreaterThanOrEqual(0)
      expect(pixels(status, 'top') + statusHeight + 2 * buttonBorder).toBeLessThanOrEqual(height)
      expect(pixels(status, 'right') + statusWidth + 2 * buttonBorder).toBeLessThanOrEqual(width)
    })
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
