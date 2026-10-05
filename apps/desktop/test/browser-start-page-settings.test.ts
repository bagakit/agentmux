import { expect, it } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { executeSettingsControl } from '../src/main/settings-control'
import { DEFAULT_BROWSER_START_PAGE } from '../src/shared/browser-start-page'

const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'start-page-settings' } as const

it('discovers effective start-page fields and persists them through the public Settings owner', async () => {
  const f = await configOwnerFixture()
  const before = await f.bytes()
  const found = await executeSettingsControl({ ...envelope, operation: 'settings.get', target: 'browser.startPage' }, f.owner)
  if (found.operation !== 'settings.get') throw new Error('Expected the original settings.get receipt')
  expect(found.entries.map(entry => [entry.key, entry.value, entry.default])).toEqual(Object.entries(DEFAULT_BROWSER_START_PAGE).map(([key, value]) => [`browser.startPage.${key}`, value, value]))
  expect(await f.bytes()).toBe(before)
  const values = { title: 'My research', subtitle: 'Keep your sources close', icon: 'https://images.example.test/mark.png', backgroundImage: 'https://images.example.test/background.jpg', showHistory: false }
  for (const [key, value] of Object.entries(values)) {
    const receipt = await executeSettingsControl({ ...envelope, operation: 'settings.set', key: `browser.startPage.${key}`, value: String(value) }, f.owner)
    if (receipt.operation !== 'settings.set') throw new Error('Expected the original settings.set receipt')
    expect(receipt.entry.value).toBe(value)
  }
  expect((await f.disk()).browser.startPage).toEqual(values)
  expect(f.publish).toHaveBeenCalledTimes(5)
})

it('merges a first GUI edit against effective defaults and preserves concurrent unrelated edits', async () => {
  const f = await configOwnerFixture(), before = f.owner.current
  await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'browser.agentAutomation', value: 'true' }, f.owner)
  await f.owner.edit({ ...before, browser: { ...before.browser, startPage: DEFAULT_BROWSER_START_PAGE } },
    { ...before, browser: { ...before.browser, startPage: { ...DEFAULT_BROWSER_START_PAGE, title: 'Personal start page' } } })
  expect((await f.disk()).browser.startPage).toEqual({ title: 'Personal start page' })
  expect(f.owner.current.browser.agentAutomation).toBe(true)
  await expect(f.owner.edit({ ...before, browser: { ...before.browser, startPage: DEFAULT_BROWSER_START_PAGE } },
    { ...before, browser: { ...before.browser, startPage: { ...DEFAULT_BROWSER_START_PAGE, title: 'Conflicting title' } } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  expect((await f.disk()).browser.startPage?.title).toBe('Personal start page')
})

it('rejects invalid presentation assets without changing configuration or Browser authority', async () => {
  const f = await configOwnerFixture(), before = await f.bytes()
  await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'browser.startPage.backgroundImage', value: 'javascript:alert(1)' }, f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  expect(await f.bytes()).toBe(before); expect(f.publish).not.toHaveBeenCalled()
  const receipt = await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'browser.startPage.icon', value: '' }, f.owner)
  if (receipt.operation !== 'settings.set') throw new Error('Expected a settings.set receipt')
  expect(receipt.entry.value).toBe(''); expect(await f.bytes()).toBe(before)
})
