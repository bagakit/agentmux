import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import type { GoalStartObservation } from '@agentmux/demand'
import * as sourceCodec from '../src/goal-delegation.js'

// A frozen qualification may select its freshly compiled copy of this same owner.
const codec = process.env.AGENTMUX_GOAL_START_CODEC_MODULE
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_GOAL_START_CODEC_MODULE) as typeof sourceCodec
  : sourceCodec

function fixture() {
  const start = {
    operationId: 'original-start', agentSessionId: 'original-worker', hostId: 'original-host',
    runId: 'original-run', execution: 'finite' as const, prompt: ' Original finite task\n with exact bytes. ',
    stage: 'confirmed' as const, preparedAt: reshapeFixtureEpoch(0, 0, 1), submittedAt: reshapeFixtureEpoch(0, 0, 2),
    receipt: { kind: 'core-prompt' as const, itemId: 'prompt:original-start', createdAt: reshapeFixtureEpoch(0, 0, 3) },
    resultBasis: { alignmentRevision: 1, criteria: [{ id: 'AC-01', text: 'Keep original evidence' }], groundingSubmissionId: null }
  }
  const observation: GoalStartObservation = {
    operationId: start.operationId,
    input: { state: 'confirmed', retainedReceipt: { ...start.receipt }, proof: {
      kind: 'core-prompt', agentSessionId: start.agentSessionId, runId: start.runId,
      operationId: start.operationId, acknowledged: true, prompt: start.prompt,
      inputKey: { kind: 'prompt', agentSessionId: start.agentSessionId, expectedRun: { runId: start.runId }, submissionId: start.operationId }
    } },
    originalRun: { runId: start.runId, state: 'running' }, responsibility: 'working'
  }
  return { goalId: 'original-goal', goalUpdatedAt: reshapeFixtureEpoch(0, 0, 4), diskDurability: 'confirmed' as const,
    delegations: [], dispatches: [start], startObservations: [observation] }
}
type Fixture = ReturnType<typeof fixture>
const parse = (value: unknown) => codec.parseGoalDelegationResult(value, { goalId: 'original-goal' })
const proof = (value: Fixture) => value.startObservations[0]!.input.proof!

