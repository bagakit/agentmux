import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { createNativeInputCorrelation, nativeInputSourceId } from '../src/native-input-correlation.js'
import { parsePromptSubmissionRecord } from '../src/prompt-submission-record.js'
import { promptNativeResult, queuedPromptNativeResult } from '../src/prompt-native-result.js'
import type { AgentMuxStoredAgentSession, AgentSessionHistoryItem } from '../src/types.js'

function fixture(queue: boolean) {
  const source = { providerId: 'codex', nativeSessionId: 'original-native' }, run = { runId: 'original-run' }
  const key = { kind: 'prompt' as const, agentSessionId: 'original-session', expectedRun: run, submissionId: 'original-input' }
  const plan = { kind: 'native-rpc' as const, protocolId: 'original-protocol', actorId: 'original-actor',
    sourceId: nativeInputSourceId(source), threadId: source.nativeSessionId,
    operation: queue ? 'queue-idle' as const : 'start-or-steer' as const, clientCorrelation: createNativeInputCorrelation(key) }
  const nativeHandle = { kind: 'provider' as const, providerId: source.providerId, sessionId: source.nativeSessionId }
  const record = parsePromptSubmissionRecord({ agentSessionId: key.agentSessionId, run,
    nativeSource: { nativeHandle, actorId: plan.actorId }, admission: {
      submissionId: key.submissionId, operationId: key.submissionId, inputKey: key, acknowledged: true,
      intent: { run, ownerInstanceId: 'original-runtime', prompt: 'Original input', message: { userContent: 'Original input' }, plan },
      transport: 'native', native: { plan, outcome: 'admitted', ...(queue ? { queuedSubmissionId: 'original-queued' } : { turnId: 'original-turn' }) }
    } })
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: key.agentSessionId, executorId: 'codex', hostId: 'local',
    hookBindingId: 'fixture-hook', hookToken: 'fixture-token',
    workspacePath: fileURLToPath(new URL('.', import.meta.url)), retiredRuns: [], createdAt: 0, updatedAt: 0,
    providerId: source.providerId, run, nativeHandle,
    nativeTurnEnds: { providerId: source.providerId, run, nativeHandle,
      turns: { 'original-turn': { endReason: 'completed', recordId: 'original-end', observedAt: 100 } } }
  }
  const items: AgentSessionHistoryItem[] = [{ id: 'original-user', kind: 'user-message', turnId: 'original-turn',
    contentParts: [{ kind: 'text', text: 'Original input' }], conversation: {
      nativeInput: { source, semanticItemId: 'original-user', clientCorrelation: plan.clientCorrelation, turnId: 'original-turn' },
      adoptedInput: { key }
    } }, { id: 'original-end', kind: 'activity', turnId: 'original-turn', contentParts: [], turnOutcome: { status: 'completed' } }]
  return { record, source, session, items, key }
}

it('bundles the native-result protocol leaf for a browser without Node modules or shims', async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/prompt-native-result.ts', import.meta.url))],
    bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent' })
  expect(result.outputFiles?.[0]?.text).toContain('queuedPromptNativeResult')
  expect(Object.values(result.metafile!.outputs).flatMap(output => output.imports)).toEqual([])
  expect(Object.keys(result.metafile!.inputs).some(input => input.startsWith('node:'))).toBe(false)
})

it.each([false, true])('retains the normalized original native result for queue=%s', queue => {
  const h = fixture(queue)
  expect(queue ? queuedPromptNativeResult(h.record, h.source, h.items) : promptNativeResult(h.record, h.session))
    .toMatchObject({ state: 'completed', nativeTurnId: 'original-turn', promptSubmissionId: 'original-input' })
})

it.each(['key', 'plan'] as const)('a direct result refuses a different original %s', field => {
  const h = fixture(false), admission = h.record.admission!
  if (admission.transport !== 'native') throw Error('Expected original native fixture')
  if (field === 'key') admission.native.plan = { ...admission.native.plan, clientCorrelation: createNativeInputCorrelation({ ...h.key, submissionId: 'other-input' }) }
  else admission.intent!.plan = { ...admission.native.plan, protocolId: 'other-protocol' }
  expect(promptNativeResult(h.record, h.session).state).toBe('unknown')
})

it.each(['key', 'plan', 'source', 'adopted-key'] as const)('a queued result refuses a different original %s', field => {
  const h = fixture(true), admission = h.record.admission!
  if (admission.transport !== 'native') throw Error('Expected original native fixture')
  if (field === 'key') admission.native.plan = { ...admission.native.plan, clientCorrelation: createNativeInputCorrelation({ ...h.key, submissionId: 'other-input' }) }
  else if (field === 'plan') admission.intent!.plan = { ...admission.native.plan, actorId: 'other-actor' }
  else if (field === 'source') h.items[0]!.conversation!.nativeInput!.source = { ...h.source, providerId: 'other-provider' }
  else h.items[0]!.conversation!.adoptedInput!.key = { ...h.key, expectedRun: { runId: 'other-run' } }
  expect(queuedPromptNativeResult(h.record, h.source, h.items)).toBeUndefined()
})
