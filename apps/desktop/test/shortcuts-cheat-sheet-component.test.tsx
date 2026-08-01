import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ShortcutsCheatSheet } from '../src/renderer/src/components/ShortcutsCheatSheet.js'
import { SHORTCUT_BINDINGS } from '../src/renderer/src/lib/shortcut-registry.js'

// The cheat-sheet's presentation shell. It is a PLAIN conditional overlay, not a Radix Dialog — Radix's
// Portal renders nothing under renderToStaticMarkup, which would make this whole guard blind (this repo's
// "组件触发面可静默失效" lesson: a trigger that never renders while every test stays green). So the shell
// renders inline and these assertions actually reach its markup.

function render(props: { open: boolean; isMac: boolean }): string {
  return renderToStaticMarkup(
    createElement(ShortcutsCheatSheet, { ...props, onClose: () => {} })
  )
}

describe('ShortcutsCheatSheet', () => {
  it('closed renders nothing', () => {
    expect(render({ open: false, isMac: true })).toBe('')
  })

  it('open renders — the trigger surface is not silently dead', () => {
    // The direct guard against "组件触发面可静默失效": if the shell stops rendering when open (inverted
    // guard, early return), this markup goes empty and every assertion below fails at once.
    const markup = render({ open: true, isMac: true })
    expect(markup.length).toBeGreaterThan(0)
    expect(markup).toContain('aria-label="Keyboard shortcuts"')
  })

  it('renders a row for EVERY registry binding, anchored by its id — none dropped', () => {
    // Same-set at the render layer: each binding id appears as a data-binding-id. A binding the panel fails
    // to render turns this red for that specific id. The registry is the SSOT (shortcut-cheat-sheet.test.ts
    // guards the union equality); here we prove the DOM actually carries each one.
    const markup = render({ open: true, isMac: true })
    for (const binding of SHORTCUT_BINDINGS) {
      expect(markup, `missing row for ${binding.id}`).toContain(`data-binding-id="${binding.id}"`)
    }
  })

  it('renders the CURRENT platform shape — mac shows ⌘, never a spelled Ctrl', () => {
    const mac = render({ open: true, isMac: true })
    expect(mac).toContain('⌘')
    // A mac render must not spell the modifier words — that would be the non-mac shape leaking in.
    expect(mac).not.toContain('<kbd>Ctrl</kbd>')
  })

  it('renders the non-mac shape with spelled words, no mac glyphs', () => {
    const other = render({ open: true, isMac: false })
    expect(other).toContain('<kbd>Ctrl</kbd>')
    expect(other).not.toContain('⌘')
    expect(other).not.toContain('⌥')
  })

  it('names the group titles derived from the registry, not a hand-kept category list', () => {
    const markup = render({ open: true, isMac: true })
    // The four (scope, gate)-derived groups all have bindings today, so all four titles must render.
    for (const title of ['Global', 'Workbench', 'Terminal', 'Editor']) {
      expect(markup, `missing group ${title}`).toContain(`>${title}<`)
    }
  })
})
