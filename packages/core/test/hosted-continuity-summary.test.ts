import { appendFileSync } from 'node:fs'
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { decodeHostedValue } from '../src/hosted-value.js'
import { hostedAgentSessionSummary, projectHostedSessionEvent } from '../src/hosted-session-summary.js'
import { continuitySession, hostedContinuityFixture } from './helpers/hosted-continuity.js'
import type { AgentMuxHostedAgentSessionSummary } from '../src/hosted-session-summary.js'
import type { AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentMuxHostedBootstrap } from '../src/hosted-client-contract.js'

afterEach(() => vi.restoreAllMocks())
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

it('locates and updates the original Hosted Session without scanning its directory', async () => {
  const originals = Array.from({ length: 64 }, (_, index) => {
    const { continuityOperations: _history, promptCompletionAdmission: _admission, ...session } = continuitySession('directory-item-' + index)
    return session
  })
  const f = await hostedContinuityFixture(originals)
  try {
    const client = await f.connect('summary')
    const last = originals.at(-1)!
    const find = vi.spyOn(Array.prototype, 'find')
    const findIndex = vi.spyOn(Array.prototype, 'findIndex')
    let targetDirectoryScans: unknown[]
    try {
      const copied = client.agentSession(last.agentSessionId)
      expect(copied.run).toEqual(last.run)
      expect(copied.run).not.toBe(last.run)
      await f.update({ ...last, updatedAt: last.updatedAt + 1 })
      await vi.waitFor(() => expect(client.agentSession(last.agentSessionId).updatedAt).toBe(last.updatedAt + 1))
      targetDirectoryScans = [...find.mock.contexts, ...findIndex.mock.contexts].filter(context =>
        Array.isArray(context) && context.length === originals.length &&
        context[0]?.sessionProjection === 'summary' && context[0]?.agentSessionId === originals[0]!.agentSessionId)
    } finally {
      find.mockRestore()
      findIndex.mockRestore()
    }
    expect(targetDirectoryScans).toHaveLength(0)
    expect(client.agentSessions().map(session => session.agentSessionId)).toEqual(originals.map(session => session.agentSessionId))
  } finally { await f.dispose() }
})

it('shrinks historical continuity ledgers in actual bootstrap while retaining current continuity', async () => {
  const originals = Array.from({ length: 16 }, (_, index) => continuitySession('continuity-' + index)), f = await hostedContinuityFixture(originals)
  const fence = { runtimeId: f.owner.runtimeId, ownerInstanceId: f.owner.ownerInstanceId }
  try {
    const fullWire = await f.service.call('runtime.bootstrap', { consumerId: 'full-reader', fence })
    const summaryWire = await f.service.call('runtime.bootstrap', { consumerId: 'summary-reader', fence, sessions: 'summary' })
    const full = decodeHostedValue(fullWire) as AgentMuxHostedBootstrap, summary = decodeHostedValue(summaryWire) as AgentMuxHostedBootstrap<'summary'>
    const withHistoricalLedger = { ...summary, sessions: summary.sessions.map((value, index) => ({ ...value, continuityOperations: full.sessions[index]!.continuityOperations })) }
    const measurement = { controlledFixture: true, sessions: 16, historicalOperations: 16 * 12,
      fullBytes: bytes(fullWire), previousSummaryBytes: bytes(withHistoricalLedger), summaryBytes: bytes(summaryWire) }
    if (process.env.HOSTED_SUMMARY_MEASUREMENTS) appendFileSync(process.env.HOSTED_SUMMARY_MEASUREMENTS, JSON.stringify(measurement) + '\n')
    expect(summary.sessions.every(value => !Object.hasOwn(value, 'continuityOperations'))).toBe(true)
    expect(measurement.summaryBytes / measurement.previousSummaryBytes).toBeLessThan(.2)
    for (let index = 0; index < originals.length; index++) {
      const original = originals[index]!, small = summary.sessions[index]!, complete = full.sessions[index]!
      expect(small.continuity).toEqual(original.continuity)
      expect(small.run).toEqual(original.run); expect(small.agentSessionId).toBe(original.agentSessionId)
      expect(agentPromptCondition(small)).toEqual(agentPromptCondition(complete))
      expect(complete.continuityOperations).toEqual(original.continuityOperations)
      expect(complete.promptCompletionAdmission!.intent!.prompt).toBe(original.promptCompletionAdmission!.intent!.prompt)
    }
    expect(f.ensure).not.toHaveBeenCalled()
  } finally { await f.dispose() }
})