describe('original finite Start public input provenance', () => {
  it('preserves the exact Core prompt proof, original identities and body without accepting the Goal', () => {
    const original = fixture(), parsed = parse(original)
    expect(parsed.startObservations).toEqual(original.startObservations)
    expect(parsed.dispatches).toEqual(original.dispatches)
    expect(parsed.delegations).toEqual([])
    expect(parsed.grounding).toBeUndefined()
    expect(parsed.startObservations![0]!.input.proof!.prompt).toBe(original.dispatches[0]!.prompt)
  })

  it('rejects a confirmed enum without its actual original Core proof', () => {
    const value = fixture()
    delete value.startObservations[0]!.input.proof
    expect(() => parse(value)).toThrow('Confirmed Start input requires its original Core proof')
  })

  const contradictions: Array<[string, (value: Fixture) => void]> = [
    ['proof Session', value => { proof(value).agentSessionId = 'another-worker' }],
    ['proof Run', value => { proof(value).runId = 'another-run' }],
    ['proof operation', value => { proof(value).operationId = 'another-start' }],
    ['proof ACK', value => { Object.assign(proof(value), { acknowledged: false }) }],
    ['proof body', value => { proof(value).prompt = proof(value).prompt.trim() }],
    ['input-key Session', value => { proof(value).inputKey.agentSessionId = 'another-worker' }],
    ['input-key Run', value => { proof(value).inputKey.expectedRun.runId = 'another-run' }],
    ['input-key operation', value => { proof(value).inputKey.submissionId = 'another-start' }],
    ['proof source kind', value => { Object.assign(proof(value), { kind: 'agent-message' }) }],
    ['input-key source kind', value => { Object.assign(proof(value), { inputKey: {
      kind: 'message', agentSessionId: 'original-worker', expectedRun: { runId: 'original-run' }, messageId: 'original-start'
    } }) }]
  ]
  it.each(contradictions)('rejects a contradictory %s while keeping the original Start frozen', (_label, change) => {
    const value = fixture(), original = structuredClone(value.dispatches)
    change(value)
    expect(() => parse(value)).toThrow('The actual Core input proof is not this original Start')
    expect(value.dispatches).toEqual(original)
  })

  it('refuses additional input authority or a different input-key shape', () => {
    const forged = fixture()
    Object.assign(proof(forged), { authorAgentSessionId: 'original-worker' })
    expect(() => parse(forged)).toThrow()
    const malformed = fixture()
    Object.assign(proof(malformed).inputKey.expectedRun, { anotherRun: 'original-run' })
    expect(() => parse(malformed)).toThrow('original input identity is invalid')
  })

  it('does not retain a confirmed proof under an unknown enum', () => {
    const value = fixture()
    value.startObservations[0]!.input.state = 'unknown'
    expect(() => parse(value)).toThrow('Confirmed Start input requires its original Core proof')
  })

  it('compares original receipt fields independently of JSON key order', () => {
    const value = fixture()
    value.startObservations[0]!.input.retainedReceipt = { createdAt: reshapeFixtureEpoch(0, 0, 3), itemId: 'prompt:original-start', kind: 'core-prompt' }
    expect(JSON.stringify(value.startObservations[0]!.input.retainedReceipt)).not.toBe(JSON.stringify(value.dispatches[0]!.receipt))
    expect(parse(value).startObservations![0]!.input.retainedReceipt).toEqual(value.dispatches[0]!.receipt)
  })

  it.each(['kind', 'itemId', 'createdAt'] as const)('rejects another retained receipt %s', field => {
    const value = fixture()
    Object.assign(value.startObservations[0]!.input.retainedReceipt!, { [field]: field === 'createdAt' ? 99 : 'another-receipt' })
    expect(() => parse(value)).toThrow('retained receipt does not belong to this original Start')
  })

  it('rejects a claimed retained receipt when the original Start has none', () => {
    const value = fixture()
    Object.assign(value.dispatches[0]!, { stage: 'prepared', submittedAt: undefined, receipt: undefined })
    expect(() => parse(value)).toThrow('retained receipt does not belong to this original Start')
  })

  it.each(['unknown input', 'absent Run', 'ended Run'] as const)('rejects working with %s', contradiction => {
    const value = fixture(), observation = value.startObservations[0]!
    if (contradiction === 'unknown input') { observation.input.state = 'unknown'; delete observation.input.proof }
    else if (contradiction === 'absent Run') delete observation.originalRun
    else observation.originalRun!.state = 'exited'
    expect(() => parse(value)).toThrow('Start responsibility contradicts its original facts')
  })

  it('keeps an ended original Run actionable even when original input remains unknown', () => {
    const value = fixture(), observation = value.startObservations[0]!
    observation.input.state = 'unknown'; delete observation.input.proof
    observation.originalRun!.state = 'interrupted'; observation.responsibility = 'original-worker-continuation'
    expect(parse(value).startObservations![0]).toMatchObject({ input: { state: 'unknown' },
      originalRun: { runId: 'original-run', state: 'interrupted' }, responsibility: 'original-worker-continuation' })
  })

  it('rejects an observed replacement Run and a continuation claim for a healthy Run', () => {
    const replacement = fixture()
    replacement.startObservations[0]!.originalRun!.runId = 'replacement-run'
    expect(() => parse(replacement)).toThrow('observed Run is not this original Start')
    const running = fixture()
    running.startObservations[0]!.responsibility = 'original-worker-continuation'
    expect(() => parse(running)).toThrow('Start responsibility contradicts its original facts')
  })

  it('rejects duplicate, unrelated or absent original Start references', () => {
    const duplicate = fixture()
    duplicate.startObservations.push(structuredClone(duplicate.startObservations[0]!))
    expect(() => parse(duplicate)).toThrow('does not belong to this original finite Start')
    const unrelated = fixture()
    unrelated.startObservations[0]!.operationId = 'another-start'
    expect(() => parse(unrelated)).toThrow('does not belong to this original finite Start')
    const absent = fixture()
    absent.dispatches = []
    expect(() => parse(absent)).toThrow('does not belong to this original finite Start')
  })
})

