import { expect, it, vi } from 'vitest'
import { SCREENSHOT_SHORTCUTS, SCREENSHOT_SHORTCUT_ACCELERATOR, screenshotShortcutAccelerator } from '../src/shared/screenshot-shortcut'
import { registerScreenshotShortcut } from '../src/main/screenshot-shortcut'
import { SHORTCUT_BINDINGS, chordForPlatform } from '../src/renderer/src/lib/shortcut-registry'

const included = SCREENSHOT_SHORTCUT_ACCELERATOR, excluded = screenshotShortcutAccelerator(SCREENSHOT_SHORTCUTS[1].chord)

it('uses the shared declarations for both macOS registrations and releases only its successful bindings', () => {
  const register = vi.fn((_accelerator: string, _callback: () => void) => true), unregister = vi.fn(), request = vi.fn()
  const owner = registerScreenshotShortcut({ platform: 'darwin', shortcuts: { register, unregister }, request })
  expect(included).toBe('Command+Shift+2')
  expect(excluded).toBe('Command+Alt+Shift+2')
  expect(register.mock.calls.map(call => call[0])).toEqual([included, excluded])
  expect(owner.status).toMatchObject({ state: 'registered', accelerator: included, alternate: { state: 'registered', accelerator: excluded } })
  expect(request).not.toHaveBeenCalled()
  register.mock.calls[0]![1](); register.mock.calls[1]![1]()
  expect(request.mock.calls).toEqual([['included', expect.objectContaining({ requestId: expect.any(String) })], ['excluded', expect.objectContaining({ requestId: expect.any(String) })]])
  owner.dispose(); owner.dispose()
  expect(unregister.mock.calls).toEqual([[included], [excluded]])
})

it.each(['declined', 'threw'] as const)('keeps a %s alternate registration local while the default shortcut stays usable', outcome => {
  const register = vi.fn((accelerator: string, _callback: () => void) => {
    if (accelerator === excluded) { if (outcome === 'threw') throw new Error('Registration transport unavailable'); return false }
    return true
  })
  const unregister = vi.fn(), request = vi.fn()
  const owner = registerScreenshotShortcut({ platform: 'darwin', shortcuts: { register, unregister }, request })
  expect(owner.status).toMatchObject({ state: 'registered', accelerator: included, alternate: { state: 'unavailable', accelerator: excluded } })
  expect(owner.status.alternate.message).toContain('Capture button remains available')
  register.mock.calls[0]![1](); expect(request).toHaveBeenCalledExactlyOnceWith('included', expect.objectContaining({ requestId: expect.any(String) }))
  owner.dispose(); expect(unregister.mock.calls).toEqual([[included]])
})

it.each(['declined', 'threw'] as const)('keeps a %s default registration local while the alternate shortcut stays usable', outcome => {
  const register = vi.fn((accelerator: string, _callback: () => void) => {
    if (accelerator === included) { if (outcome === 'threw') throw new Error('Registration transport unavailable'); return false }
    return true
  })
  const unregister = vi.fn(), request = vi.fn()
  const owner = registerScreenshotShortcut({ platform: 'darwin', shortcuts: { register, unregister }, request })
  expect(owner.status).toMatchObject({ state: 'unavailable', accelerator: included, alternate: { state: 'registered', accelerator: excluded } })
  expect(owner.status.message).toContain('Capture button remains available')
  register.mock.calls[1]![1](); expect(request).toHaveBeenCalledExactlyOnceWith('excluded', expect.objectContaining({ requestId: expect.any(String) }))
  owner.dispose(); expect(unregister.mock.calls).toEqual([[excluded]])
})

it('does not register unavailable system shortcuts on another platform', () => {
  const register = vi.fn(() => true), unregister = vi.fn(), request = vi.fn()
  const owner = registerScreenshotShortcut({ platform: 'win32', shortcuts: { register, unregister }, request })
  expect(owner.status.state).toBe('unsupported'); expect(owner.status.alternate.state).toBe('unsupported')
  owner.dispose()
  expect(register).not.toHaveBeenCalled(); expect(unregister).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
})

it('the registered system gesture does not preempt any existing App, editor, terminal or Composer binding', () => {
  const system = SHORTCUT_BINDINGS.filter(binding => binding.scope === 'system')
  expect(system.length).toBeGreaterThan(0)
  for (const binding of system) {
    for (const isMac of [true, false]) {
      if (!isMac && binding.macOnly) continue
      const chord = chordForPlatform(binding, isMac)
      const existing = SHORTCUT_BINDINGS.filter(other => other.scope !== 'system' && (isMac || !other.macOnly))
      expect(existing.length).toBeGreaterThan(0)
      for (const other of existing) expect(chordForPlatform(other, isMac), `${binding.id} would preempt ${other.id}`).not.toEqual(chord)
    }
  }
})
