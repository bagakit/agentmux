import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { agentPromptNotApplied } from '../src/agent-prompt-condition.js'
import type { AgentMuxAgentSession, AgentPromptInputPlan } from '../src/types.js'

function original(plan: AgentPromptInputPlan): AgentMuxAgentSession {
  const run = { runId: 'original-run' }
  return { kind: 'agent', agentSessionId: 'original-session', providerId: 'codex', executorId: 'local', hostId: 'local',
    workspacePath: fixturePath("private"), run, retiredRuns: [], createdAt: 1, updatedAt: 2,
    promptCompletionAdmission: { submissionId: 'original-operation', operationId: 'original-payload', startByte: 10, endByte: 20,
      notApplied: true, intent: { run, ownerInstanceId: 'original-owner', prompt: 'original', plan } },
    ...(plan.kind === 'render-then-submit' ? { terminalPromptSubmission: { run, submissionId: 'original-operation', promptDigest: 'frozen', outputCursorBytes: 0,
      payload: { operationId: 'original-payload', inputByteRange: { startByte: 10, endByte: 19 }, acknowledged: false },
      submit: { operationId: 'original-submit', inputByteRange: { startByte: 19, endByte: 20 }, acknowledged: false } } } : {}) }
}
const single: AgentPromptInputPlan = { kind: 'single-phase', data: 'original\r' }
const rendered: AgentPromptInputPlan = { kind: 'render-then-submit', payload: 'original', renderedText: 'original', submit: '\r' }
describe('Core original whole-input refusal fact', () => {
  it.each([single, rendered])('projects the original logical operation and Run for $kind', plan => {
    const session = original(plan)
    expect(agentPromptNotApplied(session)).toEqual({ submissionId: 'original-operation', run: { runId: 'original-run' } })
    expect(agentPromptNotApplied({ ...session, run: { runId: 'replacement-run' } })).toBeUndefined()
    session.promptCompletionAdmission!.acknowledged = true
    expect(agentPromptNotApplied(session)).toBeUndefined()
  })
  it('keeps missing original identity and independent redraw refusals unknown', () => {
    const session = original(rendered)
    session.promptCompletionAdmission!.frameRefresh = { operationId: 'redraw', inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: false,
      notApplied: true, outputCursorBytes: 0, resizeRevision: 1, nativeSourceId: 'original-source' }
    expect(agentPromptNotApplied(session)).toBeUndefined()
    delete session.promptCompletionAdmission!.frameRefresh
    delete session.promptCompletionAdmission!.submissionId
    expect(agentPromptNotApplied(session)).toBeUndefined()
  })
  it('never calls an accepted payload with an unapplied submit a whole-operation refusal', () => {
    const session = original(rendered)
    session.terminalPromptSubmission!.payload.acknowledged = true
    session.terminalPromptSubmission!.submit.notApplied = true
    expect(agentPromptNotApplied(session)).toBeUndefined()
    session.promptCompletionAdmission!.notApplied = false
    expect(agentPromptNotApplied(session)).toBeUndefined()
  })
  it('requires exact first-phase identity, range, Run and logical operation for phased input', () => {
    for (const change of [
      (s: AgentMuxAgentSession) => { s.terminalPromptSubmission!.run = { runId: 'foreign-run' } },
      (s: AgentMuxAgentSession) => { s.terminalPromptSubmission!.submissionId = 'another-operation' },
      (s: AgentMuxAgentSession) => { s.promptCompletionAdmission!.operationId = 'original-submit' },
      (s: AgentMuxAgentSession) => { s.promptCompletionAdmission!.startByte = 9 },
      (s: AgentMuxAgentSession) => { s.promptCompletionAdmission!.endByte = 21 },
      (s: AgentMuxAgentSession) => { delete s.terminalPromptSubmission }
    ]) { const session = original(rendered); change(session); expect(agentPromptNotApplied(session)).toBeUndefined() }
  })
  it('does not undo an acknowledged preparation and accepts its original unacknowledged first-phase refusal', () => {
    const session = original(rendered), state = session.terminalPromptSubmission!
    state.prepare = { context: 'interruptible', interrupt: { operationId: 'original-interrupt', inputByteRange: { startByte: 9, endByte: 10 }, acknowledged: false, notApplied: true } }
    session.promptCompletionAdmission!.operationId = 'original-interrupt'; session.promptCompletionAdmission!.startByte = 9
    expect(agentPromptNotApplied(session)?.submissionId).toBe('original-operation')
    state.prepare.interrupt!.acknowledged = true
    expect(agentPromptNotApplied(session)).toBeUndefined()
  })
})
