import type { BrowserOperation } from '@agentmux/browser/model/browser-operation'
import type { BrowserOutcomeAssetRun, BrowserOutcomeCriterion, BrowserRegisteredOutcomeCriterion } from '@agentmux/browser/model/browser-outcome-criteria'
import type { BrowserTaskAssetRun, BrowserTaskAssetState, BrowserTaskVersion } from './browser-task-assets.js'
import type { BrowserTaskRunCompletion } from '@agentmux/core/control'
import { browserTaskProducerCriteria } from './browser-task-completion'
import { browserTaskNextIndex } from './browser-task-path.js'

export type BrowserTaskReliabilityResult = 'passed' | 'not-met' | 'unavailable' | 'unknown' | 'failed' | 'stopped' | 'interrupted'
export type BrowserTaskReliability = {
  browserId: string
  assetId: string
  version: number
  selectedRunId: string | null
  selectedRunStatus?: BrowserTaskAssetRun['status']
  population: { retainedRuns: number; terminalRuns: number; pendingRuns: number; firstStartedAt: number | null; lastUpdatedAt: number | null }
  counts: Record<BrowserTaskReliabilityResult, number>
  scriptCompleted: number
  humanInterventions: number
  /** Passed outcomes / all retained terminal runs of this exact version; never all-time reliability. */
  passRate: number | null
  samples: { runId: string; result: BrowserTaskReliabilityResult; reason: string }[]
  warning?: string
}
export type BrowserTaskReliabilityInput = {
  browserId: string; assetId: string; version: number
  state: BrowserTaskAssetState
  operations: readonly BrowserOperation[]
  historyWarning?: string
}

const TERMINAL = new Set<BrowserTaskAssetRun['status']>(['completed', 'failed', 'stopped', 'interrupted'])
function sameRun(value: BrowserOutcomeAssetRun | undefined, run: BrowserTaskAssetRun): boolean {
  return value?.runId === run.id && value.assetId === run.assetId && value.version === run.version
}
function conditionKey(value: BrowserOutcomeCriterion | BrowserRegisteredOutcomeCriterion): string {
  return value.kind === 'download-readable' ? JSON.stringify([value.kind, value.path])
    : value.kind === 'human-checkpoint' ? JSON.stringify([value.kind, value.checkpointId])
      : JSON.stringify([value.kind, value.key, value.expected])
}
function sameConditions(left: readonly (BrowserOutcomeCriterion | BrowserRegisteredOutcomeCriterion)[], right: readonly (BrowserOutcomeCriterion | BrowserRegisteredOutcomeCriterion)[]): boolean {
  return left.length > 0 && left.length === right.length && left.every((value, index) => conditionKey(value) === conditionKey(right[index]!))
}

function completed(operation: BrowserOperation | undefined): boolean {
  return !!operation && operation.phase === 'completed' && operation.steps.length > 0 && operation.steps.every(step => step.status === 'completed')
}

