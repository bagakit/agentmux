import { afterEach, expect, it, vi } from 'vitest'
import { createMoteConversationStartFixture } from './helpers/mote-conversation-start-fixture.js'
import { moteMainBindingInput, spatialAgentOpenRecord } from '../../../packages/core/src/spatial-agent-open-contract.js'
import { moteQuickBaseline } from '../../../packages/core/src/mote-preferences.js'
import { MOTE_INPUT_GUIDANCE } from '../../../packages/core/src/mote/input-source.js'
import { AgentMuxError } from '../../../packages/core/src/errors.js'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs() })

it.each(['acknowledged', 'unknown'] as const)('setup reads an existing %s platform manual route without changing its intent or replaying', async outcome => {
  const f = await createMoteConversationStartFixture({ providerId: 'claude' }); close = f.close
  const operationId = 'original-platform-operation', prompt = 'Original frozen platform Query A'
  await f.start(operationId, prompt)
  const record = spatialAgentOpenRecord((await f.spatial.read())!.graph, operationId)!
  const baseline = moteQuickBaseline(await f.quick.read({ kind: 'quick', target: f.target }))!
  // The ordinary original MOTE writer may finish this exact binding before setup
  // reconciliation; this does not run the new platform input stage.
  const saved = await f.rpc.call('space.mote.preferences.save', moteMainBindingInput(record, baseline))
  expect(saved.status).toBe('saved')
  const main = (await f.rpc.call('space.mote.dialogue.read', { target: f.target })).main
  const session = (await f.h.client.readAgentSession(main.current!.sessionId))!
  const key = { kind: 'prompt' as const, agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: record.moteMain!.deferredInput!.operationId }
  await f.spatial.claimMoteMainInput(operationId, 'deferredInputKey', key)
  const write = f.h.inner.kernel.input, status = f.h.inner.kernel.status
  let uncertain = false
  if (outcome === 'unknown') {
    f.h.inner.kernel.status = vi.fn(async (id: string) => ({ ...await status(id), ...(uncertain ? { acceptedInputBytes: null } : {}) }))
    f.h.inner.kernel.input = vi.fn(async (...args: unknown[]) => {
      await write(...args); uncertain = true
      throw new AgentMuxError('Original platform terminal reply was lost.', 'CTXMUX_DISCONNECTED', undefined, { disposition: 'unknown', confirmedInputBytes: 0 })
    })
  }
  await f.rpc.call('space.mote.dialogue.input.submit', { target: f.target, expectedRoleRevision: main.roleRevision!, input: {
    agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId: key.submissionId, prompt,
    admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' } })
  await f.h.inner.inputWaitingRecipients.get(session.agentSessionId)?.pending
  const before = await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: key.submissionId })
  expect(before.record?.admission?.intent?.admissionIntent?.kind).toBe('manual-actor')
  expect(before.record?.admission?.intent?.message?.systemContext).toContain(MOTE_INPUT_GUIDANCE)
  expect(before.input?.status).toBe(outcome === 'unknown' ? 'unknown' : 'terminal-confirmed')
  const count = f.h.inner.kernel.input.mock.calls.length
  expect(count).toBeGreaterThan(0)
  for (const advance of [false, true]) {
    const reconciled = await f.setup(operationId, advance)
    expect(reconciled.deferredInput?.route).toEqual(before.route)
    expect(reconciled.deferredInput?.record?.admission).toEqual(before.record!.admission)
    expect(reconciled.deferredInput?.input?.key).toEqual(key)
    expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(count)
  }
})
