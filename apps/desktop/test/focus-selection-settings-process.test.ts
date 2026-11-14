import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => { const { tmpdir } = await import('node:os'); return { app: { getPath: () => process.env.AGENTMUX_SELECTION_SETTINGS_DIRECTORY ?? tmpdir() } } })
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'
import { ConfigOwner } from '../src/main/config-owner'
import { executeSettingsControl } from '../src/main/settings-control'
import type { AppConfig } from '../src/shared/contracts'

const phase = process.env.AGENTMUX_SELECTION_SETTINGS_PHASE
it.runIf(phase === 'write' || phase === 'read')('persists the original selection choices across two independent configuration processes', async () => {
  const file = process.env.AGENTMUX_SELECTION_SETTINGS_FILE!, receipt = process.env.AGENTMUX_SELECTION_SETTINGS_PHASE_RECEIPT!
  expect(file).toBeTruthy(); expect(receipt).toBeTruthy()
  const store = new ConfigStore(file), fields = ['hosts', 'executors', 'workspaces', 'appearance'] as const
  let current: AppConfig
  if (phase === 'write') { await store.save(structuredClone(DEFAULT_CONFIG)); current = await store.get() }
  else current = await store.get()
  const original = current
  const owner = new ConfigOwner({ read: () => current, save: next => store.save(next), publish: saved => { current = saved } })
  const values = { selectionFillPercent: 28, selectionBorderPercent: 67, selectionAccent: 'purple' } as const
  if (phase === 'write') {
    for (const [field, value] of Object.entries(values)) {
      const result = await executeSettingsControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'private-selection-write-' + field, operation: 'settings.set', key: 'focus.' + field, value: String(value) }, owner)
      expect(result).toMatchObject({ operation: 'settings.set', entry: { key: 'focus.' + field, value } })
    }
  }
  expect(current.focus).toMatchObject(values)
  for (const field of fields) expect(current[field]).toEqual(original[field])
  const inspected = await executeSettingsControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'private-selection-read', operation: 'settings.get', target: 'focus' }, owner)
  expect(inspected.operation).toBe('settings.get')
  if (inspected.operation !== 'settings.get') throw Error('Original discovery required')
  for (const [field, value] of Object.entries(values)) expect(inspected.entries.find(entry => entry.key === 'focus.' + field)?.value).toBe(value)
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  await writeFile(receipt, JSON.stringify({ phase, pid: process.pid, values, coreFields: Object.fromEntries(fields.map(field => [field, hash(current[field])])) }, null, 2) + '\n')
})
