import { expect, it, vi } from 'vitest'
import { SCREENSHOT_SHORTCUT, SCREENSHOT_SHORTCUT_ACCELERATOR } from '../src/shared/screenshot-shortcut'
import { registerScreenshotShortcut } from '../src/main/screenshot-shortcut'
import { SHORTCUT_BINDINGS, chordForPlatform } from '../src/renderer/src/lib/shortcut-registry'

it('uses the shared declaration for one macOS registration and releases only its successful binding', () => {
  const register = vi.fn((_accelerator: string, _callback: () => void) => true), unregister = vi.fn(), request = vi.fn()
  const owner = registerScreenshotShortcut({ platform: 'darwin', shortcuts: { register, unregister }, request })
  expect(SCREENSHOT_SHORTCUT.id).toBeTruthy()
  expect(SCREENSHOT_SHORTCUT.label).toBeTruthy()
  expect(SCREENSHOT_SHORTCUT_ACCELERATOR).toBe('Command+Shift+2')
  expect(register).toHaveBeenCalledExactlyOnceWith(SCREENSHOT_SHORTCUT_ACCELERATOR, expect.any(Function))
  expect(owner.status).toMatchObject({ state: 'registered', accelerator: SCREENSHOT_SHORTCUT_ACCELERATOR })
  expect(request).not.toHaveBeenCalled()
  register.mock.calls[0]![1]()
  expect(request).toHaveBeenCalledOnce()
  owner.dispose(); owner.dispose()
  expect(unregister).toHaveBeenCalledExactlyOnceWith(SCREENSHOT_SHORTCUT_ACCELERATOR)
})

it.each(['declined', 'threw'] as const)('keeps a %s registration local and never unregisters another application binding', outcome => {
  const register = vi.fn((_accelerator: string, _callback: () => void) => { if (outcome === 'threw') throw new Error('Registration transport unavailable'); return false })
  const unregister = vi.fn(), request = vi.fn()
  const owner = registerScreenshotShortcut({ platform: 'darwin', shortcuts: { register, unregister }, request })
  expect(owner.status).toMatchObject({ state: 'unavailable', accelerator: SCREENSHOT_SHORTCUT_ACCELERATOR })
  expect(owner.status.message).toBeTruthy()
  owner.dispose()
  expect(unregister).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
})

it('does not register an unavailable screenshot capability on another platform', () => {
  const register = vi.fn(() => true), unregister = vi.fn(), request = vi.fn()
  const owner = registerScreenshotShortcut({ platform: 'win32', shortcuts: { register, unregister }, request })
  expect(owner.status.state).toBe('unsupported')
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
