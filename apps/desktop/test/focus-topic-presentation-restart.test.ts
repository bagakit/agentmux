import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => { const { tmpdir } = await import('node:os'); return { app: { getPath: () => process.env.AGENTMUX_TOPIC_SETTINGS_DIRECTORY ?? tmpdir() } } })
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'
import { ConfigOwner } from '../src/main/config-owner'
import { executeSettingsControl } from '../src/main/settings-control'
import type { AppConfig } from '../src/shared/contracts'

const phase = process.env.AGENTMUX_TOPIC_SETTINGS_PHASE
it.runIf(phase === 'write' || phase === 'read')('writes and reopens the original private Topic preference in separate processes', async () => {
  const file = process.env.AGENTMUX_TOPIC_SETTINGS_FILE!, receipt = process.env.AGENTMUX_TOPIC_SETTINGS_PROCESS_RECEIPT!
  expect(file).toBeTruthy(); expect(receipt).toBeTruthy()
  const store = new ConfigStore(file)
  const source = structuredClone(DEFAULT_CONFIG)
  const fields = ['hosts', 'executors', 'workspaces', 'appearance'] as const
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  let current: AppConfig
  if (phase === 'write') {
    await store.save(source)
    // A real application edits the original already-loaded configuration. Let
    // ConfigStore establish its ordinary built-in resources before this choice.
    current = await store.get()
    const original = current
    const owner = new ConfigOwner({ read: () => current!, save: next => store.save(next), publish: saved => { current = saved } })
    const result = await executeSettingsControl({ schemaVersion: 5, requestId: 'private-process-topic-choice', operation: 'settings.set', key: 'focus.topicPresentation', value: 'sections' }, owner)
    expect(result.operation).toBe('settings.set')
    expect(current.focus?.topicPresentation).toBe('sections')
    for (const field of fields) expect(current[field]).toEqual(original[field])
  } else current = await store.get()
  expect(current.focus?.topicPresentation).toBe('sections')
  const inspected = await executeSettingsControl({ schemaVersion: 5, requestId: 'private-process-topic-read', operation: 'settings.get', target: 'focus.topicPresentation' },
    new ConfigOwner({ read: () => current, save: next => store.save(next), publish: saved => { current = saved } }))
  expect(inspected).toMatchObject({ entries: [{ key: 'focus.topicPresentation', value: 'sections', default: 'cards', enum: ['cards', 'sections'] }] })
  await writeFile(receipt, JSON.stringify({ phase, pid: process.pid, topicPresentation: current.focus?.topicPresentation,
    coreFields: Object.fromEntries(fields.map(field => [field, hash(current[field])])) }, null, 2) + '\n')
})