function withGoalResult() {
  const value = fixture(), grounding = { alignmentRevision: 1, submissionId: 'goal-result', acceptedAt: null,
    summary: 'Goal-level evidence awaiting human review', checks: [{ criterionId: 'AC-01', outcome: 'met' as const, evidence: ['evidence/result.log:7'], note: '' }] }
  value.startObservations[0]!.goalResult = { grounding: structuredClone(grounding), association: 'unknown', basis: 'captured', changedSinceStart: true }
  value.startObservations[0]!.responsibility = 'goal-result-review'
  return { ...value, grounding }
}

describe('original finite Start public Goal result boundary', () => {
  it('exposes a matching Goal-level proposal while retaining unknown worker association and human review', () => {
    const value = withGoalResult(), parsed = parse(value)
    expect(parsed.startObservations![0]!.goalResult).toEqual(value.startObservations[0]!.goalResult)
    expect(parsed.grounding!.acceptedAt).toBeNull()
    expect(parsed.delegations).toEqual([])
    expect(parsed.dispatches![0]!).not.toHaveProperty('report')
  })

  it.each(['worker association', 'captured basis', 'changed submission'] as const)('rejects fabricated %s', contradiction => {
    const value = withGoalResult(), result = value.startObservations[0]!.goalResult!
    if (contradiction === 'worker association') Object.assign(result, { association: 'confirmed' })
    else if (contradiction === 'captured basis') result.basis = 'unknown'
    else result.changedSinceStart = false
    expect(() => parse(value)).toThrow('Goal-level results cannot become a worker report or another result')
  })

  it.each(['submissionId', 'summary', 'evidence', 'acceptedAt'] as const)('rejects another Goal result %s', contradiction => {
    const value = withGoalResult(), result = value.startObservations[0]!.goalResult!.grounding
    if (contradiction === 'submissionId') result.submissionId = 'another-result'
    else if (contradiction === 'summary') result.summary = 'Another Goal result'
    else if (contradiction === 'evidence') result.checks[0]!.evidence = ['evidence/another.log:1']
    else result.acceptedAt = 99
    expect(() => parse(value)).toThrow('Goal-level results cannot become a worker report or another result')
  })

  it('compares normalized Goal result fields independently of JSON key order', () => {
    const value = withGoalResult(), grounding = value.grounding
    value.startObservations[0]!.goalResult!.grounding = { acceptedAt: grounding.acceptedAt,
      checks: grounding.checks.map(check => ({ note: check.note, evidence: check.evidence, outcome: check.outcome, criterionId: check.criterionId })),
      submissionId: grounding.submissionId, summary: grounding.summary, alignmentRevision: grounding.alignmentRevision }
    expect(JSON.stringify(value.startObservations[0]!.goalResult!.grounding)).not.toBe(JSON.stringify(grounding))
    expect(parse(value).startObservations![0]!.goalResult!.grounding).toEqual(grounding)
  })

  it('keeps historical Starts without a captured basis unknown instead of backfilling attribution', () => {
    const value = withGoalResult(), result = value.startObservations[0]!.goalResult!
    Object.assign(value.dispatches[0]!, { resultBasis: undefined })
    result.basis = 'unknown'; result.changedSinceStart = null
    value.startObservations[0]!.responsibility = 'observation-unknown'
    expect(parse(value).startObservations![0]!.goalResult).toMatchObject({ association: 'unknown', basis: 'unknown', changedSinceStart: null })
    result.changedSinceStart = true
    expect(() => parse(value)).toThrow('Goal-level results cannot become a worker report or another result')
  })

  it('distinguishes unchanged captured results and refuses to call them a new result review', () => {
    const value = withGoalResult(), result = value.startObservations[0]!.goalResult!
    Object.assign(value.dispatches[0]!.resultBasis, { groundingSubmissionId: value.grounding.submissionId })
    result.changedSinceStart = false; value.startObservations[0]!.responsibility = 'working'
    expect(parse(value).startObservations![0]!.goalResult!.changedSinceStart).toBe(false)
    value.startObservations[0]!.responsibility = 'goal-result-review'
    expect(() => parse(value)).toThrow('Start responsibility contradicts its original facts')
  })

  it('refuses a Start result with no original Goal-level result or a different Goal identity', () => {
    const value = withGoalResult(), { grounding: _grounding, ...missing } = value
    expect(() => parse(missing)).toThrow()
    expect(() => parse({ ...value, goalId: 'another-goal' })).toThrow('belongs to another object')
  })
})
