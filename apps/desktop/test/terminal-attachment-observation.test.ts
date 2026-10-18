import { afterEach, expect, it, vi } from 'vitest'
import type { SessionAttachResult } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { observeTerminalAttachment } from '../src/renderer/src/lib/terminal-attachment-observation'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
// Only the original lease identity participates in these isolated handoff cases.
const result = (attachmentId: string) => ({ attachmentId }) as SessionAttachResult
afterEach(() => vi.restoreAllMocks())

it('retires only the reader and releases the exact late new lease once', async () => {
  const original = deferred<SessionAttachResult>(), lifetime = new AbortController(), reason = Symbol('retired')
  const detach = vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  let settled = false
  void original.promise.then(() => { settled = true })
  const reader = observeTerminalAttachment(original.promise, lifetime.signal, null)
  lifetime.abort(reason)
  await expect(reader).rejects.toBe(reason)
  expect(settled).toBe(false)
  expect(detach).not.toHaveBeenCalled()
  const receipt = result('original-late-lease')
  original.resolve(receipt)
  await expect(original.promise).resolves.toBe(receipt)
  expect(detach).toHaveBeenCalledExactlyOnceWith(receipt.attachmentId)
})

it('hands off an already delivered receipt before the reader continuation and leaves its lease to that owner', async () => {
  const original = deferred<SessionAttachResult>(), lifetime = new AbortController(), receipt = result('delivered-lease')
  const detach = vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  const reader = observeTerminalAttachment(original.promise, lifetime.signal, null)
  original.resolve(receipt)
  // The helper delivered the exact result, but the caller has not consumed its await yet.
  await Promise.resolve()
  lifetime.abort(Symbol('retired-after-delivery'))
  await expect(reader).resolves.toBe(receipt)
  expect(detach).not.toHaveBeenCalled()
})

it.each(['retained-lease', 'new-late-lease'])('keeps the existing refresh lease owner when its late result is %s', async attachmentId => {
  const original = deferred<SessionAttachResult>(), lifetime = new AbortController(), reason = Symbol('retired')
  const detach = vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  const reader = observeTerminalAttachment(original.promise, lifetime.signal, 'retained-lease')
  lifetime.abort(reason)
  await expect(reader).rejects.toBe(reason)
  original.resolve(result(attachmentId)); await original.promise
  if (attachmentId === 'retained-lease') expect(detach).not.toHaveBeenCalled()
  else expect(detach).toHaveBeenCalledExactlyOnceWith(attachmentId)
})

it('observes a late rejection after retirement without replacing the original failure', async () => {
  const original = deferred<SessionAttachResult>(), lifetime = new AbortController(), reason = Symbol('retired')
  const detach = vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  const reader = observeTerminalAttachment(original.promise, lifetime.signal, null)
  lifetime.abort(reason); await expect(reader).rejects.toBe(reason)
  const error = new Error('Original attach reply failed later')
  original.reject(error)
  await expect(original.promise).rejects.toBe(error)
  expect(detach).not.toHaveBeenCalled()
})

it('reports synchronous late-release failure and preserves the original reply', async () => {
  const original = deferred<SessionAttachResult>(), lifetime = new AbortController(), reason = Symbol('retired')
  const error = new Error('Original release acknowledgement unavailable')
  vi.spyOn(api.sessions, 'detach').mockImplementation(() => { throw error })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const reader = observeTerminalAttachment(original.promise, lifetime.signal, null)
  lifetime.abort(reason); await expect(reader).rejects.toBe(reason)
  const receipt = result('late-failed-release')
  original.resolve(receipt); await expect(original.promise).resolves.toBe(receipt)
  expect(warning).toHaveBeenCalledExactlyOnceWith('[terminal] Late Attachment release was not acknowledged', error)
})
