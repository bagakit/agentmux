import { expect, it, vi } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentMuxError } from '../src/errors.js'
import { retryAgentCreationResources, type AgentCreationResourceContext } from '../src/agent-creation-resource-retry.js'

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async (_ms, _value, options) => options.signal.throwIfAborted()) }))

function capacity(operationId = 'original', disposition: 'unknown' | 'not_applied' = 'not_applied') {
  const error = new AgentMuxError('Any display wording', 'STORE_FAILURE', undefined, undefined, undefined,
    { operationId, disposition })
  Object.defineProperty(error, 'cause', { value: Object.assign(new Error('Different wording'), { code: 'ENOSPC' }) })
  return error
}

it('retries the original negative receipt using bounded backoff without a fixed abandonment count', async () => {
  vi.mocked(delay).mockClear()
  const failure = capacity(), controller = new AbortController(), waiting = vi.fn()
  let calls = 0
  const attempt = vi.fn(async () => { if (++calls <= 8) throw failure; return 'original-result' })
  expect(await retryAgentCreationResources({ operationId: 'original', signal: controller.signal, attempt, waiting })).toBe('original-result')
  expect(attempt).toHaveBeenCalledTimes(9)
  expect(waiting.mock.calls.map(([, ms]) => ms)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
})

it.each([
  ['foreign operation', () => capacity('other')],
  ['unknown effect', () => capacity('original', 'unknown')],
  ['display text only', () => new AgentMuxError('ENOSPC no space left on device', 'UNKNOWN', undefined, undefined, undefined,
    { operationId: 'original', disposition: 'not_applied' })],
  ['missing receipt', () => Object.assign(new Error('Any'), { code: 'ENOSPC' })],
  ['nonresource failure', () => new AgentMuxError('Invalid permission', 'PERMISSION_DENIED', undefined, undefined, undefined,
    { operationId: 'original', disposition: 'not_applied' })]
])('never retries %s', async (_name, makeError) => {
  const error = makeError(), controller = new AbortController()
  const waiting = vi.fn(() => controller.abort()), attempt = vi.fn(async () => { throw error })
  await expect(retryAgentCreationResources({ operationId: 'original', signal: controller.signal, attempt, waiting })).rejects.toBe(error)
  expect(waiting).not.toHaveBeenCalled()
  expect(attempt).toHaveBeenCalledTimes(1)
})

it('retries only exact owner cleanup before attempting Start again', async () => {
  const error = Object.assign(capacity(), { cleanup: [Object.assign(new Error('Cleanup full'), { code: 'ENOSPC' })],
    retryCreationCleanup: vi.fn(async () => { if (error.retryCreationCleanup.mock.calls.length === 1) throw error.cause; error.cleanup = [] }) })
  const controller = new AbortController(), order: string[] = []
  const attempt = vi.fn(async () => { order.push('attempt'); if (order.length === 1) throw error; return 'created' })
  expect(await retryAgentCreationResources({ operationId: 'original', signal: controller.signal, attempt,
    waiting: () => { order.push('waiting') } })).toBe('created')
  expect(order).toEqual(['attempt', 'waiting', 'waiting', 'attempt'])
  expect(error.retryCreationCleanup).toHaveBeenCalledTimes(2)
})

it('does not replace an uncertain cleanup with another Start', async () => {
  const error = Object.assign(capacity(), { cleanup: [new Error('Unknown cleanup')] })
  const attempt = vi.fn(async () => { throw error }), waiting = vi.fn()
  await expect(retryAgentCreationResources({ operationId: 'original', signal: new AbortController().signal, attempt, waiting })).rejects.toBe(error)
  expect(attempt).toHaveBeenCalledTimes(1); expect(waiting).not.toHaveBeenCalled()
})

it('cancellation returns the original failure without another Start', async () => {
  const controller = new AbortController(), error = capacity(), attempt = vi.fn(async () => { throw error })
  await expect(retryAgentCreationResources({ operationId: 'original', signal: controller.signal, attempt,
    waiting: () => controller.abort() })).rejects.toBe(error)
  expect(attempt).toHaveBeenCalledTimes(1)
})

it('waits only the narrow preparation read, preserving its original failure and the enclosing execution', async () => {
  const error = Object.assign(new Error('Any presentation'), { code: 'ENOSPC' }), waiting = vi.fn()
  let reads = 0
  const attempt = vi.fn(async ({ preparation }: AgentCreationResourceContext) => {
    return await preparation(async () => { if (++reads === 1) throw error; return 'same-original-read' })
  })
  expect(await retryAgentCreationResources({ operationId: () => undefined, signal: new AbortController().signal, attempt, waiting })).toBe('same-original-read')
  expect(attempt).toHaveBeenCalledTimes(1); expect(reads).toBe(2); expect(waiting).toHaveBeenCalledWith(error, 1000)
})

it.each(['cause', 'aggregate'])('does not swallow any creation receipt hidden in the %s tree as raw preparation capacity', async kind => {
  const receipt = capacity('foreign', 'unknown')
  const error = kind === 'cause' ? Object.assign(new Error('wrapper', { cause: receipt }), { code: 'ENOSPC' })
    : new AggregateError([Object.assign(new Error('full'), { code: 'ENOSPC' }), receipt], 'all full')
  const read = vi.fn(async () => { throw error }), waiting = vi.fn()
  await expect(retryAgentCreationResources({ operationId: 'original', signal: new AbortController().signal,
    attempt: async ({ preparation }) => await preparation(read), waiting })).rejects.toBe(error)
  expect(read).toHaveBeenCalledTimes(1); expect(waiting).not.toHaveBeenCalled()
})

it('cancels after an in-flight preparation read before executing its caller continuation', async () => {
  const controller = new AbortController(), continuation = vi.fn()
  await expect(retryAgentCreationResources({ operationId: () => undefined, signal: controller.signal,
    attempt: async ({ preparation }) => { await preparation(async () => { controller.abort(); return 'read' }); continuation() }, waiting: vi.fn()
  })).rejects.toThrow()
  expect(continuation).not.toHaveBeenCalled()
})
