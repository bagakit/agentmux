import { expect, it, vi } from 'vitest'
import { fixture, core } from './helpers/prepared-resume-fixture.js'
import { pendingResumeCause } from './helpers/resume-cause-fixture.js'

it('preserves the exact typed missing-Run cause through original durable continuity and public inspection', async () => {
  const f = await pendingResumeCause()
  expect(f.saved.continuity).toMatchObject({ operationId: f.request.operationId, previousRun: f.previous.run,
    errorCode: 'AGENT_RESUME_ORIGINAL_RUN_UNCONFIRMED', nativeTarget: f.previous.nativeHandle })
  expect(f.saved.continuity!.error).toContain('missing Run on this Runtime does not authorize replacement')
  expect(f.decoded.session.continuity).toEqual(f.saved.continuity)
  expect(f.decoded.session.run).toEqual(f.previous.run)
  for (const owner of [f, f.reader]) {
    expect(owner.start).not.toHaveBeenCalled(); expect(owner.inputCount()).toBe(0); expect(owner.stop).not.toHaveBeenCalled()
  }
})

it('keeps the typed original unknown Start error without repeating its input', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new core.AgentMuxError('The original private Start reply was lost.', 'CONTROL_UNAVAILABLE'))
  const result = await f.client.ensureAgentContinuity({ ...f.request, trigger: 'manual', expectedRun: f.previous.run,
    policy: { recheckMaxAttempts: 0 } })
  expect(result).toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed' })
  const receipt = (await f.store.readMetadata(f.previous.agentSessionId))!.continuity!
  expect(receipt.errorCode).toBe('AGENT_RESUME_UNCONFIRMED')
  expect(receipt.error).toBeTruthy()
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.inputCount()).toBe(0); expect(f.stop).not.toHaveBeenCalled()
})

it('does not manufacture a typed code for a plain original durable preparation error', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'reserveLifecycle').mockRejectedValueOnce(new Error('Original lifecycle write could not be confirmed.'))
  const result = await f.client.ensureAgentContinuity({ ...f.request, trigger: 'manual', expectedRun: f.previous.run,
    policy: { recheckMaxAttempts: 0 } })
  expect(result).toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed' })
  const receipt = (await f.store.readMetadata(f.previous.agentSessionId))!.continuity!
  expect(receipt.error).toBe('Original lifecycle write could not be confirmed.')
  expect(receipt).not.toHaveProperty('errorCode')
  expect(f.start).not.toHaveBeenCalled(); expect(f.inputCount()).toBe(0)
})
