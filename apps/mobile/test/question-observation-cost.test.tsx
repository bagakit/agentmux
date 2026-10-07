import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createLocalDrafts, type ResponseAttempt } from '../src/conversation/local-drafts'
import * as draftOwner from '../src/conversation/local-drafts'
import * as replyOwner from '../src/conversation/question-replies'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixture, history, mount, mounted } from './conversation-fixture'
import { fixtureEpoch as _historyTailFixtureEpoch } from '../../../test/fixture-values.mjs'

const sid = 'session-original', target = { source: history().source, turnId: 'turn-original', recordId: 'question-original' }
const input = { ...target, operationId: 'original-operation', expectedRun: { runId: 'run-original' }, afterSubmissionId: null,
  answers: [{ questionId: 'original-question', answer: 'Original exact answer' }] }
const original = { input, phase: 'unknown' as const, hostId: 'host-original', runtimeId: 'original-runtime' }
const key = questionReplyKey(sid, input)
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  vi.restoreAllMocks()
})

it.each([1, 1000])('the mounted original response list ignores %i foreign Session intents', async foreignCount => {
  const create = draftOwner.createLocalDrafts, metrics = { globalEntries: 0, currentLookups: 0, readingScopes: [] as string[] }
  vi.spyOn(draftOwner, 'createLocalDrafts').mockImplementation((...args) => {
    const local = create(...args)
    const response: ResponseAttempt = { phase: 'unknown', message: 'Original reply remains inspectable', original: {
      hostId: 'host-original', runtimeId: 'original-runtime', input: { agentSessionId: sid, expectedRun: { runId: 'run-original' },
        operationId: 'original-response', expectedRequest: { kind: 'permission', agentSessionId: sid, id: 'original-request', title: 'Original permission',
          evidence: { source: 'native-hook', observedAt: _historyTailFixtureEpoch(0, 0, 1), run: { runId: 'run-original' } }, options: [{ id: 'deny', kind: 'reject-once', label: 'Reject' }] },
        response: { kind: 'permission', requestId: 'original-request', decision: { outcome: 'selected', optionId: 'deny' } } } } }
    local.responses.set(JSON.stringify([sid, 'run-original', 'original-request']), response)
    // Measure retained in-memory routing, independently of the existing durable entry budget.
    for (let index = 0; index < foreignCount; index++) {
      const foreign = structuredClone(response), sessionId = 'foreign-' + index
      foreign.original!.input.agentSessionId = sessionId
      foreign.original!.input.expectedRequest.agentSessionId = sessionId
      local.responses.set(JSON.stringify([sessionId, 'run-original', 'original-request']), foreign)
    }
    const iterator = local.responses[Symbol.iterator], get = local.responses.get, forSession = local.responses.forSession
    local.responses[Symbol.iterator] = function* () { for (const entry of iterator.call(this)) { metrics.globalEntries++; yield entry } }
    local.responses.get = function (entryKey) { metrics.currentLookups++; return get.call(this, entryKey) }
    local.responses.forSession = function* (sessionId) { metrics.readingScopes.push(sessionId); yield* forSession.call(this, sessionId) }
    return local
  })
  const f = fixture(), view = await mount(<MobileConversationSurface client={f.client} agentSessionId={sid}
    connection={{ state: 'connected', message: 'connected' }} platform={createBrowserPlatform()} />)
  expect(view.element.querySelectorAll('[data-original-response]')).toHaveLength(1)
  expect(metrics.readingScopes.length).toBeGreaterThan(0)
  expect(metrics.readingScopes.every(value => value === sid)).toBe(true)
  expect(metrics.globalEntries).toBe(0)
  expect(metrics.currentLookups).toBe(metrics.readingScopes.length)
  expect(f.respond).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
  console.info('RESPONSE_COST_MOBILE ' + JSON.stringify({ foreignCount, retained: foreignCount + 1, metrics }))
})

