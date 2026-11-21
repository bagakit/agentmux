import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openModelStateMainChild } from './fixtures/model-state-child.mjs'

// These product consumers require the gate's exact compiled candidate, not the default unit environment.
const product = it.skipIf(!['surface', 'integration'].includes(process.env.AMX_MODEL_SYNC_MODE ?? ''))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function owner() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-model-main-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const child = await openModelStateMainChild(directory)
  cleanup.push(child.close)
  return child
}
const selection = (inspection: any, operationId: string) => ({ target: inspection.target, operationId,
  configId: 'model', value: 'model-large', expectedRevision: inspection.snapshot.revision })

product('actual Main configuration inspection uses only its original public configuration channel while account reads are unavailable', async () => {
  const f = await owner(), control = f.ready.control
  await f.call('mode', { mode: 'unavailable' })
  const config = await f.call('inspectConfiguration', control)
  expect(config).toMatchObject({ kind: 'configuration', target: { agentSessionId: control.agentSessionId, expectedRun: control.run },
    snapshot: { options: [{ currentValue: 'model-small' }] } })
  const stats = await f.call('stats')
  expect(stats.informationReads).toBe(0)
  expect(stats.requests.every((request: any) => request.method === 'agent.configuration.inspect')).toBe(true)
  expect(stats.runtimeWrites).toBe(0)
})

product('a Main target refusal preserves its exact failure and never reaches Core native dispatch or creates an unknown receipt', async () => {
  const f = await owner(), control = f.ready.control, input = selection(f.ready.inspection, 'wrong-original-target')
  input.target = { ...input.target, expectedRun: { runId: 'foreign-run' } }
  await expect(f.call('setConfiguration', control, input)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST',
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
  expect(await f.call('inspectConfiguration', control, input.operationId)).toMatchObject({ kind: 'operation', operation: null })
  const stats = await f.call('stats')
  expect(stats.nativeWrites).toEqual([])
  expect(stats.requests.filter((request: any) => request.method === 'agent.configuration.set')).toEqual([])
})

product('Main preserves an explicit native refusal and its original read-only operation inspection', async () => {
  const f = await owner(), control = f.ready.control, input = selection(f.ready.inspection, 'original-native-refusal')
  await f.call('mode', { mode: 'refused' })
  const receipt = await f.call('setConfiguration', control, input)
  expect(receipt).toMatchObject({ outcome: 'not-applied', operationId: input.operationId,
    issue: 'The original native setting was explicitly refused.' })
  expect(await f.call('inspectConfiguration', control, input.operationId)).toMatchObject({ kind: 'operation', operation: receipt })
  const stats = await f.call('stats')
  expect(stats.nativeWrites).toHaveLength(1)
  expect(stats.configurationReads).toBe(1)
  expect(stats.runtimeWrites).toBe(0)
})

product('a lost Main reply retains the actual applied original operation without dispatching it again', async () => {
  const f = await owner(), control = f.ready.control, input = selection(f.ready.inspection, 'original-lost-reply')
  await f.call('mode', { dropReply: true })
  await expect(f.call('setConfiguration', control, input)).rejects.toMatchObject({ code: 'CONTROL_CONNECTION_FAILED',
    controlFailure: { disposition: 'unknown', confirmedInputBytes: null } })
  const result = await f.call('inspectConfiguration', control, input.operationId)
  expect(result).toMatchObject({ kind: 'operation', operation: { outcome: 'applied', operationId: input.operationId,
    acknowledgement: { options: [{ currentValue: 'model-large' }] } } })
  const stats = await f.call('stats')
  expect(stats.nativeWrites).toHaveLength(1)
  expect(stats.requests.filter((request: any) => request.method === 'agent.configuration.set')).toHaveLength(1)
  expect(stats.runtimeWrites).toBe(0)
})

product('the actual Core Session event reaches Main publication with the same ordered unlisted current configuration', async () => {
  const f = await owner()
  await f.call('emit', { current: 'unlisted-native-current', choices: [], sequence: 5, observedAt: 1000 })
  const event = f.events.filter((event: any) => event.event.type === 'agent-session' &&
    event.event.session.nativeConfiguration?.observation?.sequence === 5).at(-1)
  expect(event).toMatchObject({ type: 'core', hostId: f.ready.control.hostId,
    event: { type: 'agent-session', session: { agentSessionId: f.ready.control.agentSessionId,
      run: f.ready.control.run, nativeConfiguration: { options: [{ currentValue: 'unlisted-native-current', choices: [] }],
        observation: { sequence: 5, observedAt: 1000, state: 'confirmed' } } } } })
  expect((await f.call('stats')).runtimeWrites).toBe(0)
})
