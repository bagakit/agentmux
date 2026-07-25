import { describe, expect, it } from 'vitest'
import { isTerminalLinkClick, TERMINAL_LINK_DRAG_SLOP_PX } from '../src/renderer/src/lib/terminal-link-gesture.js'

describe('terminal link gesture', () => {
  it('opens on a press and release that stayed put', () => {
    expect(isTerminalLinkClick({
      origin: { x: 100, y: 200 },
      release: { x: 100, y: 200 },
      hasSelection: false
    })).toBe(true)
  })

  it('tolerates the hand shake of a real click', () => {
    expect(isTerminalLinkClick({
      origin: { x: 100, y: 200 },
      release: { x: 100 + TERMINAL_LINK_DRAG_SLOP_PX, y: 200 - TERMINAL_LINK_DRAG_SLOP_PX },
      hasSelection: false
    })).toBe(true)
  })

  it('refuses a drag that merely ended over the link', () => {
    // Selecting a line that contains a URL must select, not navigate.
    expect(isTerminalLinkClick({
      origin: { x: 40, y: 200 },
      release: { x: 300, y: 200 },
      hasSelection: false
    })).toBe(false)
    expect(isTerminalLinkClick({
      origin: { x: 100, y: 120 },
      release: { x: 100, y: 260 },
      hasSelection: false
    })).toBe(false)
  })

  it('refuses any gesture that left a selection behind', () => {
    // A selection proves the user was selecting text, whatever the pointer distance says.
    expect(isTerminalLinkClick({
      origin: { x: 100, y: 200 },
      release: { x: 100, y: 200 },
      hasSelection: true
    })).toBe(false)
  })

  it('opens when no press was observed, so a synthetic activation still works', () => {
    expect(isTerminalLinkClick({
      origin: null,
      release: { x: 10, y: 10 },
      hasSelection: false
    })).toBe(true)
  })
})
