import { afterEach, expect, it, vi } from 'vitest'
import { SCREENSHOT_SHORTCUT, SCREENSHOT_SHORTCUT_ACCELERATOR } from '../src/shared/screenshot-shortcut'
import { registerScreenshotShortcut } from '../src/main/screenshot-shortcut'
import { releaseScreenshotTarget, runScreenshotShortcut, selectScreenshotTarget } from '../src/renderer/src/lib/screenshot-shortcut-target'
import { SHORTCUT_BINDINGS, chordForPlatform } from '../src/renderer/src/lib/shortcut-registry'

const selected: Array<{ capture(): Promise<void> }> = []
afterEach(() => { for (const target of selected.splice(0)) releaseScreenshotTarget(target) })
function target(capture: () => Promise<void> = vi.fn(async () => {})) {
  const value = { capture }
  selected.push(value)
  return value
}

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

it('requires an explicitly selected original Composer without inventing a destination', async () => {
  await expect(runScreenshotShortcut()).rejects.toThrow(/Message Tool|draft|Composer/i)
  const original = target()
  selectScreenshotTarget(original)
  expect(original.capture).not.toHaveBeenCalled()
  await runScreenshotShortcut()
  expect(original.capture).toHaveBeenCalledOnce()
  releaseScreenshotTarget(original)
  await expect(runScreenshotShortcut()).rejects.toThrow(/Message Tool|draft|Composer/i)
})

it('a late release cannot erase a newer explicitly focused Composer', async () => {
  const original = target(), newer = target()
  selectScreenshotTarget(original); selectScreenshotTarget(newer); releaseScreenshotTarget(original)
  await expect(runScreenshotShortcut()).resolves.toBeUndefined()
  expect(original.capture).not.toHaveBeenCalled()
  expect(newer.capture).toHaveBeenCalledOnce()
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

it('pins the original target and does not start a second physical selection for repeated pending hotkeys', async () => {
  let finish!: () => void
  const original = target(vi.fn(() => new Promise<void>(resolve => { finish = resolve }))), newer = target()
  selectScreenshotTarget(original)
  const first = runScreenshotShortcut()
  expect(original.capture).toHaveBeenCalledOnce()
  selectScreenshotTarget(newer)
  const repeated = runScreenshotShortcut()
  // An in-flight request may be joined or rejected, but it must not become another capture.
  const repeatedResult = repeated.catch(error => error)
  expect(original.capture).toHaveBeenCalledOnce(); expect(newer.capture).not.toHaveBeenCalled()
  finish()
  await first; await repeatedResult
  await runScreenshotShortcut()
  expect(newer.capture).toHaveBeenCalledOnce()
})

it('preserves the original failure without automatically replaying the capture', async () => {
  const error = new Error('Original native operation is unconfirmed')
  const original = target(vi.fn(async () => { throw error }))
  selectScreenshotTarget(original)
  await expect(runScreenshotShortcut()).rejects.toBe(error)
  expect(original.capture).toHaveBeenCalledOnce()
})
