import { expect, it } from 'vitest'
import { fixture, request } from '../../../apps/desktop/test/helpers/native-async-question-fixture.js'
import * as core from '../dist/index.js'

it('public Core references preserve the original native question and an accepted answer outside its reading window', async () => {
  const f = await fixture(), context = await f.client.sessionHistoryPage(f.input.agentSessionId, f.invocation)
  const page = { ...context, items: context.items.filter(item => item.questionRequest) }
  const [question] = core.projectConversationQuestions({ agentSessionId: f.input.agentSessionId, executionHostId: 'local', historyPage: page, answerContext: context })
  expect(question!.recordId).toBe(f.input.recordId)
  expect(question!.turnId).toBe(f.input.turnId)
  expect(question!.original).toBe(page.items[0])
  expect(question!.questions[0]!.reference).toEqual({ agentSessionId: f.input.agentSessionId, executionHostId: 'local',
    source: f.input.source, recordId: f.input.recordId, turnId: f.input.turnId, questionId: request.questions[0]!.id })
  expect(question!.questions[0]!.answer).toMatchObject({ hostId: context.sourceHostId, source: f.input.source, recordId: 'exact-answer-record', turnId: 'answer-turn',
    questionId: request.questions[0]!.id, answer: 'Keep original' })
  expect(question!.questions[0]!.answer!.original).toBe(context.items.find(item => item.id === 'exact-answer-record'))
  expect(question!.questions[1]!.answer).toBeUndefined()
  expect(question).not.toHaveProperty('pending')
  const unknown = core.projectConversationQuestions({ agentSessionId: f.input.agentSessionId, historyPage: page })[0]!
  expect(unknown.recordedAnswers.size).toBe(0)
  expect(unknown.questions[0]!.answer).toBeUndefined()
})

it.each(['host', 'unknown-host', 'session', 'provider', 'native'] as const)('does not import %s answer facts into the original question', async field => {
  const f = await fixture(), context = await f.client.sessionHistoryPage(f.input.agentSessionId, f.invocation)
  const page = { ...context, items: context.items.filter(item => item.questionRequest) }
  const { sourceHostId: _missingHost, ...unknownContext } = context
  const foreign = { ...(field === 'unknown-host' ? unknownContext : context), ...(field === 'host' ? { sourceHostId: 'foreign-host' } : {}), ...(field === 'session' ? { agentSessionId: 'foreign-session' } : {}), source: {
    ...context.source, ...(field === 'provider' ? { providerId: 'foreign-provider' } : field === 'native' ? { nativeSessionId: 'foreign-native' } : {}) } }
  const record = core.projectConversationQuestions({ agentSessionId: f.input.agentSessionId, historyPage: page, answerContext: foreign })[0]!
  expect(record.recordedAnswers.size).toBe(0)
  expect(record.questions.every(question => question.answer === undefined)).toBe(true)
  expect(core.projectConversationQuestions({ agentSessionId: 'foreign-session', historyPage: page })).toEqual([])
})

it('pure projection preserves typed question data without granting an activity record a speech identity', async () => {
  const f = await fixture('unanswered'), original = await f.client.sessionHistoryPage(f.input.agentSessionId, f.invocation)
  // This exercises the typed projection boundary, not native reader or input qualification.
  const item = { ...original.items.find(item => item.questionRequest)!, kind: 'activity' as const }
  const page = { ...original, items: [item] }
  const [question] = core.projectConversationQuestions({ agentSessionId: f.input.agentSessionId, historyPage: page })
  expect(question!.request).toBe(item.questionRequest)
  expect(question!.original).toBe(item)
  expect(question!.questions[0]!.reference.recordId).toBe(item.id)
  const [record] = core.projectConversationRecords({ agentSessionId: f.input.agentSessionId, historyPage: page })
  expect(record!.kind).toBe('activity')
  expect(record!.author).toEqual({ kind: 'unknown' })
})
