import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { describe, expect, it } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { APP_APPEARANCE_DEFAULT, APP_APPEARANCE_IDS } from '../src/shared/contracts.js'

const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'settings-test' } as const

describe('Main Settings owner', () => {
  it('reports effective values, defaults and the exact currently supported partial surface without a View', async () => {
    const { owner } = await configOwnerFixture({ appearance: { terminalTheme: 'graphite' } })
    const result = await executeSettingsControl({ ...envelope, operation: 'settings.get' }, owner)
    if (result.operation !== 'settings.get') throw new Error('Expected a settings.get receipt')
    expect(result.partial).toBe(true)
    expect(result.entries.filter((entry) => entry.key === 'appearance.appAppearance' || entry.key === 'copyPathsAsAbsolute')).toEqual([
      { key: 'appearance.appAppearance', kind: 'string', value: APP_APPEARANCE_DEFAULT, default: APP_APPEARANCE_DEFAULT, enum: [...APP_APPEARANCE_IDS] },
      { key: 'copyPathsAsAbsolute', kind: 'boolean', value: false, default: false }
    ])
    expect(await executeSettingsControl({ ...envelope, operation: 'settings.get', target: '' }, owner)).toEqual(result)
    expect(await executeSettingsControl({ ...envelope, operation: 'settings.get', target: 'appearance' }, owner)).toEqual({
      ...result, entries: result.entries.filter((entry) => entry.key.startsWith('appearance.'))
    })
    expect(await executeSettingsControl({ ...envelope, operation: 'settings.get', target: 'copyPathsAsAbsolute' }, owner)).toEqual({
      ...result, entries: result.entries.filter((entry) => entry.key === 'copyPathsAsAbsolute')
    })
  })

  it('returns only committed values and keeps every unrelated domain exactly intact', async () => {
    const f = await configOwnerFixture()
    const before = structuredClone(f.owner.current)
    expect(await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'appearance.appAppearance', value: 'light' }, f.owner)).toEqual({
      operation: 'settings.set', entry: { key: 'appearance.appAppearance', kind: 'string', value: 'light', default: APP_APPEARANCE_DEFAULT, enum: [...APP_APPEARANCE_IDS] }
    })
    expect(await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'copyPathsAsAbsolute', value: 'true' }, f.owner)).toEqual({
      operation: 'settings.set', entry: { key: 'copyPathsAsAbsolute', kind: 'boolean', value: true, default: false }
    })
    const expected = { ...before, appearance: { ...before.appearance, appAppearance: 'light' }, copyPathsAsAbsolute: true }
    expect(f.owner.current).toEqual(expected)
    expect(await f.disk()).toEqual(expected)
    expect(f.publish).toHaveBeenCalledTimes(2)
    expect(f.runtime.commit).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['appearance.appAppearance', 'LIGHT', 'INVALID_SETTING_VALUE'],
    ['appearance.appAppearance', 'system ', 'INVALID_SETTING_VALUE'],
    ['copyPathsAsAbsolute', '1', 'INVALID_SETTING_VALUE'],
    ['copyPathsAsAbsolute', 'TRUE', 'INVALID_SETTING_VALUE'],
    ['browser.agentAutomation', 'TRUE', 'INVALID_SETTING_VALUE'],
    ['browser.appLinkSchemes.custom', 'allow', 'UNSUPPORTED_SETTING'],
    ['hosts.local.kind', 'ssh', 'UNSUPPORTED_SETTING']
  ])('rejects %s=%s without changing disk, Runtime or public facts', async (key, value, code) => {
    const f = await configOwnerFixture()
    const before = await f.bytes()
    await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key, value }, f.owner)).rejects.toMatchObject({ code })
    expect(await f.bytes()).toBe(before)
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.runtime.prepare).not.toHaveBeenCalled()
  })

  it('does not report success after persistence failure and accepts a later retry', async () => {
    const f = await configOwnerFixture()
    const before = await f.bytes()
    f.save.mockRejectedValueOnce(new Error('disk full'))
    const request = { ...envelope, operation: 'settings.set', key: 'copyPathsAsAbsolute', value: 'true' } as const
    await expect(executeSettingsControl(request, f.owner)).rejects.toThrow('disk full')
    expect(await f.bytes()).toBe(before)
    expect(f.publish).not.toHaveBeenCalled()
    const retried = await executeSettingsControl(request, f.owner)
    if (retried.operation !== 'settings.set') throw new Error('Expected a settings.set receipt')
    expect(retried.entry.value).toBe(true)
    expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
  })

  it('rejects unknown read targets honestly instead of returning an empty success', async () => {
    const { owner } = await configOwnerFixture()
    await expect(executeSettingsControl({ ...envelope, operation: 'settings.get', target: 'browser.appLinkSchemes' }, owner)).rejects.toMatchObject({ code: 'UNSUPPORTED_SETTING' })
  })

  it('does not persist or publish effective default values when the optional fields are absent', async () => {
    const f = await configOwnerFixture({ appearance: { terminalTheme: 'graphite' } })
    expect(f.owner.current.appearance.appAppearance).toBeUndefined()
    expect(f.owner.current.copyPathsAsAbsolute).toBeUndefined()
    const bytes = await f.bytes(), current = f.owner.current
    const result = await executeSettingsControl({ ...envelope, operation: 'settings.get' }, f.owner)
    if (result.operation !== 'settings.get') throw new Error('Expected a settings.get receipt')
    expect(result.entries.length).toBeGreaterThan(0)
    for (const entry of result.entries) await executeSettingsControl({
      ...envelope, operation: 'settings.set', key: entry.key, value: String(entry.value)
    }, f.owner)
    expect(await f.bytes()).toBe(bytes)
    expect(f.owner.current).toBe(current)
    expect(f.save).not.toHaveBeenCalled()
    expect(f.runtime.prepare).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()
  })
})