/** Join the original forward cursor and its recorded bindings, including earlier read-only observations. */
function executedPath(run: BrowserTaskAssetRun, version: BrowserTaskVersion, journal: readonly BrowserOperation[]): Map<string, string> | null {
  const bindings = run.stepExecutions
  if (!bindings?.length || bindings.length !== journal.length || new Set(bindings.map(fact => fact.operationId)).size !== bindings.length ||
      bindings.some((fact, index) => fact.operationId !== journal[index]?.id) ||
      new Set(version.steps.map(step => step.id)).size !== version.steps.length) return null
  const decisions = run.branchDecisions ?? []
  if (new Set(decisions.map(fact => fact.stepId)).size !== decisions.length) return null
  const path = new Map<string, string>(), visitedBranches = new Set<string>()
  let cursor = 0, position = 0
  try {
    while (cursor < version.steps.length) {
      const step = version.steps[cursor]!
      if (step.kind === 'checkpoint') { cursor = browserTaskNextIndex(version.steps, cursor); continue }
      if (bindings[position]?.stepId !== step.id) return null
      if (step.kind === 'branch') {
        const decision = decisions.find(fact => fact.stepId === step.id)
        if (!step.branch || !decision || !decision.navigationId || (decision.result !== 'true' && decision.result !== 'false')) return null
        const destination = decision.result === 'true' ? step.branch.onTrue : step.branch.onFalse
        if (decision.nextStepId !== destination) return null
        // The runner may stop after an unknown/failed observation and observe this same cursor again.
        // These are not successful actions: only the latest known observation selects the next step.
        while (bindings[position]?.stepId === step.id) {
          const observation = journal[position]!
          if (!['completed', 'failed', 'indeterminate'].includes(observation.phase) || !observation.steps.length ||
              observation.steps.some(item => item.method !== 'pageInfo' && item.method !== 'snapshot')) return null
          position++
        }
        const latest = journal[position - 1]!
        if (decision.operationId !== latest.id || !completed(latest) || latest.steps.some(item => item.evidence?.some(reference =>
          reference.operationId !== latest.id || reference.browserId !== run.browserId || reference.navigationId !== decision.navigationId))) return null
        path.set(step.id, latest.id); visitedBranches.add(step.id)
        cursor = browserTaskNextIndex(version.steps, cursor, destination)
      } else {
        if (!completed(journal[position])) return null
        path.set(step.id, journal[position]!.id); position++
        cursor = browserTaskNextIndex(version.steps, cursor, step.nextStepId)
      }
    }
  } catch { return null }
  return position === bindings.length && visitedBranches.size === decisions.length ? path : null
}

/** Retained immutable facts only: no page verification, clock, polling or second success store. */
export function getBrowserTaskReliability(input: BrowserTaskReliabilityInput): BrowserTaskReliability {
  const { browserId, assetId, version, state } = input
  const asset = state.assets.find(item => item.id === assetId && item.browserId === browserId)
  const saved = asset?.versions.find(item => item.version === version)
  const runs = new Map<string, BrowserTaskAssetRun>()
  const conflictingRuns = new Set<string>()
  for (const run of state.runs) {
    if (run.assetId !== assetId || run.browserId !== browserId || run.version !== version) continue
    const previous = runs.get(run.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(run)) conflictingRuns.add(run.id)
    else runs.set(run.id, run)
  }
  const operations = new Map<string, BrowserOperation>()
  const conflictingOperations = new Set<string>()
  const needed = new Set([...runs.values()].flatMap(run => run.operationIds))
  for (const operation of input.operations) {
    if (operation.browserId !== browserId || !needed.has(operation.id)) continue
    const previous = operations.get(operation.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(operation)) conflictingOperations.add(operation.id)
    else operations.set(operation.id, operation)
  }
  const counts: BrowserTaskReliability['counts'] = { passed: 0, 'not-met': 0, unavailable: 0, unknown: 0, failed: 0, stopped: 0, interrupted: 0 }
  const samples: BrowserTaskReliability['samples'] = []
  let pendingRuns = 0, scriptCompleted = 0, humanInterventions = 0
  for (const run of runs.values()) {
    const checkpoints = new Set(run.humanCheckpoints?.filter(fact => sameRun(fact, run) && fact.browserId === browserId &&
      fact.origin === 'trusted-ui' && fact.controlBefore === 'human' && Number.isFinite(fact.confirmedAt) &&
      fact.pendingCursor <= run.nextStep && saved?.steps[fact.pendingCursor - 1]?.kind === 'checkpoint' && saved.steps[fact.pendingCursor - 1]?.id === fact.checkpointId)
      .map(fact => fact.checkpointId))
    humanInterventions += checkpoints.size
    if (!TERMINAL.has(run.status)) { pendingRuns++; continue }
    if (run.status === 'completed') scriptCompleted++
    const sample = conflictingRuns.has(run.id) || !saved
      ? { result: 'unavailable' as const, reason: 'The exact saved version or unique run facts are unavailable.' }
      : classify(run, saved, operations, conflictingOperations, input.historyWarning ?? state.warning)
    counts[sample.result]++
    samples.push({ runId: run.id, ...sample })
  }
  const selected = state.selectedRunId ? state.runs.find(run => run.id === state.selectedRunId && run.browserId === browserId && run.assetId === assetId && run.version === version) : undefined
  const times = [...runs.values()]
  const warning = !saved ? 'This immutable version is unavailable; retained run facts remain.' : input.historyWarning ?? state.warning
  return {
    browserId, assetId, version, selectedRunId: selected?.id ?? null,
    ...(selected ? { selectedRunStatus: selected.status } : {}),
    population: { retainedRuns: runs.size, terminalRuns: samples.length, pendingRuns,
      firstStartedAt: times.length ? Math.min(...times.map(run => run.startedAt)) : null,
      lastUpdatedAt: times.length ? Math.max(...times.map(run => run.updatedAt)) : null },
    counts, scriptCompleted, humanInterventions, passRate: samples.length ? counts.passed / samples.length : null, samples,
    ...(warning ? { warning } : {})
  }
}

