import { expect, it, vi } from 'vitest'
import { submitQuestionReply, type QuestionReplyAttempt } from '../src/lib/conversation-question-reply.js'

function fixture(phase?: QuestionReplyAttempt['phase']) {
  const original: QuestionReplyAttempt = { phase: 'sending', input: { source: { providerId: 'native', nativeSessionId: 'original-source' },
    recordId: 'original-record', turnId: 'original-turn', expectedRun: { runId: 'original-run' }, afterSubmissionId: 'original-predecessor',
    operationId: 'original-operation', answers: [{ questionId: 'question', answer: 'Original answer' }] } }
  let held = phase ? { ...original, phase } : undefined
  const retain = vi.fn(async (next: QuestionReplyAttempt, expected: QuestionReplyAttempt | undefined) => { expect(held).toBe(expected); held = next })
  const submit = vi.fn(async (input: QuestionReplyAttempt['input']) => ({ agentSessionId: 'session', source: input.source,
    recordId: input.recordId, operationId: input.operationId, questionIds: input.answers.map(answer => answer.questionId), outcome: 'submitted' as const }))
  const create = vi.fn(() => structuredClone(original))
  return { original, get: () => held, create, retain, submit, send: () => submitQuestionReply({ sessionId: 'session', get: () => held, create, retain, submit }) }
}
it('retains the exact original before dispatch and distinguishes submitted from a recorded answer', async () => {
  const f = fixture()
  f.submit.mockImplementationOnce(async input => {
    expect(f.get()).toMatchObject({ phase: 'sending', input })
    return { agentSessionId: 'session', source: input.source, recordId: input.recordId, operationId: input.operationId,
      questionIds: ['question'], outcome: 'submitted' }
  })
  await f.send()
  expect(f.get()).toMatchObject({ phase: 'submitted', input: f.original.input })
  expect(f.submit).toHaveBeenCalledOnce()
})
it('rejoins unknown with the original operation and answers without building a new intent', async () => {
  const f = fixture('unknown')
  f.create.mockImplementation(() => { throw Error('A new draft cannot replace unknown') })
  await f.send()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(f.original.input)
})
it('does not dispatch when saving the original intent fails and preserves the answer for explicit recovery', async () => {
  const f = fixture()
  f.retain.mockImplementationOnce(async () => { throw Error('Save unavailable') })
  await expect(f.send()).rejects.toThrow('Save unavailable')
  expect(f.submit).not.toHaveBeenCalled()
})
it('preserves an unknown original after dispatch failure or a mismatched operation receipt', async () => {
  const f = fixture()
  f.submit.mockImplementationOnce(async input => ({ agentSessionId: 'session', source: input.source, recordId: input.recordId,
    operationId: 'foreign-operation', questionIds: ['question'], outcome: 'submitted' }))
  await expect(f.send()).rejects.toThrow('does not match')
  expect(f.get()).toMatchObject({ phase: 'unknown', input: f.original.input })
  f.submit.mockRejectedValueOnce(Error('Receipt unavailable'))
  await expect(f.send()).rejects.toThrow('Receipt unavailable')
  expect(f.get()).toMatchObject({ phase: 'unknown', input: f.original.input })
  expect(f.create).toHaveBeenCalledOnce()
})
it('a concurrent click cannot create a second reply while the original save is in flight', async () => {
  const f = fixture()
  const first = f.send(), second = f.send()
  await Promise.all([first, second])
  expect(f.create).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce()
})
