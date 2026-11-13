import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { executeSettingsControl } from '../src/main/settings-control.js'

const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'integer-boundaries' } as const

it.each(['appearance.terminalFontSize', 'moteDirectoryAvatarSize', 'notes.fontSize', 'markdown.readingFontSize'])(
  'keeps %s discovery, durable bounds, lexical validation and nochange together', async key => {
    const f = await configOwnerFixture()
    const result = await executeSettingsControl({ ...envelope, operation: 'settings.get', target: key }, f.owner)
    if (result.operation !== 'settings.get') throw new Error('Expected settings.get')
    expect(result.entries).toHaveLength(1)
    const entry = result.entries[0]
    expect(entry.kind).toBe('number')
    const values = entry.enum as number[]
    expect(values.length).toBeGreaterThan(1)
    expect(values).toContain(entry.default)
    for (const value of [values[0], values.at(-1)!]) {
      const saved = await executeSettingsControl({ ...envelope, operation: 'settings.set', key, value: String(value) }, f.owner)
      expect(saved).toEqual({ operation: 'settings.set', entry: { ...entry, value } })
      expect(await f.disk()).toEqual(f.owner.current)
      const bytes = await f.bytes(), count = f.publish.mock.calls.length
      await executeSettingsControl({ ...envelope, operation: 'settings.set', key, value: String(value) }, f.owner)
      expect(await f.bytes()).toBe(bytes)
      expect(f.publish).toHaveBeenCalledTimes(count)
    }
    const bytes = await f.bytes(), count = f.publish.mock.calls.length
    for (const value of [String(values[0] - 1), String(values.at(-1)! + 1), '-1', '14.0', ' 14', '', '0x10', '1e1', '9007199254740992']) {
      await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key, value }, f.owner))
        .rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
      expect(await f.bytes()).toBe(bytes)
      expect(f.publish).toHaveBeenCalledTimes(count)
    }
  })

it('routes an owned setting to its original operation and saved directory without ConfigOwner writes', async () => {
  const f = await configOwnerFixture()
  const notes = {
    inspect: vi.fn(async () => ({ directory: '/notes/current', operation: { expectedDirectory: '/notes/before' } })),
    change: vi.fn(async () => ({ directory: '/notes/confirmed' }))
  }
  const result = await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'notes.directory', value: '/notes/requested' }, f.owner, notes as never)
  expect(notes.inspect).toHaveBeenCalledWith(envelope.requestId)
  expect(notes.change).toHaveBeenCalledWith({ operationId: envelope.requestId, expectedDirectory: '/notes/before', directory: '/notes/requested' })
  expect(result).toMatchObject({ operation: 'settings.set', requestId: envelope.requestId, entry: { key: 'notes.directory', value: '/notes/confirmed' } })
  expect(f.save).not.toHaveBeenCalled()
  expect(f.publish).not.toHaveBeenCalled()
})

it('names the original owned setting failure in a broad read and preserves exact-target refusal', async () => {
  const f = await configOwnerFixture(), failure = new Error('location unavailable')
  const notes = { inspect: vi.fn(async () => { throw failure }), change: vi.fn() }
  const result = await executeSettingsControl({ ...envelope, operation: 'settings.get' }, f.owner, notes as never)
  expect(result).toMatchObject({ operation: 'settings.get', issues: [{ key: 'notes.directory', code: 'NOTES_DIRECTORY_UNAVAILABLE' }] })
  await expect(executeSettingsControl({ ...envelope, operation: 'settings.get', target: 'notes.directory' }, f.owner, notes as never)).rejects.toBe(failure)
})
