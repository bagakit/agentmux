import type { BrowserOperation } from './browser-operation.js'
import type { BrowserOutcomeAssetRun, BrowserOutcomeCriterion, BrowserRegisteredOutcomeCriterion } from './browser-outcome-criteria.js'
import type { BrowserTaskAssetRun, BrowserTaskAssetState, BrowserTaskVersion } from './browser-task-assets.js'
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
  const declared = version.completion?.criteria.map(criterion => criterion.kind === 'download-readable'
    ? { kind: criterion.kind, path: criterion.path } : { kind: criterion.kind, checkpointId: criterion.checkpointId })
  if (!declared?.length) return { result: 'unknown', reason: 'Script completed without a declared business outcome.' }
  const producingStep = version.completion?.criteria.find(criterion => criterion.kind === 'download-readable')?.stepId ??
    version.steps.find(step => step.kind !== 'checkpoint' && step.kind !== 'branch')?.id
  const producerIndex = version.steps.filter(step => step.kind !== 'checkpoint').findIndex(step => step.id === producingStep)
  const producerOperationId = path ? path.get(producingStep ?? '') : operationIds[producerIndex]
  if (!producerOperationId) return { result: 'unavailable', reason: 'The declared outcome producing step was not executed on this path.' }
  const outcomes = journal.flatMap(operation => operation?.outcome ? [{ operation: operation!, outcome: operation.outcome }] : [])
    .filter(({ outcome }) => sameRun(outcome.registration.assetRun, run))
  if (outcomes.length !== 1) return { result: 'unavailable', reason: 'The exact complete outcome registration is missing or ambiguous.' }
  const { operation, outcome } = outcomes[0]!
  const registration = outcome.registration, evaluation = outcome.evaluation
  if (!evaluation || registration.context.browserId !== run.browserId || registration.context.operationId !== operation.id ||
      !registration.context.workspaceId || !registration.context.navigationId || producerIndex < 0 || producerOperationId !== operation.id ||
      !run.operationIds.includes(operation.id) || !sameRun(evaluation.assetRun, run) ||
      JSON.stringify(evaluation.context) !== JSON.stringify(registration.context) ||
      !sameConditions(declared, registration.criteria) || !sameConditions(declared, evaluation.conditions.map(condition => condition.criterion)) ||
      registration.criteria.some(criterion => criterion.kind !== 'human-checkpoint' &&
        (criterion.producer.operationId !== operation.id || criterion.producer.navigationId !== registration.context.navigationId))) {
    return { result: 'unavailable', reason: 'Outcome identity or all original version conditions could not be joined.' }
  }
  const status = evaluation.conditions.some(condition => condition.status === 'unavailable') ? 'unavailable'
    : evaluation.conditions.every(condition => condition.status === 'passed') ? 'passed' : 'not-met'
  if (evaluation.status !== status) return { result: 'unavailable', reason: 'Recorded outcome summary disagrees with its complete conditions.' }
  return { result: status, reason: 'All original conditions from the bound retained outcome.' }
}
