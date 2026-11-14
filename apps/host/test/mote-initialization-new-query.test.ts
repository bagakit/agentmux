import { afterEach, expect, it, vi } from 'vitest'
import { createMoteConversationStartFixture } from './helpers/mote-conversation-start-fixture.js'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('a new logical Main Query stays on its original input while native startup is unconfirmed; explicit terminal input remains usable', async () => {
  const f = await createMoteConversationStartFixture(); close = f.close
  await f.start('main-before-new-query')
  expect((await f.setup('main-before-new-query')).binding).toBe('confirmed')
  const main = (await f.rpc.call('space.mote.dialogue.read', { target: f.target })).main
  const session = (await f.h.client.readAgentSession(main.current!.sessionId))!
  const input = { agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'new-logical-query-B',
    prompt: 'New Main Query B before native startup', admissionIntent: { kind: 'session-conversation' as const }, execution: 'immediate' as const }
  const submitted = await f.rpc.call('space.mote.dialogue.input.submit', { target: f.target, expectedRoleRevision: main.roleRevision!, input })
  const key = submitted.route!.key
  expect(key).toMatchObject({ agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: input.operationId })
  await vi.waitFor(async () => expect((await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: input.operationId })).input?.control.waiting)
    .toMatchObject({ phase: 'session', reason: 'native-session-starting', wake: 'session-restored' }))
  expect(await f.h.client.inspectAgentPromptSubmission(key)).toBeNull()
  expect(f.h.inner.kernel.input).not.toHaveBeenCalled(); expect(f.h.rawInput).not.toHaveBeenCalled()
  // This deterministic channel must expose its actual created Run's cwd,
  // rather than the seed Session's workspace used by the shared Runtime port.
  const open = f.h.inner.kernel.openInput
  f.h.inner.kernel.openInput = vi.fn(async (runId: string) => ({ ...await open(runId), run: await f.h.inner.kernel.status(runId) }))
  await f.h.client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: 'Explicit terminal action', source: 'user' })
  expect(f.h.rawInput).toHaveBeenCalledTimes(1)
  const retained = await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: input.operationId })
  expect(retained.route!.key).toEqual(key); expect(retained.record).toBeNull()
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})