function classify(run: BrowserTaskAssetRun, version: BrowserTaskVersion, operations: ReadonlyMap<string, BrowserOperation>, conflicts: ReadonlySet<string>, warning?: string): { result: BrowserTaskReliabilityResult; reason: string } {
  if (run.status !== 'completed') return { result: run.status as 'failed' | 'stopped' | 'interrupted', reason: 'Retained execution status; no successful outcome is inferred.' }
  if (warning || run.completionWarning) return { result: 'unavailable', reason: 'Recorded source or completion facts are unavailable.' }
  if (run.nextStep !== version.steps.length || !version.steps.length) return { result: 'unavailable', reason: 'The retained execution did not complete its exact version.' }
  const operationIds = [...new Set(run.operationIds)]
  const journal = operationIds.map(id => operations.get(id))
  if (!operationIds.length || journal.some((operation, index) => !operation || conflicts.has(operationIds[index]!))) {
    return { result: 'unavailable', reason: 'A bound completed operation or its completed steps are missing.' }
  }
  const boundJournal = journal as BrowserOperation[]
  const nonlinear = version.steps.some(step => step.kind === 'branch' || step.nextStepId !== undefined)
  const path = run.stepExecutions !== undefined ? executedPath(run, version, boundJournal) : null
  if (run.stepExecutions !== undefined ? !path : nonlinear || operationIds.length < version.steps.filter(step => step.kind !== 'checkpoint').length || boundJournal.some(operation => !completed(operation))) {
    return { result: 'unavailable', reason: 'The original completed execution path could not be joined.' }
  }
  const outcome = getBrowserTaskRunCompletion(run, version, [...boundJournal])
  if (!outcome) return { result: 'unknown', reason: 'Script completed without a declared business outcome.' }
  return { result: outcome.status, reason: 'All original conditions from the bound retained outcome.' }
}

