// @vitest-environment happy-dom
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { ShortcutsCheatSheet } from '../src/renderer/src/components/ShortcutsCheatSheet.js'
import { SHORTCUT_BINDINGS } from '../src/renderer/src/lib/shortcut-registry.js'

function render(props: { open: boolean; isMac: boolean }): string {
  const container = document.createElement('div')
  const host = document.createElement('div')
  host.id = 'agentmux-window-overlay-host'
  host.className = 'window-overlay-host'
  host.dataset.overlayHost = ''
  document.body.append(container, host)
  const root = createRoot(container)
  flushSync(() => root.render(createElement(ShortcutsCheatSheet, { ...props, onClose: () => {} })))
  const markup = host.innerHTML
  root.unmount()
  container.remove(); host.remove()
  return markup
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