it.each([1, 1000])('the actual Surface Session event reads only its one original intent with %i foreign Session records', async foreignCount => {
  const seed = createLocalDrafts(); seed.questions.set(key, original)
  await seed.save()
  // Durable storage currently admits at most 256 bucket entries. Probe the related
  // read bound on the real retained in-memory owner, without claiming 1000-entry persistence.
  const create = draftOwner.createLocalDrafts
  vi.spyOn(draftOwner, 'createLocalDrafts').mockImplementation((...args) => {
    const local = create(...args)
    for (let index = 0; index < foreignCount; index++) local.questions.set(questionReplyKey('foreign-' + index, input), original)
    expect(local.questions.size).toBe(foreignCount + 1)
    return local
  })
  const f = fixture()
  const session = f.sessions.get(sid)!
  f.sessions.set(sid, { ...session, promptCompletionAdmission: { operationId: 'unrelated-phase', submissionId: 'unrelated-refused-operation',
    startByte: 0, endByte: 10, notApplied: true, intent: { run: session.run, ownerInstanceId: 'owner', prompt: 'unrelated',
      plan: { kind: 'single-phase', data: 'unrelated' } } } })
  f.setPage({ ...history(), nextCursor: null, items: [{ id: target.recordId, turnId: target.turnId, kind: 'assistant-message', contentParts: [],
    questionRequest: { delivery: 'async', questions: [{ id: 'original-question', prompt: 'Original question', options: [], acceptsText: true }] } }] })
  Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime' }) })
  const metrics: { globalEntries: number; currentLookups: number }[] = []
  const reconcile = replyOwner.reconcileMobileQuestionReplies
  vi.spyOn(replyOwner, 'reconcileMobileQuestionReplies').mockImplementation((local, ...args) => {
    const metric = { globalEntries: 0, currentLookups: 0 }, iterator = local.questions[Symbol.iterator], get = local.questions.get
    local.questions[Symbol.iterator] = function* () { for (const entry of iterator.call(this)) { metric.globalEntries++; yield entry } }
    local.questions.get = function (entryKey) { metric.currentLookups++; return get.call(this, entryKey) }
    try { return reconcile(local, ...args) }
    finally { local.questions[Symbol.iterator] = iterator; local.questions.get = get; metrics.push(metric) }
  })
  await mount(<MobileConversationSurface client={f.client} agentSessionId={sid} connection={{ state: 'connected', message: 'connected' }} platform={createBrowserPlatform()} />)
  await vi.waitFor(() => expect(metrics.length).toBeGreaterThan(0))
  metrics.length = 0
  await act(async () => { const session = { ...f.sessions.get(sid)!, updatedAt: 2 }; f.sessions.set(sid, session); f.emit({ type: 'agent-session', session }) })
  expect(metrics.length).toBeGreaterThan(0)
  expect(metrics).toEqual(metrics.map(() => ({ globalEntries: 0, currentLookups: 1 })))
  console.info('QUESTION_COST_MOBILE ' + JSON.stringify({ foreignCount, retained: foreignCount + 1, metrics }))
  expect(f.submit).not.toHaveBeenCalled()
})

it('keeps the derived Session index accurate through same-key replacement, deletion, clear and new reader restore', async () => {
  const local = createLocalDrafts(), second = questionReplyKey(sid, { ...input, recordId: 'another-original-question' })
  const secondAttempt = { ...original, input: { ...input, recordId: 'another-original-question' } }
  local.questions.set(key, original); local.questions.set(second, secondAttempt)
  local.questions.set(questionReplyKey('foreign', input), original)
  local.questions.set(key, { ...original, phase: 'submitted' })
  expect([...local.questions.forSession(sid)]).toEqual([[key, { ...original, phase: 'submitted' }], [second, secondAttempt]])
  await local.save()
  expect([...createLocalDrafts().questions.forSession(sid)]).toEqual([...local.questions.forSession(sid)])
  expect(local.questions.delete(key)).toBe(true)
  const lookups = vi.spyOn(local.questions, 'get')
  expect([...local.questions.forSession(sid)]).toEqual([[second, secondAttempt]])
  expect(lookups).toHaveBeenCalledTimes(1)
  lookups.mockClear()
  local.questions.clear(); expect([...local.questions.forSession(sid)]).toEqual([])
  expect([...local.questions.forSession('foreign')]).toEqual([])
  expect(lookups).not.toHaveBeenCalled()
})

it('updates the derived index when a successful keyed save adopts another page additions and deletions without replacing the record', async () => {
  let raw: string | null = null
  const aStorage = { getItem: () => raw, setItem: (_: string, value: string) => { raw = value } }
  const bStorage = { getItem: () => raw, setItem: (_: string, value: string) => { raw = value } }
  const a = createLocalDrafts(() => aStorage), b = createLocalDrafts(() => bStorage)
  b.questions.set(key, original); await b.save()
  a.drafts.set('unrelated', 'First retained draft'); await a.save()
  expect([...a.questions.forSession(sid)]).toEqual([[key, original]])
  b.questions.delete(key); await b.save()
  a.drafts.set('unrelated', 'Second retained draft'); await a.save()
  expect([...a.questions.forSession(sid)]).toEqual([])
  expect(a.recordChanged).toBe(false)
  await getDeviceWorkface(() => aStorage).replaceBackup({ ...emptyDeviceWorkface(), conversation: { version: 1, drafts: [], attempts: [], responses: [], questions: [[key, original]] } })
  const restored = createLocalDrafts(() => aStorage)
  expect([...restored.questions.forSession(sid)]).toEqual([[key, original]])
  expect(await a.save()).toBe(false)
  expect([...a.questions.forSession(sid)]).toEqual([])
})
