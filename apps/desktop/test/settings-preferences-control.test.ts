import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { scalarSettingsSchemaKeys } from './helpers/settings-schema-keys.js'
import { describe, expect, it } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlSettingEntry } from '@agentmux/core'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { BROWSER_TOOLBAR_ITEM_ORDER } from '../src/shared/browser-toolbar.js'
import { TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_DEFAULT } from '../src/shared/contracts.js'

const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'preferences-test' } as const
async function entries(owner: Awaited<ReturnType<typeof configOwnerFixture>>['owner']) {
  const result = await executeSettingsControl({ ...envelope, operation: 'settings.get' }, owner)
  if (result.operation !== 'settings.get') throw new Error('Expected settings.get')
  expect(result.entries.length).toBeGreaterThan(0)
  return result.entries.filter((entry) => entry.key !== 'browser.agentAutomation')
}


function alternate(entry: AgentMuxControlSettingEntry) {
  if (entry.kind === 'boolean') return !entry.value
  const choice = entry.enum?.find((value) => value !== entry.value)
  expect(choice, `alternate for ${entry.key}`).toBeDefined()
  return choice!
}

describe('ordinary preferences through the Main owner', () => {
  it('covers every actual scalar schema leaf and every real toolbar field with a nonempty support surface', async () => {
    const { owner } = await configOwnerFixture()
    const actual = await entries(owner), discovered = (await scalarSettingsSchemaKeys()).filter((key) => key !== 'browser.agentAutomation')
    expect(actual.map((entry) => entry.key).sort()).toEqual(discovered.sort())
    const toolbar = discovered.filter((key) => key.startsWith('browser.toolbar.'))
    expect(toolbar.length).toBeGreaterThan(0)
    expect(toolbar.sort()).toEqual(BROWSER_TOOLBAR_ITEM_ORDER.map((key) => `browser.toolbar.${key}`).sort())
    for (const target of ['appearance', 'notifications', 'browser.toolbar']) {
      const result = await executeSettingsControl({ ...envelope, operation: 'settings.get', target }, owner)
      expect(result).toEqual({ operation: 'settings.get', partial: true, entries: actual.filter((entry) => entry.key.startsWith(`${target}.`)) })
    }
  })

  it('changes, rejects invalid values and proves real nochange for every supported field without touching permissions or resources', async () => {
    const f = await configOwnerFixture({ browser: { ...structuredClone(DEFAULT_CONFIG.browser), agentAutomation: false, appLinkSchemes: { custom: 'deny' } } })
    const initial = structuredClone(f.owner.current), supported = await entries(f.owner)
    for (const entry of supported) {
      const next = alternate(entry), before = f.publish.mock.calls.length
      const result = await executeSettingsControl({ ...envelope, operation: 'settings.set', key: entry.key, value: String(next) }, f.owner)
      expect(result).toMatchObject({ operation: 'settings.set', entry: { ...entry, value: next } })
      expect(f.publish).toHaveBeenCalledTimes(before + 1)
      const bytes = await f.bytes()
      await executeSettingsControl({ ...envelope, operation: 'settings.set', key: entry.key, value: String(next) }, f.owner)
      expect(await f.bytes()).toBe(bytes)
      expect(f.publish).toHaveBeenCalledTimes(before + 1)
      await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key: entry.key, value: 'INVALID' }, f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
      expect(await f.bytes()).toBe(bytes)
      expect(f.publish).toHaveBeenCalledTimes(before + 1)
      expect(f.owner.current.browser.agentAutomation).toBe(false)
      expect(f.owner.current.browser.appLinkSchemes).toEqual({ custom: 'deny' })
      expect(f.owner.current.hosts).toEqual(initial.hosts)
      expect(f.owner.current.workspaces).toEqual(initial.workspaces)
      expect(f.owner.current.executors).toEqual(initial.executors)
    }
    expect(await f.disk()).toEqual(f.owner.current)
  })

  it('reports the actual font integer range and rejects values before persistence can silently clamp them', async () => {
    const f = await configOwnerFixture()
    const font = (await entries(f.owner)).find((entry) => entry.key === 'appearance.terminalFontSize')
    expect(font).toEqual({ key: 'appearance.terminalFontSize', kind: 'number', value: TERMINAL_FONT_SIZE_DEFAULT,
      default: TERMINAL_FONT_SIZE_DEFAULT, enum: Array.from({ length: TERMINAL_FONT_SIZE_MAX - TERMINAL_FONT_SIZE_MIN + 1 }, (_, index) => TERMINAL_FONT_SIZE_MIN + index) })
    const bytes = await f.bytes()
    for (const value of ['NaN', 'Infinity', '12.5', '', '0x10', String(TERMINAL_FONT_SIZE_MIN - 1), String(TERMINAL_FONT_SIZE_MAX + 1)]) {
      await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key: font!.key, value }, f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    }
    expect(await f.bytes()).toBe(bytes)
    expect(f.runtime.prepare).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()
  })

  it('keeps absent effective defaults absent and allows sound to be prepared while notifications stay off', async () => {
    const f = await configOwnerFixture({ appearance: { terminalTheme: 'graphite' }, notifications: { mode: 'off' } })
    const bytes = await f.bytes(), current = f.owner.current, supported = await entries(f.owner)
    for (const entry of supported) await executeSettingsControl({ ...envelope, operation: 'settings.set', key: entry.key, value: String(entry.value) }, f.owner)
    expect(await f.bytes()).toBe(bytes)
    expect(f.owner.current).toBe(current)
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.runtime.prepare).not.toHaveBeenCalled()
    await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'notifications.sound', value: 'true' }, f.owner)
    expect(f.owner.current.notifications).toEqual({ mode: 'off', sound: true })
  })
})
