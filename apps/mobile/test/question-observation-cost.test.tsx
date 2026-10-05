import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import * as draftOwner from '../src/conversation/local-drafts'
import * as replyOwner from '../src/conversation/question-replies'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixture, history, mount, mounted } from './conversation-fixture'

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
  f.setPage({ ...history(), nextCursor: null, items: [{ id: target.recordId, turnId: target.turnId, kind: 'assistant-message', contentParts: [],
    questionRequest: { delivery: 'async', questions: [{ id: 'original-question', prompt: 'Original question', options: [], acceptsText: true }] } }] })
  Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime' }) })
  const metrics: { globalEntries: number; currentLookups: number }[] = []
  const observe = replyOwner.observeMobileQuestionAnswers
  vi.spyOn(replyOwner, 'observeMobileQuestionAnswers').mockImplementation((local, ...args) => {
    const metric = { globalEntries: 0, currentLookups: 0 }, iterator = local.questions[Symbol.iterator], get = local.questions.get
    local.questions[Symbol.iterator] = function* () { for (const entry of iterator.call(this)) { metric.globalEntries++; yield entry } }
    local.questions.get = function (entryKey) { metric.currentLookups++; return get.call(this, entryKey) }
    try { return observe(local, ...args) }
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
