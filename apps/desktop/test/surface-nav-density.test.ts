import { describe, expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles.js'

function declarations(selector: string): string[] {
  const blocks = [...allStyleRules().matchAll(/([^{}]+)\{([^{}]+)\}/g)]
    .filter(match => match[1]!.split(',').map(part => part.trim()).includes(selector)).map(match => match[2]!)
  expect(blocks.length, selector).toBeGreaterThan(0)
  return blocks
}
function pixels(rule: string, property: string): number {
  const values = [...rule.matchAll(new RegExp(`(?:^|;)\\s*${property}:\\s*(-?\\d+(?:\\.\\d+)?)(?:px)?(?:\\s|;|$)`, 'g'))]
  expect(values.length, property).toBeGreaterThan(0)
  return Number(values.at(-1)![1])
}
function property(rule: string, name: string): string {
  const values = [...rule.matchAll(new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+)`, 'g'))]
  expect(values.length, name).toBeGreaterThan(0)
  return values.at(-1)![1]!.trim()
}
function geometry(selector: string): string[] {
  const blocks = declarations(selector).filter(rule => /(?:^|;)\s*width:/.test(rule))
  expect(blocks.length, selector).toBeGreaterThan(0)
  return blocks
}
function ordinarySlots(): string[] {
  return [...geometry('.surface-navigation__slot'),
    ...geometry('.surface-navigation__slot:not(.surface-navigation__slot--launcher)')]
}

describe('low footer with one independent Mote circle', () => {
  it('contains every ordinary surface and right-side control in the low bar at each source density', () => {
    const footer = declarations('.window-status-bar').join(';'), footerHeight = pixels(footer, 'height')
    expect(footerHeight).toBeGreaterThanOrEqual(24); expect(footerHeight).toBeLessThanOrEqual(26)
    expect(footer).toContain('align-items: center')
    const available = footerHeight - pixels(footer, 'border-top'), slots = ordinarySlots()
    expect(slots.length).toBeGreaterThan(1)
    const focus = declarations('.surface-navigation__slot:focus-visible').join(';')
    const focusOutset = Math.max(0, pixels(focus, 'outline') + pixels(focus, 'outline-offset'))
    for (const slot of slots) {
      expect(pixels(slot, 'width')).toBeGreaterThan(0)
      expect(pixels(slot, 'height') + focusOutset * 2).toBeLessThanOrEqual(available)
    }
    const controls = [...declarations('.surface-navigation'), ...declarations('.surface-navigation__surfaces'),
      ...declarations('.window-status-bar__utility-button'), ...declarations('.window-status-bar .agent-status-bar__segment--action'),
      ...declarations('.window-status-bar .global-system-notices__trigger')].filter(rule => /(?:^|;)\s*height:/.test(rule))
    expect(controls.length).toBeGreaterThan(0)
    for (const rule of controls) { expect(pixels(rule, 'height')).toBeGreaterThan(0); expect(pixels(rule, 'height')).toBeLessThanOrEqual(available) }
    expect(pixels(declarations('.window-status-bar button:focus-visible').join(';'), 'outline-offset')).toBeLessThan(0)
  })

  it('keeps the exact painted circle, avatar, status and focus within its independent raised hitbox', () => {
    const footer = declarations('.window-status-bar'), footerHeight = pixels(footer.join(';'), 'height')
    const launchers = declarations('.surface-navigation__slot--launcher'), launcher = launchers.join(';')
    const wrapper = declarations('.pmo-teams-topic-compact-launcher').join(';'), button = declarations('.pmo-teams-topic-compact-launcher__button').join(';')
    const surface = declarations('.pmo-teams-topic-compact-launcher__surface').join(';')
    const width = pixels(button, 'width'), height = pixels(button, 'height'), radius = pixels(surface, 'border-radius')
    expect(width).toBe(height); expect(radius).toBe(width / 2); expect(radius).toBe(pixels(launcher, 'border-radius'))
    expect(width).toBe(pixels(surface, 'width')); expect(height).toBe(pixels(surface, 'height'))
    expect(pixels(button, 'border-radius')).toBe(0); expect(pixels(button, 'border')).toBe(0)
    expect(width).toBe(pixels(launcher, 'width')); expect(height).toBe(pixels(launcher, 'height'))
    expect(width).toBe(pixels(wrapper, 'width')); expect(height).toBe(pixels(wrapper, 'height'))
    expect(button).toContain('background: transparent'); expect(surface).toContain('background: var(--surface-2)')
    expect(surface).toContain('pointer-events: none'); expect(launcher).toContain('position: fixed')
    const bottom = pixels(launcher, 'bottom'), top = footerHeight - bottom - height
    expect(bottom).toBeGreaterThan(0); expect(top).toBeLessThan(0); expect(-top).toBeLessThan(height / 2)
    expect(footerHeight - bottom).toBeLessThan(footerHeight)
    const docks = declarations('.window-status-bar__surface-switch'); expect(docks.length).toBeGreaterThan(1)
    for (const dock of docks) expect(pixels(dock, 'padding-left')).toBeGreaterThan(width)
    const densityPadding = footer.filter(rule => /(?:^|;)\s*padding:/.test(rule)), densityLeft = launchers.filter(rule => /(?:^|;)\s*left:/.test(rule))
    expect(densityPadding.length).toBeGreaterThan(0); expect(densityPadding).toHaveLength(densityLeft.length)
    for (let index = 0; index < densityPadding.length; index++) expect(property(densityPadding[index]!, 'padding')).toBe('0 ' + property(densityLeft[index]!, 'left'))
    const ordinary = ordinarySlots()
    for (const slot of ordinary) { expect(width).toBeGreaterThan(pixels(slot, 'width')); expect(height).toBeGreaterThan(pixels(slot, 'height')) }
    const avatar = declarations('.pmo-teams-topic-compact-launcher__button img').join(';')
    const border = pixels(declarations('.surface-navigation__slot--launcher .pmo-teams-topic-compact-launcher__surface').join(';'), 'border')
    expect(pixels(avatar, 'width')).toBe(pixels(avatar, 'height')); expect(pixels(avatar, 'width') + border * 2).toBeLessThanOrEqual(width)
    expect(avatar).toContain('object-fit: contain')
    const status = declarations('.pmo-teams-topic-compact-launcher__status').join(';'), dot = declarations('.pmo-teams-topic-compact-launcher__status .status__dot').join(';')
    const badgeWidth = pixels(dot, 'width') + 2 * pixels(status, 'padding'), badgeHeight = pixels(dot, 'height') + 2 * pixels(status, 'padding')
    const x = width - border - pixels(status, 'right') - badgeWidth / 2, y = height - border - pixels(status, 'bottom') - badgeHeight / 2
    expect(Math.hypot(x - width / 2, y - height / 2) + Math.max(badgeWidth, badgeHeight) / 2).toBeLessThanOrEqual(radius - border)
    expect(property(declarations('.pmo-teams-topic-compact-launcher__button:focus-visible').join(';'), 'outline')).toBe('none')
    const focus = declarations('.pmo-teams-topic-compact-launcher__button:focus-visible .pmo-teams-topic-compact-launcher__surface').join(';')
    expect(pixels(focus, 'outline') + pixels(focus, 'outline-offset')).toBeLessThanOrEqual(0)
  })

  it('retains natural footer flow and the bounded tooltip while only the launcher uses window placement', () => {
    const dock = declarations('.window-status-bar__surface-switch')[0]!
    expect(dock).toContain('flex: 0 0 auto'); expect(dock).toContain('position: relative')
    expect(dock).not.toContain('position: absolute'); expect(dock).not.toContain('left: 50%')
    const group = declarations('.surface-navigation__surfaces')[0]!; expect(group).not.toMatch(/border:|box-shadow:|background:/)
    expect(declarations('.surface-navigation__slot--surface.selected')[0]).toContain('background: var(--surface-3)')
    const tooltip = declarations('.surface-navigation__tooltip')[0]!
    expect(tooltip).toContain('max-width: calc(100vw - 16px)'); expect(tooltip).toContain('transform: translateY(-100%)')
    expect(tooltip).not.toContain('translate(-50%')
  })
})
