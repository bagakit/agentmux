import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession, NativeHookEnvelope } from '../src/types.js'
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const native = (sequence: number, extra: Record<string, unknown> = {}) => ({
  session_id: 'native-main', sourceId: 'original-source', sequence, turnId: 'original-turn', ...extra
})
const tool = { session_id: 'native-main', tool_name: 'Bash', tool_use_id: 'new-main-tool', tool_input: { command: 'true' } }
async function harness(name: string) {
  const h = await activityCertaintyClient(name, 'claude')
  closes.push(h.close)
  const saved = async () => (await h.sessions())[0]!
  const start = () => h.hook('turn.start', 'original-start', native(1))
  const interrupted = () => h.hook('turn.complete', 'original-end', native(2, { reason: 'aborted', isAborted: true }))
  return { ...h, name, saved, start, interrupted }
}
async function coldOwner(h: Awaited<ReturnType<typeof harness>>) {
  await h.client.dispose()
  const store = new AgentMuxFileAgentSessionStore(h.store.path)
  const client = new AgentMuxClient({ store })
  closes.push(() => client.dispose())
  const core = client as unknown as {
    connected: boolean
    registry: { load(host: string): Promise<void> }
    kernel: { isConnected(): boolean; status(id: string): Promise<typeof h.run> }
    acceptHookEvent(event: NativeHookEnvelope, signal: AbortSignal): Promise<void>
  }
  await core.registry.load('local')
  core.connected = true
  core.kernel.isConnected = () => true
  core.kernel.status = async () => h.run
  return { client, saved: async () => (await loadAgentSessions(store))[0]!,
    hook: (eventName: string, receiptId: string, payload: Record<string, unknown>) => core.acceptHookEvent({
      agentSessionId: h.name, providerId: 'claude', runId: h.run.runId, eventName, receiptId,
      payload: { hook_event_name: eventName, ...payload }
    }, AbortSignal.timeout(5_000)) }
}
function expectOriginal(session: AgentMuxStoredAgentSession, name: string) {
  expect(session.agentSessionId).toBe(name)
  expect(session.nativeHandle).toMatchObject({ kind: 'provider', providerId: 'claude', sessionId: 'native-main' })
  expect(session.run.runId).toBe(`certainty-run-${name}`)
}

describe('native recovery evidence through the actual Hook and FileStore owners', () => {
  it.each([false, true])('persists first binding/start and accepts its exact native end after a cold Core owner (main tool=%s)', async withTool => {
    const h = await harness(`recovery-cold-${withTool}`)
    expect((await h.saved()).nativeHandle).toBeUndefined()
    await h.start()
    const first = await h.saved()
    expectOriginal(first, h.name)
    expect(first.recoveryActivity).toMatchObject({ state: 'active', sourceId: 'original-source', sequence: 1,
      nativeTurnId: 'original-turn', hookReceiptId: 'original-start' })
    expect(h.client.agentSession(h.name).currentActivity).toMatchObject({ state: 'active', nativeTurnId: 'original-turn' })
    if (withTool) {
      await h.hook('PreToolUse', 'same-turn-tool', tool)
      expect((await h.saved()).recoveryActivity).toMatchObject({ state: 'active', sourceId: 'original-source', nativeTurnId: 'original-turn' })
    }
    const cold = await coldOwner(h)
    expect(cold.client.agentSession(h.name).currentActivity).toBeUndefined()
    await cold.hook('turn.complete', 'after-restart-end', native(2, { reason: 'aborted', isAborted: true }))
    const after = await cold.saved()
    expectOriginal(after, h.name)
    expect(after.recoveryActivity).toMatchObject({ state: 'idle', interruption: 'interrupted', sequence: 2,
      nativeTurnId: 'original-turn', hookReceiptId: 'after-restart-end' })
    const status = await cold.client.statusAgent(h.name)
    expect(status.run.state).toBe('running')
    expect(status.session.currentActivity).toMatchObject({ state: 'idle', interruption: 'interrupted', nativeTurnId: 'original-turn' })
  })

  it.each(['UserPromptSubmit', 'PreToolUse', 'SessionStart', 'identity-unavailable', 'delivery-gap', 'source-conflict'])
  ('does not retain a previous native interruption after %s, including after reopening its FileStore', async kind => {
    const h = await harness(`recovery-invalid-${kind}`)
    await h.start(); await h.interrupted()
    expect((await h.saved()).recoveryActivity).toMatchObject({ state: 'idle', interruption: 'interrupted' })
    const receiptId = 'new-authoritative-boundary'
    if (kind === 'UserPromptSubmit') await h.hook(kind, receiptId, { session_id: 'native-main', prompt: 'A new original user request.' })
    else if (kind === 'PreToolUse') await h.hook(kind, receiptId, tool)
    else if (kind === 'SessionStart') await h.hook(kind, receiptId, { session_id: 'native-main', source: 'resume' })
    else if (kind === 'identity-unavailable') await h.hook('AgentMuxActivityUnavailable', receiptId, {
      sourceId: 'identity-unavailable-source', sequence: 3, reason: 'source-identity-unavailable' })
    else if (kind === 'delivery-gap') await h.hook('AgentMuxActivityUnavailable', receiptId, native(3, { reason: 'delivery-gap' }))
    else await h.hook('turn.start', receiptId, native(3, { sourceId: 'changed-source', turnId: 'changed-turn' }))
    const saved = await h.saved()
    expectOriginal(saved, h.name)
    expect(saved.recoveryActivity).toMatchObject({ state: 'unknown', hookReceiptId: receiptId })
    expect(saved.recoveryActivity).not.toHaveProperty('interruption')
    const cold = await coldOwner(h)
    expect((await cold.saved()).recoveryActivity).toEqual(saved.recoveryActivity)
    expect((await cold.client.statusAgent(h.name)).run.state).toBe('running')
  })

  it('replaces a previous ending with the exact new native turn and refuses an old-turn end', async () => {
    const h = await harness('recovery-new-turn')
    await h.start(); await h.interrupted()
    await h.hook('turn.start', 'next-start', native(3, { turnId: 'next-turn' }))
    expect((await h.saved()).recoveryActivity).toMatchObject({ state: 'active', nativeTurnId: 'next-turn', sequence: 3 })
    expect((await h.saved()).recoveryActivity).not.toHaveProperty('interruption')
    await h.hook('turn.complete', 'late-old-end', native(4, { reason: 'aborted', isAborted: true }))
    expect((await h.saved()).recoveryActivity).toMatchObject({ state: 'active', nativeTurnId: 'next-turn', sequence: 3 })
    await h.hook('turn.complete', 'next-end', native(5, { turnId: 'next-turn', reason: 'answer', isAborted: false }))
    expect((await h.saved()).recoveryActivity).toMatchObject({ state: 'idle', interruption: 'not-interrupted', nativeTurnId: 'next-turn', sequence: 5 })
  })
})
