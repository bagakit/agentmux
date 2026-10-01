import { expect, it, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import { sessionInputWriteResult, unwrapSessionInputWriteResult } from '../src/shared/session-input-result'

it.each([3, 0, null])('keeps confirmed request prefix %s across the Main/preload structured clone with one write attempt', async confirmedInputBytes => {
  const write = vi.fn(async () => { throw new AgentMuxError('Native input outcome unconfirmed.', 'CTXMUX_io', 'unknown', { disposition: 'unknown', confirmedInputBytes }) })
  const result = structuredClone(await sessionInputWriteResult(write))
  expect(() => unwrapSessionInputWriteResult(result)).toThrow(expect.objectContaining({
    code: 'CTXMUX_io', detail: 'unknown', controlFailure: { disposition: 'unknown', confirmedInputBytes }
  }))
  expect(write).toHaveBeenCalledOnce()
})

it('lets the normal successful write resolve through the same Main/preload boundary', async () => {
  const write = vi.fn(async () => {})
  const awaitedResult = await sessionInputWriteResult(write)
  expect(() => unwrapSessionInputWriteResult(structuredClone(awaitedResult))).not.toThrow()
  expect(awaitedResult).toEqual({ ok: true })
  expect(write).toHaveBeenCalledOnce()
})
