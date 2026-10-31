import type { NativeImage } from 'electron'
import { expect, it, vi } from 'vitest'
import { APP_ICON_IDS } from '@agentmux/client-ui/app-icon-catalog'
import { appIconPath, bindAppBrandIcon } from '../src/main/app-brand-icon.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'

function native(platform: NodeJS.Platform = 'darwin') {
  const loaded: Array<NativeImage & { path: string }> = []
  return { platform, loaded,
    images: { createFromPath: vi.fn((path: string) => {
      const image = { path, isEmpty: () => false } as NativeImage & { path: string }
      loaded.push(image)
      return image
    }) },
    dock: { setIcon: vi.fn() }, window: { isDestroyed: () => false, setIcon: vi.fn() }, reportIssue: vi.fn()
  }
}

it('projects the default and every committed choice from the real configuration owner, then releases its reader', async () => {
  const f = await configOwnerFixture(), ports = native()
  const binding = bindAppBrandIcon(f.owner, ports)
  expect(ports.loaded[0]!.path).toBe(appIconPath('qingzhuan'))
  expect(ports.dock.setIcon).toHaveBeenCalledWith(ports.loaded[0])
  expect(ports.window.setIcon).not.toHaveBeenCalled()
  for (const appIcon of APP_ICON_IDS) {
    await f.owner.update(current => ({ ...current, appearance: { ...current.appearance, appIcon } }))
    expect((await f.disk()).appearance.appIcon).toBe(appIcon)
    expect(ports.loaded.at(-1)!.path).toBe(appIconPath(appIcon))
    expect(ports.dock.setIcon).toHaveBeenLastCalledWith(ports.loaded.at(-1))
  }
  expect(binding.issue).toBeNull()
  const count = ports.dock.setIcon.mock.calls.length
  binding.dispose()
  await f.owner.update(current => ({ ...current, appearance: { ...current.appearance, appIcon: 'qingzhuan' } }))
  expect(ports.dock.setIcon).toHaveBeenCalledTimes(count)
})

it.each(['win32', 'linux'] as const)('uses the supported %s window API without touching the macOS Dock', async platform => {
  const f = await configOwnerFixture({ appearance: { terminalTheme: 'graphite', appIcon: 'classic' } }), ports = native(platform)
  const binding = bindAppBrandIcon(f.owner, ports)
  expect(ports.window.setIcon).toHaveBeenCalledWith(ports.loaded[0])
  expect(ports.loaded[0]!.path).toBe(appIconPath('classic'))
  expect(ports.dock.setIcon).not.toHaveBeenCalled()
  binding.dispose()
})

it('keeps a successful configuration commit and its native issue until a later native update actually succeeds', async () => {
  const f = await configOwnerFixture(), ports = native()
  const binding = bindAppBrandIcon(f.owner, ports)
  ports.dock.setIcon.mockImplementationOnce(() => { throw new Error('Dock rejected image') })
  await f.owner.update(current => ({ ...current, appearance: { ...current.appearance, appIcon: 'huihuan' } }))
  expect((await f.disk()).appearance.appIcon).toBe('huihuan')
  expect(binding.issue).toContain('Dock rejected image')
  expect(ports.reportIssue).toHaveBeenLastCalledWith(binding.issue)
  const issue = binding.issue, count = ports.dock.setIcon.mock.calls.length
  await f.owner.update(current => ({ ...current, copyPathsAsAbsolute: true }))
  expect(binding.issue).toBe(issue)
  expect(ports.dock.setIcon).toHaveBeenCalledTimes(count)
  await f.owner.update(current => ({ ...current, appearance: { ...current.appearance, appIcon: 'zheyu' } }))
  expect(binding.issue).toBeNull()
  expect(ports.reportIssue).toHaveBeenLastCalledWith(null)
  binding.dispose()
})

it('does not report a closed native window as a successful projection', async () => {
  const f = await configOwnerFixture(), ports = native('linux')
  ports.window.isDestroyed = () => true
  const binding = bindAppBrandIcon(f.owner, ports)
  expect(ports.window.setIcon).not.toHaveBeenCalled()
  expect(binding.issue).toContain('window is no longer available')
  expect(ports.reportIssue).toHaveBeenLastCalledWith(binding.issue)
  binding.dispose()
})

it('reports an unreadable native bitmap without replacing the existing system icon or rejecting the saved choice', async () => {
  const f = await configOwnerFixture(), ports = native()
  const binding = bindAppBrandIcon(f.owner, ports), count = ports.dock.setIcon.mock.calls.length
  ports.images.createFromPath.mockReturnValueOnce({ isEmpty: () => true } as NativeImage)
  await f.owner.update(current => ({ ...current, appearance: { ...current.appearance, appIcon: 'lingban' } }))
  expect((await f.disk()).appearance.appIcon).toBe('lingban')
  expect(ports.dock.setIcon).toHaveBeenCalledTimes(count)
  expect(binding.issue).toContain('could not be read')
  binding.dispose()
})

it('does not make notification delivery a condition of committing or applying the native icon', async () => {
  const f = await configOwnerFixture(), ports = native()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  ports.reportIssue.mockImplementation(() => { throw new Error('Renderer is unavailable') })
  const binding = bindAppBrandIcon(f.owner, ports)
  await f.owner.update(current => ({ ...current, appearance: { ...current.appearance, appIcon: 'classic' } }))
  expect((await f.disk()).appearance.appIcon).toBe('classic')
  expect(ports.dock.setIcon).toHaveBeenLastCalledWith(ports.loaded.at(-1))
  expect(binding.issue).toBeNull()
  expect(warning).toHaveBeenCalled()
  binding.dispose()
  warning.mockRestore()
})
