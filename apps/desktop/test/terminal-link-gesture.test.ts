import { describe, expect, it } from 'vitest'
import {
  isTerminalLinkClick,
  terminalLinkModifierOpensSystemBrowser,
  terminalLinkPreviewAnchor,
  TERMINAL_LINK_DRAG_SLOP_PX,
  TERMINAL_LINK_PREVIEW_GAP_PX,
  TERMINAL_LINK_PREVIEW_MAX_HEIGHT_PX,
  TERMINAL_LINK_PREVIEW_MAX_WIDTH_PX
} from '../src/renderer/src/lib/terminal-link-gesture.js'

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

describe('terminal link modifier fast-path', () => {
  it('opens the system browser on Cmd+click on macOS', () => {
    expect(terminalLinkModifierOpensSystemBrowser({ metaKey: true, ctrlKey: false }, true)).toBe(true)
  })

  it('ignores Ctrl+click on macOS, where it is a right-click, not a fast-path', () => {
    expect(terminalLinkModifierOpensSystemBrowser({ metaKey: false, ctrlKey: true }, true)).toBe(false)
  })

  it('opens the system browser on Ctrl+click off macOS', () => {
    expect(terminalLinkModifierOpensSystemBrowser({ metaKey: false, ctrlKey: true }, false)).toBe(true)
  })

  it('ignores Cmd+click off macOS, where Meta is not the platform accelerator', () => {
    expect(terminalLinkModifierOpensSystemBrowser({ metaKey: true, ctrlKey: false }, false)).toBe(false)
  })

  it('keeps a plain click on the menu path on both platforms', () => {
    expect(terminalLinkModifierOpensSystemBrowser({ metaKey: false, ctrlKey: false }, true)).toBe(false)
    expect(terminalLinkModifierOpensSystemBrowser({ metaKey: false, ctrlKey: false }, false)).toBe(false)
  })
})

describe('terminal link preview anchor', () => {
  const viewport = { left: 0, top: 0, right: 1000, bottom: 800 }
  const cellHeight = 17

  it('anchors above the link, clearing the full cell plus the gap so it never covers the link', () => {
    const anchor = terminalLinkPreviewAnchor({ pointer: { x: 200, y: 400 }, cellHeight, viewport })
    expect(anchor.placement).toBe('above')
    expect(anchor.top).toBe(400 - cellHeight - TERMINAL_LINK_PREVIEW_GAP_PX)
    expect(anchor.left).toBe(200)
  })

  it('flips below the link when there is no room above', () => {
    const anchor = terminalLinkPreviewAnchor({ pointer: { x: 200, y: 4 }, cellHeight, viewport })
    expect(anchor.placement).toBe('below')
    expect(anchor.top).toBe(4 + cellHeight + TERMINAL_LINK_PREVIEW_GAP_PX)
  })

  it('clamps left so the preview stays inside the viewport at its full width', () => {
    const anchor = terminalLinkPreviewAnchor({ pointer: { x: 990, y: 400 }, cellHeight, viewport })
    expect(anchor.left).toBe(viewport.right - TERMINAL_LINK_PREVIEW_MAX_WIDTH_PX)
  })

  it('never clamps left below the viewport left edge', () => {
    const narrow = { left: 100, top: 0, right: 300, bottom: 800 }
    const anchor = terminalLinkPreviewAnchor({ pointer: { x: 120, y: 400 }, cellHeight, viewport: narrow })
    expect(anchor.left).toBe(narrow.left)
  })

  it('treats the reserved height as the room needed above before flipping', () => {
    // Just enough room above: cell + gap + max preview height exactly reaches the top edge.
    const y = cellHeight + TERMINAL_LINK_PREVIEW_GAP_PX + TERMINAL_LINK_PREVIEW_MAX_HEIGHT_PX
    expect(terminalLinkPreviewAnchor({ pointer: { x: 10, y }, cellHeight, viewport }).placement).toBe('above')
    expect(terminalLinkPreviewAnchor({ pointer: { x: 10, y: y - 1 }, cellHeight, viewport }).placement).toBe('below')
  })
})
