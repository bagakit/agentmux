import { describe, expect, it } from 'vitest'
import { isTerminalAppShortcut } from '../src/renderer/src/lib/terminal-shortcuts.js'

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: 'f',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides
  } as KeyboardEvent
}

describe('Terminal app shortcuts', () => {
  it('uses Command on macOS without stealing Ctrl chords from the Agent TUI', () => {
    expect(isTerminalAppShortcut(key({ metaKey: true }), 'f', true)).toBe(true)
    expect(isTerminalAppShortcut(key({ ctrlKey: true }), 'f', true)).toBe(false)
  })

  it('requires Ctrl+Shift elsewhere so readline and Agent Ctrl chords remain native', () => {
    expect(isTerminalAppShortcut(key({ ctrlKey: true, shiftKey: true }), 'f', false)).toBe(true)
    expect(isTerminalAppShortcut(key({ ctrlKey: true }), 'f', false)).toBe(false)
    expect(isTerminalAppShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true }), 'f', false)).toBe(false)
  })
})
