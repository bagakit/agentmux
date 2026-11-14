import { describe, expect, it } from 'vitest'
import { copySourceComposerInputs, pruneSourceComposerInputs, sourceInputRecoveryRows } from '../src/renderer/src/lib/source-composer-handoff'
import { originalSourceInputOwnerKey } from '../src/renderer/src/lib/original-space-navigation'
import { spaceMountKey } from '../src/shared/space-mount'
import type { AgentSteerQueueEntry } from '../src/renderer/src/store'
import { promptCarrierWaiting } from './helpers/prompt-carrier-receipt'

const target = { hostId: 'source-carrier', target: { reference: { runtimeId: 'source-runtime', spaceId: 'original-space' },
  regionId: 'original-region', runtimeId: 'execution-runtime', agentSessionId: 'original-agent', expectedRun: { runId: 'original-run' },
  expectedAdmission: { kind: 'creation' as const, operationId: 'original-create' } } }
const key = spaceMountKey(target.target.reference), owner = originalSourceInputOwnerKey(target.target.runtimeId, target.target.agentSessionId)
const bucket = JSON.stringify([target.hostId, target.target.reference.runtimeId, target.target.reference.spaceId,
  target.target.regionId, target.target.runtimeId, target.target.agentSessionId])
function fixture() {
  const original = { target, request: { operationId: 'original-operation', prompt: '  exact original 中 \n',
    binding: { expectedRun: target.target.expectedRun, admissionIntent: { kind: 'manual-actor' as const } } }, submitted: true,
    response: promptCarrierWaiting(target.target.agentSessionId, target.target.expectedRun.runId, 'original-operation') }
  return { original, state: { mountedSpaceInputs: { [key]: { target: { hostId: target.hostId, reference: target.target.reference,
    zoneId: 'original-zone', workspaceId: 'original-workspace' }, drafts: { [JSON.stringify(['source-runtime', 'original-space', 'tab', 'original-region'])]: 'Old draft' },
    memberInputs: { [bucket]: { 'original-operation': original } } } }, agentSteerQueues: {} as Record<string, AgentSteerQueueEntry[]> } }
}
describe('original Source input handoff', () => {
  it.each(['opaque original document', ['original', 'bytes'], null])('keeps an unreadable root available as original data', raw => {
    expect(sourceInputRecoveryRows(raw, target)).toEqual([{ path: [], raw, issue: expect.any(String) }])
  })
  it('copies the exact request and receipt once, with no new control, time or input authority', () => {
    const { state, original } = fixture(), rows = sourceInputRecoveryRows(state.mountedSpaceInputs, target, 'tab')
    const next = { ...state, ...copySourceComposerInputs(state, rows) }
    expect(next.agentSteerQueues[owner]).toEqual([expect.objectContaining({ operationId: original.request.operationId,
      text: original.request.prompt, directInputBinding: original.request.binding, originalMember: target,
      inputReceipt: original.response, inputIntakeStarted: true, awaitingExplicitSend: true, recoveredSourceInput: original })])
    expect(next.agentSteerQueues[owner]![0]).not.toHaveProperty('directInputControl')
    expect(next.agentSteerQueues[owner]![0]).not.toHaveProperty('freshComposerIntent')
    expect(next.agentSteerQueues[owner]![0]).not.toHaveProperty('enqueuedAt')
    expect(next.mountedSpaceInputs).toBe(state.mountedSpaceInputs)
    expect(copySourceComposerInputs(next, rows)).toEqual({})
    const cleaned = { ...next, ...pruneSourceComposerInputs(next, rows) } as typeof state
    expect(cleaned.mountedSpaceInputs[key]).not.toHaveProperty('memberInputs')
    expect(cleaned.mountedSpaceInputs[key]!.drafts).toEqual(state.mountedSpaceInputs[key]!.drafts)
  })
  it('never assigns a position-only draft to the current Agent, including an explicitly cleared draft', () => {
    const { state } = fixture(), rows = sourceInputRecoveryRows(state.mountedSpaceInputs, target, 'tab')
    expect(rows.find(row => row.text === 'Old draft')!.input).toBeUndefined()
    expect(copySourceComposerInputs({ ...state, agentComposerDrafts: { [owner]: '' } } as typeof state, rows)).not.toHaveProperty('agentComposerDrafts')
  })
  it.each(['missing-admission', 'wrong-receipt', 'conditional-binding', 'wrong-bucket'])('keeps %s bytes visible without changing a valid neighbor', reason => {
    const { state, original } = fixture(), bad = structuredClone(original) as any
    bad.request.operationId = 'bad-operation'; bad.response = promptCarrierWaiting(target.target.agentSessionId, target.target.expectedRun.runId, 'bad-operation')
    if (reason === 'missing-admission') delete bad.target.target.expectedAdmission
    if (reason === 'wrong-receipt') bad.response.key.submissionId = 'unrelated-operation'
    if (reason === 'conditional-binding') bad.request.binding = { expectedRun: target.target.expectedRun, afterSubmissionId: null }
    const requests = state.mountedSpaceInputs[key]!.memberInputs as Record<string, Record<string, unknown>>
    if (reason === 'wrong-bucket') requests.unrelated = { 'bad-operation': bad }
    else requests[bucket]!['bad-operation'] = bad
    const rows = sourceInputRecoveryRows(state.mountedSpaceInputs, target, 'tab'), next = { ...state, ...copySourceComposerInputs(state, rows) }
    expect(next.agentSteerQueues[owner]).toHaveLength(1)
    const cleaned = { ...next, ...pruneSourceComposerInputs(next, rows) }
    expect(sourceInputRecoveryRows(cleaned.mountedSpaceInputs, target, 'tab').find(row => JSON.stringify(row.raw) === JSON.stringify(bad))!.input).toBeUndefined()
  })
  it('does not overwrite an operation with another body or prune input changed during its save', () => {
    const { state } = fixture(), rows = sourceInputRecoveryRows(state.mountedSpaceInputs, target, 'tab')
    const next = { ...state, ...copySourceComposerInputs(state, rows) }, saved = next.agentSteerQueues[owner]![0]!
    next.agentSteerQueues = { [owner]: [{ ...saved, text: 'A different original body' }] }
    expect(copySourceComposerInputs(next, rows)).toEqual({})
    expect(pruneSourceComposerInputs(next, rows)).toEqual({})
    next.agentSteerQueues = { [owner]: [saved] }
    const changed = structuredClone(next) as typeof state
    changed.mountedSpaceInputs[key]!.memberInputs[bucket]!['original-operation']!.request.prompt = 'Later saved input'
    expect(pruneSourceComposerInputs(changed, rows)).toEqual({})
  })
  it('retains an earlier Run and unknown submitted input without binding it to the current Run', () => {
    const { state, original } = fixture()
    delete (original as Partial<typeof original>).response
    const current = { ...target, target: { ...target.target, expectedRun: { runId: 'successor-run' } } }
    const rows = sourceInputRecoveryRows(state.mountedSpaceInputs, current, 'tab'), next = { ...state, ...copySourceComposerInputs(state, rows) }
    expect(next.agentSteerQueues[owner]![0]).toMatchObject({ runId: 'original-run', originalMember: target, inputIntakeStarted: true, awaitingExplicitSend: true })
    expect(next.agentSteerQueues[owner]![0]).not.toHaveProperty('inputReceipt')
  })
  it('merges original intake and receipt facts into an existing same-intent entry before pruning', () => {
    const { state, original } = fixture(), rows = sourceInputRecoveryRows(state.mountedSpaceInputs, target, 'tab')
    const candidate = copySourceComposerInputs(state, rows).agentSteerQueues![owner]![0]!
    const { inputIntakeStarted: _intake, inputReceipt: _receipt, recoveredSourceInput: _raw, awaitingExplicitSend: _paused, ...unsubmitted } = candidate
    state.agentSteerQueues = { [owner]: [unsubmitted] }
    const next = { ...state, ...copySourceComposerInputs(state, rows) }
    expect(next.agentSteerQueues[owner]![0]).toMatchObject({ inputIntakeStarted: true, inputReceipt: original.response, awaitingExplicitSend: true })
    expect(pruneSourceComposerInputs(next, rows)).toHaveProperty('mountedSpaceInputs')
    expect(pruneSourceComposerInputs({ ...next, agentSteerQueues: { [owner]: [{ ...unsubmitted, recoveredSourceInput: original }] } }, rows)).toEqual({})
  })
  it('a valid original receipt retains intake even if an old submitted flag says false', () => {
    const { state, original } = fixture(); original.submitted = false
    const next = copySourceComposerInputs(state, sourceInputRecoveryRows(state.mountedSpaceInputs, target, 'tab'))
    expect(next.agentSteerQueues![owner]![0]).toMatchObject({ inputIntakeStarted: true, inputReceipt: original.response })
  })
})
