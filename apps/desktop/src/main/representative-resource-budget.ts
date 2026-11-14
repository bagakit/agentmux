export const REPRESENTATIVE_TAB_COUNT = 430
export const REPRESENTATIVE_RUN_COUNT = 6
export const REPRESENTATIVE_WORKSPACE_COUNT = 3
export const REPRESENTATIVE_CAPACITY_BYTES = 16 * 1024 ** 3
export const REPRESENTATIVE_SAMPLE_INTERVAL_MS = 200
export const REPRESENTATIVE_WARM_MS = 5_000
export const REPRESENTATIVE_ACTIVITY_MS = 10_000
export const REPRESENTATIVE_HISTORY_BYTES = 256 * 1024
export const REPRESENTATIVE_BURST_BYTES = 256 * 1024
const WARM_LIMIT_KIB = 1024 ** 2
const PEAK_LIMIT_KIB = 1536 * 1024
const MAX_SAMPLE_GAP_MS = 3 * REPRESENTATIVE_SAMPLE_INTERVAL_MS

export type RepresentativeRendererSample = {
  elapsedMs: number
  documentPid: number
  documentGeneration: number
  metrics: readonly { pid: number; type: string; workingSetKiB: number }[]
}

export type RepresentativeResourceEvidence = {
  hostMemoryBytes: number
  rendererPid: number
  documentGenerationChanges: number
  fixtureRevision: number
  restoredTabs: number
  restoredRegions: number
  restoredWorkspaces: number
  restoredRuns: readonly { runId: string; pid: number; seededOutputBytes: number; warmStartOutputBytes: number; warmOutputBytes: number; finalOutputBytes: number }[]
  visibleRunId: string
  warmInputEcho: boolean
  burstOutputBytes: number
  activityFinishedMs: number | null
  alternateRunId: string
  alternateInputEcho: boolean
  returnedInputEcho: boolean
  warm: readonly RepresentativeRendererSample[]
  activity: readonly RepresentativeRendererSample[]
}

function summarizeWindow(samples: readonly RepresentativeRendererSample[], rendererPid: number, durationMs: number, limitKiB: number) {
  const last = samples.at(-1)
  const workingSets = samples.flatMap(({ documentPid, documentGeneration, metrics }) => {
    const matching = metrics.filter((metric) => metric.pid === rendererPid)
    const process = matching[0]
    return documentPid === rendererPid && documentGeneration === 0 && matching.length === 1 && process &&
      /^(?:Tab|Renderer)$/i.test(process.type) && Number.isSafeInteger(process.workingSetKiB) && process.workingSetKiB > 0
      ? [process.workingSetKiB] : []
  })
  const complete = rendererPid > 0 && samples.length >= Math.ceil(durationMs / MAX_SAMPLE_GAP_MS) &&
    samples[0]?.elapsedMs === 0 && last !== undefined && last.elapsedMs >= durationMs &&
    last.elapsedMs <= durationMs + MAX_SAMPLE_GAP_MS && workingSets.length === samples.length &&
    samples.every(({ elapsedMs }, index) => index === 0 || (
      Number.isFinite(elapsedMs) && elapsedMs > samples[index - 1]!.elapsedMs &&
      elapsedMs - samples[index - 1]!.elapsedMs <= MAX_SAMPLE_GAP_MS
    ))
  const maxWorkingSetKiB = workingSets.length > 0 ? Math.max(...workingSets) : null
  return {
    status: !complete || maxWorkingSetKiB === null ? 'coverage-missing' : maxWorkingSetKiB > limitKiB ? 'budget-exceeded' : 'passed',
    sampleCount: samples.length, exactRendererSampleCount: workingSets.length,
    elapsedMs: last?.elapsedMs ?? 0, maxWorkingSetKiB, limitKiB
  }
}

export function evaluateRepresentativeResourceBudget(evidence: RepresentativeResourceEvidence) {
  const {
    hostMemoryBytes, rendererPid, documentGenerationChanges, fixtureRevision, restoredTabs, restoredRegions, restoredWorkspaces, restoredRuns,
    visibleRunId, alternateRunId, warmInputEcho, burstOutputBytes, activityFinishedMs, alternateInputEcho, returnedInputEcho, warm, activity
  } = evidence
  const runIds = new Set(restoredRuns.map((run) => run.runId))
  const workloads = {
    originalRendererDocument: documentGenerationChanges === 0,
    durableLayout: fixtureRevision > 0 && restoredTabs === REPRESENTATIVE_TAB_COUNT &&
      restoredRegions >= REPRESENTATIVE_TAB_COUNT && restoredWorkspaces === REPRESENTATIVE_WORKSPACE_COUNT,
    originalRuns: runIds.size === REPRESENTATIVE_RUN_COUNT && restoredRuns.length === runIds.size &&
      new Set(restoredRuns.map((run) => run.pid)).size === runIds.size && runIds.has(visibleRunId) &&
      runIds.has(alternateRunId) && visibleRunId !== alternateRunId && restoredRuns.every((run) =>
        Number.isSafeInteger(run.pid) && run.pid > 0 && run.seededOutputBytes >= REPRESENTATIVE_HISTORY_BYTES &&
        run.warmStartOutputBytes >= run.seededOutputBytes && run.warmOutputBytes > run.warmStartOutputBytes &&
        run.finalOutputBytes > run.warmOutputBytes),
    activeTerminal: warmInputEcho && burstOutputBytes >= REPRESENTATIVE_BURST_BYTES && alternateInputEcho && returnedInputEcho &&
      activityFinishedMs !== null && activityFinishedMs >= 0 && activityFinishedMs <= (activity.at(-1)?.elapsedMs ?? 0)
  }
  const warmWindow = summarizeWindow(warm, rendererPid, REPRESENTATIVE_WARM_MS, WARM_LIMIT_KIB)
  const activityWindow = summarizeWindow(activity, rendererPid, REPRESENTATIVE_ACTIVITY_MS, PEAK_LIMIT_KIB)
  const status = !Object.values(workloads).every(Boolean) || warmWindow.status === 'coverage-missing' || activityWindow.status === 'coverage-missing'
    ? 'coverage-missing' : warmWindow.status === 'budget-exceeded' || activityWindow.status === 'budget-exceeded'
      ? 'budget-exceeded' : 'passed'
  return {
    status, workloads, warm: warmWindow, activity: activityWindow,
    capacity: { expectedBytes: REPRESENTATIVE_CAPACITY_BYTES, actualBytes: hostMemoryBytes,
      status: hostMemoryBytes === REPRESENTATIVE_CAPACITY_BYTES ? 'matched' : 'unmatched' }
  }
}
