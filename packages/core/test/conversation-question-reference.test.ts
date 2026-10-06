import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { fixture, request } from '../../../apps/desktop/test/helpers/native-async-question-fixture.js'
import * as core from '../dist/index.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

it('public Core references preserve the original native question and an accepted answer outside its reading window', async () => {
  const f = await fixture(), context = await f.client.sessionHistoryPage(f.input.agentSessionId, f.invocation)
  const page = { ...context, items: context.items.filter(item => item.questionRequest) }
  const [question] = core.projectConversationQuestions({ agentSessionId: f.input.agentSessionId, executionHostId: 'local', historyPage: page, answerContext: context })
  expect(question!.recordId).toBe(f.input.recordId)
  expect(question!.turnId).toBe(f.input.turnId)
  expect(question!.original).toBe(page.items[0])
  expect(question!.questions[0]!.reference).toEqual({ agentSessionId: f.input.agentSessionId, executionHostId: 'local',
    source: f.input.source, recordId: f.input.recordId, turnId: f.input.turnId, questionId: request.questions[0]!.id })
  expect(question!.questions[0]!.answer).toMatchObject({ source: f.input.source, recordId: 'exact-answer-record', turnId: 'answer-turn',
    questionId: request.questions[0]!.id, answer: 'Keep original' })
  expect(question!.questions[0]!.answer!.original).toBe(context.items.find(item => item.id === 'exact-answer-record'))
  expect(question!.questions[1]!.answer).toBeUndefined()
  expect(question).not.toHaveProperty('pending')
  const unknown = core.projectConversationQuestions({ agentSessionId: f.input.agentSessionId, historyPage: page })[0]!
  expect(unknown.recordedAnswers.size).toBe(0)
  expect(unknown.questions[0]!.answer).toBeUndefined()
})

it.each(['session', 'provider', 'native'] as const)('does not import %s answer facts into the original question', async field => {
  const f = await fixture(), context = await f.client.sessionHistoryPage(f.input.agentSessionId, f.invocation)
  const page = { ...context, items: context.items.filter(item => item.questionRequest) }
  const foreign = { ...context, ...(field === 'session' ? { agentSessionId: 'foreign-session' } : {}), source: {
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
  expect(record!.author).toBeUndefined()
})

it('submission receipts remain independent of native answers and bind the original operation', async () => {
  const f = await fixture('unanswered'), page = await f.client.sessionHistoryPage(f.input.agentSessionId, f.invocation)
  const receipt = await f.client.replySessionQuestion(f.input)
  expect(core.questionReplyReceiptMatches(f.input.agentSessionId, f.input, receipt)).toBe(true)
  expect(core.questionReplyReceiptMatches(f.input.agentSessionId, f.input, { ...receipt, operationId: 'another-operation' })).toBe(false)
  expect(core.recordedQuestionAnswerFacts(page).size).toBe(0)
  expect(core.projectConversationQuestions({ agentSessionId: f.input.agentSessionId, historyPage: page })[0]!.questions.every(question => !question.answer)).toBe(true)
})

it('the compiled original CLI rejoins an exact question reply once while asynchronous input remains allowed', async () => {
  const f = await fixture('unanswered'), condition = await f.beginWorking()
  const { commandOverride: _command, args: _args, authorHuman: _human, sourceDevice: _device, ...original } = f.input
  const input = { ...original, ...condition }
  const submit = vi.spyOn(f.client, 'replySessionQuestion').mockImplementation(actual =>
    core.AgentMuxClient.prototype.replySessionQuestion.call(f.client, { ...actual, ...f.invocation }))
  const server = new core.AgentMuxControlServer({ socketPath: join(f.directory, 'control.sock'),
    coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start()
  try {
    const before = f.writes.length
    const run = () => runCompiledObjectCli(['agent', 'question', 'reply', '--input', '-'], objectCliEnvironment(f.directory), JSON.stringify(input))
    const first = await run()
    expect(first.code, first.stderr).toBe(0)
    expect(core.questionReplyReceiptMatches(input.agentSessionId, input, JSON.parse(first.stdout).result)).toBe(true)
    const written = f.writes.length
    expect(written).toBeGreaterThan(before)
    const repeated = await run()
    expect(repeated.code, repeated.stderr).toBe(0)
    expect(JSON.parse(repeated.stdout).result).toEqual(JSON.parse(first.stdout).result)
    expect(f.writes.length).toBe(written)
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls.every(([actual]) => actual.operationId === input.operationId && actual.recordId === input.recordId && actual.sourceChannel === 'cli')).toBe(true)
    expect(f.client.agentSession(input.agentSessionId).pendingInteraction).toBeUndefined()
  } finally { await server.stop() }
})
