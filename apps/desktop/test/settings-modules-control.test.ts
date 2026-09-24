import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { expect, it } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { scalarSettingsSchemaKeys } from './helpers/settings-schema-keys.js'

const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'module-composition' } as const

it('composes every durable scalar once, groups the public list and keeps the original target contract', async () => {
  const { owner, bytes, save, runtime } = await configOwnerFixture()
  const before = await bytes()
  const result = await executeSettingsControl({ ...envelope, operation: 'settings.get' }, owner)
  if (result.operation !== 'settings.get') throw new Error('Expected settings.get')
  const keys = result.entries.map(entry => entry.key)
  expect(keys).toHaveLength(14)
  expect(new Set(keys).size).toBe(keys.length)
  expect([...keys].sort()).toEqual((await scalarSettingsSchemaKeys()).sort())
  expect(keys.map(key => key.startsWith('appearance.') ? 'appearance'
    : key.startsWith('notifications.') ? 'notifications'
    : key.startsWith('browser.') ? 'browser' : 'general'))
    .toEqual(['appearance', 'appearance', 'appearance', 'general', 'general',
      'notifications', 'notifications', 'browser', 'browser', 'browser', 'browser', 'browser', 'browser', 'browser'])
  for (const target of ['appearance', 'notifications', 'browser', 'browser.toolbar']) {
    const expected = result.entries.filter(entry => entry.key.startsWith(`${target}.`))
    expect(expected.length).toBeGreaterThan(0)
    expect(await executeSettingsControl({ ...envelope, operation: 'settings.get', target }, owner))
      .toEqual({ operation: 'settings.get', partial: true, entries: expected })
  }
  await expect(executeSettingsControl({ ...envelope, operation: 'settings.get', target: 'general' }, owner))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_SETTING' })
  expect(await bytes()).toBe(before)
  expect(save).not.toHaveBeenCalled()
  expect(runtime.prepare).not.toHaveBeenCalled()
})
