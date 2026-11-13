// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { saveConfigSlice } from '../src/renderer/src/components/settings/save-config-slice'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { AppConfig } from '../src/shared/contracts'

// Every settings section saves through one adapter: the slice is applied to the store's current
// configuration for both the draft and its edited baseline, nothing is reported saved while
// configuration is unavailable, and a newer publication is never replaced by an older receipt.
let config: AppConfig
beforeEach(async () => {
  config = await api.config.get()
  useAppStore.setState({ config })
})
const withCopy = (current: AppConfig, value: boolean) => ({ ...current, copyPathsAsAbsolute: value })

it('applies the slice to the current configuration for both the value and its baseline', async () => {
  const save = vi.spyOn(api.config, 'save').mockImplementation(async next => next)
  await saveConfigSlice(withCopy, true, false)
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...config, copyPathsAsAbsolute: true }, { ...config, copyPathsAsAbsolute: false })
})

it('refuses to save, with its code, while configuration is unavailable', async () => {
  const save = vi.spyOn(api.config, 'save')
  useAppStore.setState({ config: null })
  await expect(saveConfigSlice(withCopy, true, false)).rejects.toMatchObject({ code: 'CONFIG_UNAVAILABLE' })
  expect(save).not.toHaveBeenCalled()
})

it('applies the receipt only while nothing newer has been observed', async () => {
  const receipt = { ...config, copyPathsAsAbsolute: true }
  vi.spyOn(api.config, 'save').mockResolvedValue(receipt)
  await saveConfigSlice(withCopy, true, false)
  expect(useAppStore.getState().config).toBe(receipt)

  const newer = { ...config, copyPathsAsAbsolute: false, gitHistoryShowTime: false }
  vi.spyOn(api.config, 'save').mockImplementation(async () => { useAppStore.setState({ config: newer }); return receipt })
  useAppStore.setState({ config })
  await saveConfigSlice(withCopy, true, false)
  expect(useAppStore.getState().config).toBe(newer)
})

it('is the only settings caller of api.config.save', () => {
  const root = 'apps/desktop/src/renderer/src/components/settings'
  const files = [...readdirSync(root, { recursive: true, encoding: 'utf8' }).map(file => join(root, file)),
    'apps/desktop/src/renderer/src/lib/focus-preferences.ts', 'apps/desktop/src/renderer/src/lib/goals-common-actions-config.ts']
    .filter(file => /\.(ts|tsx)$/.test(file))
  expect(files.length).toBeGreaterThan(40)
  const callers = files.filter(file => readFileSync(file, 'utf8').includes('api.config.save'))
  expect(callers).toEqual(['apps/desktop/src/renderer/src/components/settings/save-config-slice.ts'])
})