/** Recorded data checks only. Reading never extracts, re-verifies today's DOM or writes facts. */
export function getBrowserTaskRunCompletion(run: BrowserTaskAssetRun, version: BrowserTaskVersion,
  operations: readonly BrowserOperation[]): BrowserTaskRunCompletion | null {
  const declared = version.completion?.criteria
  if (!declared?.length) return null
  const byId = new Map<string, BrowserOperation>()
  const conflicts = new Set<string>()
  for (const operation of operations) {
    if (!run.operationIds.includes(operation.id)) continue
    const previous = byId.get(operation.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(operation)) conflicts.add(operation.id)
    else byId.set(operation.id, operation)
  }
  const journal = run.operationIds.map(id => byId.get(id))
  const validJournal = journal.every((item): item is BrowserOperation => !!item && !conflicts.has(item.id) && item.browserId === run.browserId)
  const linear = version.steps.filter(step => step.kind !== 'checkpoint')
  const path = !validJournal ? null : run.stepExecutions !== undefined ? executedPath(run, version, journal)
    : !version.steps.some(step => step.kind === 'branch' || step.kind === 'subflow' || step.nextStepId !== undefined) &&
      journal.length === linear.length && journal.every(completed)
      ? new Map(linear.map((step, index) => [step.id, journal[index]!.id])) : null
  const anchor = declared.find(item => item.kind === 'download-readable')?.stepId ??
    version.steps.find(step => step.kind !== 'checkpoint' && step.kind !== 'branch' && step.kind !== 'subflow')?.id
  const conditions: BrowserTaskRunCompletion['conditions'] = declared.map(criterion => {
    const stepId = criterion.kind === 'human-checkpoint' ? anchor : criterion.stepId
    const operationId = stepId ? path?.get(stepId) : undefined
    const unavailable = (reason: string): BrowserTaskRunCompletion['conditions'][number] => ({ criterion, status: 'unavailable', reason,
      ...(operationId ? { operationId } : {}) })
    if (run.status !== 'completed' || run.completionWarning || !path || !operationId) return unavailable('The exact completed path or producer recording is unavailable. Existing work remains.')
    const operation = byId.get(operationId)!, registration = operation.outcome?.registration, evaluation = operation.outcome?.evaluation
    const expected = browserTaskProducerCriteria(version, stepId!)
    if (!registration || !sameRun(registration.assetRun, run) || registration.context.browserId !== run.browserId ||
        registration.context.operationId !== operationId || !registration.context.workspaceId || !registration.context.navigationId ||
        !sameConditions(expected, registration.criteria)) return unavailable('The exact immutable producer declaration is unavailable.')
    for (const registered of registration.criteria) {
      if (registered.kind === 'human-checkpoint') continue
      if (registered.producer.operationId !== operationId || registered.producer.navigationId !== registration.context.navigationId) return unavailable('The producer belongs to another operation or document.')
      if (registered.kind === 'field-equals') {
        const extraction = version.steps.find(step => step.id === stepId)?.extraction
        if (!extraction || JSON.stringify(extraction) !== JSON.stringify(registered.producer.request) ||
            operation.steps.find(step => step.sequence === registered.producer.sequence)?.method !== 'extractStructured') return unavailable('The registered extraction differs from this saved step.')
      }
    }
    if (criterion.kind === 'human-checkpoint') {
      const index = version.steps.findIndex(step => step.kind === 'checkpoint' && step.id === criterion.checkpointId)
      const facts = run.humanCheckpoints?.filter(fact => fact.checkpointId === criterion.checkpointId)
      if (!facts) return unavailable('Trusted checkpoint recording is unavailable.')
      if (!facts.length) return { criterion, operationId, status: 'not-met', reason: 'This checkpoint has no recorded trusted Continue event.' }
      if (facts.length !== 1 || index < 0 || facts[0]!.pendingCursor !== index + 1 || facts[0]!.pendingCursor > run.nextStep ||
          !sameRun(facts[0], run) || facts[0]!.browserId !== run.browserId || facts[0]!.origin !== 'trusted-ui' || facts[0]!.controlBefore !== 'human') return unavailable('The trusted checkpoint is not bound to this exact run and cursor.')
      return { criterion, operationId, status: 'passed', reason: 'The original trusted Continue was recorded for this exact run and checkpoint.' }
    }
    if (!evaluation || evaluation.warning || !sameRun(evaluation.assetRun, run) || JSON.stringify(evaluation.context) !== JSON.stringify(registration.context) ||
        !sameConditions(expected, evaluation.conditions.map(item => item.criterion))) return unavailable('The producer has no confirmed recorded data check.')
    const aggregate = evaluation.conditions.some(item => item.status === 'unavailable') ? 'unavailable'
      : evaluation.conditions.every(item => item.status === 'passed') ? 'passed' : 'not-met'
    if (evaluation.status !== aggregate) return unavailable('The recorded check disagrees with its complete conditions.')
    const key = conditionKey(criterion.kind === 'field-equals' ? { kind: criterion.kind, key: criterion.key, expected: criterion.expected }
      : { kind: criterion.kind, path: criterion.path })
    const result = evaluation.conditions.find(item => conditionKey(item.criterion) === key)
    return result ? { criterion, operationId, status: result.status, reason: result.reason } : unavailable('The declared condition was not checked by this producer.')
  })
  const status = conditions.some(item => item.status === 'unavailable') ? 'unavailable'
    : conditions.every(item => item.status === 'passed') ? 'passed' : 'not-met'
  return { runId: run.id, browserId: run.browserId, assetId: run.assetId, version: run.version, status, conditions,
    ...(run.completionWarning ? { warning: run.completionWarning } : {}) }
}
