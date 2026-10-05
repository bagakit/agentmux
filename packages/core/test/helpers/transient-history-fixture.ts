import { fixtureClock, fixtureDay } from './fixture-values.js'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import { AgentMuxError } from '../../src/errors.js'
import type { AgentProvider } from '../../src/agent-provider.js'
import type { AgentProviderSessionHistoryObservationContext, AgentSessionHistoryObservation } from '../../src/types.js'
import type { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'
import { jsonl, nativeHistoryFixture } from '../fixtures/native-history-session.js'

export const historyRow = (id: string) => ({ uuid: id, type: 'assistant', sessionId: 'native-main',
  message: { role: 'assistant', content: [{ type: 'text', text: `${id} native reply remains readable.` }] }, timestamp: fixtureDay(1) + "T" + fixtureClock(0, 0, 0) + "Z" })

/** Real Core binding and built-in file reader; only native event/witness and adapter facts are controlled. */
export async function transientHistoryFixture() {
  const f = await nativeHistoryFixture('claude', jsonl([historyRow('original')]))
  const oldPath = join(f.root, 'retained-old.jsonl')
  await writeFile(oldPath, jsonl([{ ...historyRow('old'), sessionId: 'retained-old' }]))
  const retained = { ...f.session, nativeHandle: { ...f.session.nativeHandle!, sessionId: 'retained-old', transcriptPath: oldPath } }
  await f.store.compareAndSwap(f.session, retained)
  const before = await readFile(f.storePath)
  const kernel = Reflect.get(f.client, 'kernel') as CtxmuxRunAdapter
  await Reflect.get(f.client, 'registry').load('local')
  Reflect.set(f.client, 'connected', true)
  vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
  vi.spyOn(kernel, 'identity').mockReturnValue({ daemonInstanceId: 'private-transient-history', buildIdentity: 'private', protocolVersion: 18 } as ReturnType<CtxmuxRunAdapter['identity']>)
  const run = { runId: retained.run.runId, workspacePath: f.root, pid: process.pid, state: { type: 'running' as const }, acceptedInputBytes: 0 }
  vi.mocked(kernel.status).mockResolvedValue(run as Awaited<ReturnType<CtxmuxRunAdapter['status']>>)
  const input = vi.mocked(kernel.input).mockResolvedValue({ run: { ...run, acceptedInputBytes: 1 }, appliedByteRange: { startByte: 0, endByte: 1 } } as Awaited<ReturnType<CtxmuxRunAdapter['input']>>)
  const provider = f.client.providers.get('claude') as AgentProvider & Required<Pick<AgentProvider, 'discoverNativeSession' | 'observeSessionHistory'>>, source = { providerId: 'claude', nativeSessionId: 'native-main' }
  const witness = vi.fn(async () => {})
  const discover = vi.spyOn(provider, 'discoverNativeSession').mockResolvedValue({
    handle: { kind: 'provider', providerId: 'claude', sessionId: source.nativeSessionId, transcriptPath: f.path }, assertCurrent: witness })
  // The source is confirmed, but its durable locator cannot be published. Core must own a transient witness.
  vi.spyOn(f.store, 'compareAndSwapMetadata').mockRejectedValue(Object.assign(new Error('Private locator save unavailable'), { code: 'ENOSPC' }))
  let context!: AgentProviderSessionHistoryObservationContext
  const released = vi.fn()
  const observe = vi.spyOn(provider, 'observeSessionHistory').mockImplementation(async value => {
    context = value; return { source: value.source, dispose: released }
  })
  const changes: AgentSessionHistoryObservation[] = []
  const originalObserve = f.client.observeSessionHistory.bind(f.client)
  vi.spyOn(f.client, 'observeSessionHistory').mockImplementation((id, listener, options) => originalObserve(id, value => {
    changes.push(value); listener(value)
  }, options))
  const readMetadata = f.store.readMetadata.bind(f.store)
  const metadata = vi.spyOn(f.store, 'readMetadata').mockImplementation(readMetadata)
  return { ...f, retained, before, kernel, run, input, source, witness, discover, released, observe, changes, metadata,
    invalidate: () => context.onChange({ kind: 'invalidated', source }),
    report: (observation: Parameters<AgentProviderSessionHistoryObservationContext['onChange']>[0]) => context.onChange(observation),
    append: async (id = 'later') => appendFile(f.path, jsonl([historyRow(id)])),
    fail: (kind: 'metadata' | 'witness') => {
      if (kind === 'metadata') metadata.mockRejectedValueOnce(Object.assign(new Error('Private metadata read EIO'), { code: 'EIO' }))
      else witness.mockRejectedValueOnce(new AgentMuxError('Private current witness is busy', 'AGENT_SESSION_STORE_BUSY'))
    }
  }
}
