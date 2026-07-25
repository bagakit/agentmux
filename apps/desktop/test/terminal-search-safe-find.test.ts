import { describe, expect, it, vi } from 'vitest'
import type { SearchAddon } from '@xterm/addon-search'
import {
  safeTerminalFind,
  TERMINAL_SEARCH_DECORATIONS
} from '../src/renderer/src/lib/terminal-search-safe-find.js'

type FindAddon = Pick<SearchAddon, 'findNext' | 'findPrevious'>

describe('safeTerminalFind', () => {
  it('routes next/previous to the matching addon method and returns its result', () => {
    const addon: FindAddon = {
      findNext: vi.fn().mockReturnValue(true),
      findPrevious: vi.fn().mockReturnValue(false)
    }
    expect(safeTerminalFind(addon, 'x', 'next', {})).toBe(true)
    expect(addon.findNext).toHaveBeenCalledWith('x', {})
    expect(safeTerminalFind(addon, 'x', 'previous', {})).toBe(false)
    expect(addon.findPrevious).toHaveBeenCalledWith('x', {})
  })

  it('contains the exact xterm decoration-width throw and returns false', () => {
    // This is the synchronous throw registerDecoration raises when a match starts past the live
    // viewport width; unguarded from a React handler it tears down the terminal surface.
    const addon: FindAddon = {
      findNext: vi.fn(() => {
        throw new Error('This API only accepts positive integers')
      }),
      findPrevious: vi.fn()
    }
    expect(safeTerminalFind(addon, 'x', 'next', {})).toBe(false)
  })

  it('rethrows any other error so real faults in the search path still surface', () => {
    const addon: FindAddon = {
      findNext: vi.fn(() => {
        throw new Error('some other failure')
      }),
      findPrevious: vi.fn()
    }
    expect(() => safeTerminalFind(addon, 'x', 'next', {})).toThrow('some other failure')
  })

  it('rethrows a non-Error throw unchanged', () => {
    const addon: FindAddon = {
      findNext: vi.fn(() => {
        throw 'positive integers'
      }),
      findPrevious: vi.fn()
    }
    expect(() => safeTerminalFind(addon, 'x', 'next', {})).toThrow()
  })

  it('exposes decoration colours as literal #RRGGBB the xterm canvas can consume', () => {
    // xterm paints decorations on its own canvas, so CSS vars/color-mix cannot reach them — the
    // values must be concrete hex. Derived from --amber (#ecc16a) mixed toward the black ground.
    for (const value of Object.values(TERMINAL_SEARCH_DECORATIONS)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/u)
    }
    // The active match is the brightest — the one state emphasis.
    expect(TERMINAL_SEARCH_DECORATIONS.activeMatchBorder).toBe('#ecc16a')
  })
})
