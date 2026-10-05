import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { transientHistoryFixture } from './helpers/transient-history-fixture.js'

const fixtures: Array<Awaited<ReturnType<typeof transientHistoryFixture>>> = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); vi.restoreAllMocks() })
async function fixture() { const f = await transientHistoryFixture(); fixtures.push(f); return f }

it.each(['metadata', 'witness'] as const)('retains the actual transient Core binding after %s uncertainty, without publishing an unchecked event or polling', async kind => {
  const f = await fixture(), handle = await f.client.observeSessionHistory(f.retained.agentSessionId, () => {})
  expect(handle.source).toEqual(f.source)
  expect(f.discover).toHaveBeenCalledOnce()
  expect(f.client.agentSession(f.retained.agentSessionId).nativeHandle?.sessionId).toBe('retained-old')
  expect([...Reflect.get(f.client, 'historyObservationControllers').get(f.retained.agentSessionId)][0].binding.transient).toBe(true)
  expect((await f.client.sessionHistoryPage(f.retained.agentSessionId)).source).toEqual(f.source)
  f.fail(kind); f.invalidate()
  await vi.waitFor(() => expect(f.changes).toHaveLength(1))
  expect(f.changes[0]).toMatchObject({ kind: 'unavailable', source: f.source, code: kind === 'metadata' ? 'EIO' : 'AGENT_SESSION_STORE_BUSY' })
  expect(f.released).not.toHaveBeenCalled()
  const reads = f.metadata.mock.calls.length, proofs = f.witness.mock.calls.length
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.metadata).toHaveBeenCalledTimes(reads); expect(f.witness).toHaveBeenCalledTimes(proofs)
  expect(f.changes.filter(value => value.kind === 'invalidated')).toEqual([])
  f.invalidate()
  await vi.waitFor(() => expect(f.changes).toHaveLength(2))
  expect(f.changes[1]).toEqual({ kind: 'invalidated', agentSessionId: f.retained.agentSessionId, source: f.source })
  expect(f.discover).toHaveBeenCalledOnce(); expect(f.observe).toHaveBeenCalledOnce()
  expect(await readFile(f.storePath)).toEqual(f.before)
  handle.dispose(); expect(f.released).toHaveBeenCalledOnce()
})

it('flushes a real new event received during a failed in-flight transient check, without replaying the failed event', async () => {
  const f = await fixture(), handle = await f.client.observeSessionHistory(f.retained.agentSessionId, () => {})
  let reject!: (error: unknown) => void
  const gate = new Promise<void>((_resolve, no) => { reject = no })
  const priorChecks = f.witness.mock.calls.length
  f.witness.mockImplementationOnce(() => gate)
  f.invalidate()
  await vi.waitFor(() => expect(f.witness).toHaveBeenCalledTimes(priorChecks + 1))
  f.invalidate()
  reject(Object.assign(new Error('Private witness EIO while a newer event is pending'), { code: 'EIO' }))
  await vi.waitFor(() => expect(f.changes).toHaveLength(2))
  expect(f.changes.map(value => value.kind)).toEqual(['unavailable', 'invalidated'])
  expect(f.released).not.toHaveBeenCalled()
  handle.dispose()
})

it.each(['source-changed', 'cancel', 'dispose', 'client-dispose'] as const)('releases an in-flight transient source check on %s and drops its late completion', async reason => {
  const f = await fixture(), controller = new AbortController()
  const handle = await f.client.observeSessionHistory(f.retained.agentSessionId, () => {}, { signal: controller.signal })
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const priorChecks = f.witness.mock.calls.length
  f.witness.mockImplementationOnce(() => gate); f.invalidate()
  await vi.waitFor(() => expect(f.witness).toHaveBeenCalledTimes(priorChecks + 1))
  if (reason === 'source-changed') f.report({ kind: 'unavailable', source: f.source, code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', message: 'Confirmed native replacement' })
  else if (reason === 'cancel') controller.abort()
  else if (reason === 'client-dispose') await f.client.dispose()
  else handle.dispose()
  finish()
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.released).toHaveBeenCalledOnce()
  expect(f.changes.filter(value => value.kind === 'invalidated')).toEqual([])
  expect(f.changes).toHaveLength(reason === 'source-changed' ? 1 : 0)
})

it('ends the exact transient watch when its witness confirms a source change', async () => {
  const f = await fixture(), handle = await f.client.observeSessionHistory(f.retained.agentSessionId, () => {})
  f.witness.mockRejectedValueOnce(new AgentMuxError('Confirmed current source changed', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'))
  f.invalidate()
  await vi.waitFor(() => expect(f.released).toHaveBeenCalledOnce())
  expect(f.changes).toEqual([expect.objectContaining({ kind: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })])
  f.invalidate(); await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.changes).toHaveLength(1); handle.dispose()
})