it('sanitizes already-summary history without mutating the source or current continuity', () => {
  expectTypeOf<AgentMuxHostedAgentSessionSummary['continuityOperations']>().toEqualTypeOf<undefined>()
  expectTypeOf<AgentMuxHostedAgentSessionSummary['continuity']>().toEqualTypeOf<AgentMuxAgentSession['continuity']>()
  const full = continuitySession(), clean = hostedAgentSessionSummary(full)
  const previousSummary = { ...clean, continuityOperations: full.continuityOperations! }
  const before = structuredClone(previousSummary), projected = hostedAgentSessionSummary(previousSummary)
  expect(Object.hasOwn(projected, 'continuityOperations')).toBe(false)
  expect(projected.continuity).toEqual(full.continuity)
  expect(hostedAgentSessionSummary(projected)).toEqual(projected)
  const event = projectHostedSessionEvent({ type: 'agent-session', session: previousSummary }, 'summary')
  expect(event.type === 'agent-session' && Object.hasOwn(event.session, 'continuityOperations')).toBe(false)
  expect(previousSummary).toEqual(before)
  expect(projectHostedSessionEvent({ type: 'agent-session', session: full }, 'full')).toEqual({ type: 'agent-session', session: full })
})

it('keeps summary events and caches bounded while full, exact read, inspection and disk retain original operations', async () => {
  const original = continuitySession(), f = await hostedContinuityFixture([original])
  try {
    const full = await f.connect('full'), summary = await f.connect('summary')
    const events: AgentMuxClientEvent[] = []; summary.onEvent(event => { if (event.type === 'agent-session') events.push(structuredClone(event)) })
    expect(full.agentSession(original.agentSessionId).continuityOperations).toEqual(original.continuityOperations)
    expect(Object.hasOwn(summary.agentSession(original.agentSessionId), 'continuityOperations')).toBe(false)
    const next = continuitySession(original.agentSessionId, 13); next.updatedAt = 3
    await f.update(next)
    await vi.waitFor(() => expect(summary.agentSession(original.agentSessionId).updatedAt).toBe(3))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'agent-session', session: { continuity: next.continuity } })
    expect(events[0]!.type === 'agent-session' && Object.hasOwn(events[0]!.session, 'continuityOperations')).toBe(false)
    expect(full.agentSession(original.agentSessionId).continuityOperations).toEqual(next.continuityOperations)
    const exact = await summary.readAgentSession(original.agentSessionId)
    const inspected = await summary.forwardRpc!('agent.inspect', { target: { kind: 'agent-session', agentSessionId: original.agentSessionId } })
    expect(exact!.continuityOperations).toEqual(next.continuityOperations)
    expect(inspected.session.continuityOperations).toEqual(next.continuityOperations)
    expect(Object.hasOwn(summary.agentSession(original.agentSessionId), 'continuityOperations')).toBe(false)
    expect(summary.agentSession(original.agentSessionId).continuity).toEqual(next.continuity)
    expect(events).toHaveLength(1)
    const onDisk = (await f.store.load()) as AgentMuxStoredAgentSession[]
    expect(onDisk[0]!.continuityOperations).toEqual(next.continuityOperations)
    expect(onDisk[0]!.promptCompletionAdmission!.intent).toEqual(next.promptCompletionAdmission!.intent)
    expect(f.ensure).not.toHaveBeenCalled()
  } finally { await f.dispose() }
})
