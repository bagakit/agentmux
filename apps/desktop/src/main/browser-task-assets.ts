import { parseBrowserTaskParallelContinuationInput, type BrowserTaskParallelContinuationInput, type BrowserTaskParallelContinuation, type BrowserTaskParallelContinuationReceipt } from '@agentmux/core/control'
import { availableParallelism } from 'node:os'
import { parseBrowserTaskParallelInput, parseBrowserTaskParallelBinding, type BrowserTaskParallelList, type BrowserTaskParallelInput, type BrowserTaskParallelSummary, type BrowserTaskParallelInspection, type BrowserTaskParallelCounts, type BrowserTaskParallelTargetProgress } from '@agentmux/core/control'
import { normalizeBrowserTaskParallelRecords, type BrowserTaskParallelHost } from './browser-task-parallel.js'
import type { BrowserTaskParallelRecord, BrowserTaskParallelExecution } from '../shared/browser-task-parallel.js'
import { browserTaskStepParameterKeys } from '../shared/browser-task-assets.js'
import { createHash } from 'node:crypto'
import { parseBrowserTaskInvocation, BROWSER_TASK_SUBFLOW_MAX_CHILDREN, BROWSER_TASK_SUBFLOW_MAX_DEPTH, BROWSER_TASK_SUBFLOW_MAX_ITEMS, type BrowserTaskInvocationCalls, type BrowserTaskRunParent } from '@agentmux/core/control'
import { parseBrowserTaskImportInput, parseBrowserTaskPortableBundle, parseBrowserTaskPortableBinding, type BrowserTaskImportInput, type BrowserTaskPortableBinding, type BrowserTaskPortableBundle } from '@agentmux/core/control'
import { mintObjectId } from '@agentmux/core/object-id'
import { AgentMuxError } from '@agentmux/core'
import type { NameChangeAudit } from './name-change-audit.js'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseBrowserTaskCreateInput, type BrowserTaskCreateInput, type BrowserTaskCreateStatus } from '@agentmux/core/control'
import { BROWSER_PAGE_MUTATING_CAPABILITY_NAMES, durableWriteFile } from '@agentmux/core'
import type { BrowserDemonstrationDraft } from '../shared/browser-demonstration.js'
import type { BrowserReplayStep, BrowserReplayTarget } from '@agentmux/browser/model/browser-operation'
import type { BrowserScriptRunReport } from '../shared/contracts.js'
import type {
  BrowserTaskAsset, BrowserTaskAssetDocument, BrowserTaskAssetRun, BrowserTaskAssetRunInput,
  BrowserTaskAssetState, BrowserTaskContent, BrowserTaskParameter, BrowserTaskStep, BrowserTaskVersion,
  BrowserTaskHumanCheckpoint, BrowserTaskHumanCheckpointRead, BrowserTaskHumanCheckpointSaved, BrowserTaskRunIdentity, BrowserTaskStepExecution, BrowserTaskBatchInput, BrowserTaskBatchRun,
  BrowserTaskAssertion, BrowserTaskSemanticTarget, BrowserTaskStepFailure, BrowserTaskWait, BrowserTaskSubflow
} from '../shared/browser-task-assets.js'
import { compileBrowserSteps } from './browser-replay-compiler.js'
import { compileBrowserTaskCheck } from './browser-task-check.js'
import { parseBrowserStructuredOutputRequest } from '@agentmux/browser/browser-structured-output'
import { parseBrowserOutcomeCriteriaRequest } from '@agentmux/browser/model/browser-outcome-criteria'
import { browserTaskNextIndex, browserTaskSegment, browserTaskReachedCheckpoints, validateBrowserTaskPath, BROWSER_TASK_MAX_EXECUTED_MILLIS, BROWSER_TASK_MAX_OPERATIONS, BROWSER_TASK_MAX_RETRIES, BROWSER_TASK_WAIT_MAX_MILLIS } from '../shared/browser-task-path.js'
import { compileBrowserTaskBranchObservation, evaluateBrowserTaskBranch } from './browser-task-branch.js'
import { validateBrowserTaskBatchValues, BROWSER_TASK_BATCH_MAX_OPERATIONS, BROWSER_TASK_BATCH_MAX_MILLIS, BROWSER_TASK_BATCH_MAX_BYTES, type BrowserTaskBatchHost, type BrowserTaskRunBudget } from './browser-task-batch.js'

export const BROWSER_TASK_ASSETS_FILE = 'browser-task-assets.json'
/** Main-private child execution context; never accepted from a Client request. */
type SubflowFrame = { sourceBrowserId: string; parent: BrowserTaskRunParent; rootId: string; depth: number; limits: { operations: number; timeMillis: number }; navigationGuard?: { runId: string; stepId: string; navigationId: string } }
type TaskBrowserLease = { batchId?: string; parallelId?: string; target?: BrowserTaskParallelRecord['targets'][number]; sourceBrowserId?: string; observedStatus?: BrowserTaskAssetRun['status'] }
type ActiveTaskParallel = { record: BrowserTaskParallelRecord; invocations: Map<string, { input: import('@agentmux/core/control').BrowserTaskParallelTarget; host: BrowserTaskParallelHost }>; targets: Set<string>; finishing: boolean }
function parallelResultStatus(counts: BrowserTaskParallelCounts): BrowserTaskAssetRun['status'] {
  return counts.waitingHuman ? 'waiting-human' : counts.ready || counts.queued || counts.preparing ? 'ready' : counts.interrupted ? 'interrupted' : counts.failed ? 'failed' : counts.stopped ? 'stopped' : 'completed'
}
const MAX_STEPS = 128
const MAX_PARAMETERS = 32
const STEP_KINDS: readonly BrowserTaskStep['kind'][] = ['extract', 'click', 'fill', 'upload', 'navigate', 'checkpoint', 'branch', 'wait', 'assert', 'press', 'hover', 'scroll', 'drag', 'tap', 'longPress', 'swipe', 'pinch', 'subflow']
const HUMAN_FACT_UNAVAILABLE = 'Trusted checkpoint confirmation is unavailable for this exact run. Existing Browser and Agent work remains; restore the recorded facts before verifying completion.'
const HUMAN_FACT_SAVE_FAILED = 'Trusted Continue occurred, but its checkpoint fact could not be saved. Verification is unavailable; Browser and Agent work remains. Restore local storage before verifying again.'
const copy = <T>(value: T): T => structuredClone(value)

export interface BrowserTaskAssetStore {
  load(): Promise<BrowserTaskAssetDocument | null>
  save(document: BrowserTaskAssetDocument): Promise<void>
}

/** Semantic Client assets only: the store never contains code, raw page results or parameter values. */
export class BrowserTaskAssetFileStore implements BrowserTaskAssetStore {
  constructor(private readonly path: string) {}
  async load(): Promise<BrowserTaskAssetDocument | null> {
    let source: string
    try { source = await readFile(this.path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    return normalizeDocument(JSON.parse(source))
  }
  async save(document: BrowserTaskAssetDocument): Promise<void> {
    const source = `${JSON.stringify(normalizeDocument(document), null, 2)}\n`
    await mkdir(dirname(this.path), { recursive: true })
    await durableWriteFile(this.path, source, { requireDirectorySync: true })
  }
}

/** Main is the one Browser control owner. This Client keeps progress, never a second approval bit. */
export interface BrowserTaskAssetHost {
  /** Original host capability, independent of review, permissions and page text. Absent is unknown. */
  dialogTypes?: readonly import('@agentmux/core').AgentMuxBrowserDialogType[]
  /** Bind the actual cursor before its first durable/public projection. */
  onRunPrepared(runId: string): void
  /** frame carries this exact run's fresh values (prompt answers) and redaction need; it is never saved. */
  runScript(browserId: string, script: string, execution: BrowserTaskStepExecution, frame?: { parameters: Record<string, string>; sensitive: boolean }): Promise<BrowserScriptRunReport>
  yieldControl(browserId: string): void
  control(browserId: string): 'human' | 'agent'
  /** Same original owner and current document; null means the observation cannot select a path. */
  navigationId?(browserId: string): string | null
}

export class BrowserTaskAssets {
  private document: BrowserTaskAssetDocument = { version: 1, assets: [], runs: [] }
  private loaded: Promise<void> | undefined
  private tail: Promise<void> = Promise.resolve()
  private loadUnavailable = false
  private warning: string | undefined
  private activeBrowsers = new Map<string, TaskBrowserLease>()
  private readonly activeParallel = new Map<string, ActiveTaskParallel>()
  private readonly parallelProfiles = new Map<string, TaskBrowserLease>()
  private readonly confirmedParallel = new Set<string>()
  private readonly confirmedContinuations = new Set<string>()
  private readonly unconfirmedContinuations = new Set<string>()
  private pumpingParallel = false
  private lastParallelAdmission: string | undefined
  private indexedRuns: BrowserTaskAssetRun[] | undefined
  private readonly runIndex = new Map<string, BrowserTaskAssetRun>()
  private indexedRunCount = 0
  private indexedParallel: BrowserTaskParallelRecord[] | undefined
  private indexedParallelCount = 0
  private readonly parallelIndex = new Map<string, BrowserTaskParallelRecord>()
  private readonly unconfirmedParallel = new Set<string>()
  private readonly listeners = new Set<(browserId: string) => void | Promise<void>>()
  private readonly now: () => number
  private readonly id: () => string
  constructor(private readonly store: BrowserTaskAssetStore, private readonly options: { now?: () => number; id?: () => string; nameAudit?: NameChangeAudit; parallelCapacity?: () => number } = {}) {
    this.now = options.now ?? Date.now; this.id = options.id ?? mintObjectId
  }

  private parallelCapacity(): number { return Math.max(1, Math.floor(this.options.parallelCapacity?.() ?? availableParallelism())) }
  /** Derived lookup only: original mutable run objects remain the sole facts. */
  private findRun(id: string | undefined): BrowserTaskAssetRun | undefined {
    if (this.indexedRuns !== this.document.runs || this.indexedRunCount > this.document.runs.length) {
      this.indexedRuns = this.document.runs; this.indexedRunCount = 0; this.runIndex.clear()
    }
    while (this.indexedRunCount < this.document.runs.length) {
      const run = this.document.runs[this.indexedRunCount++]!; this.runIndex.set(run.id, run)
    }
    return id === undefined ? undefined : this.runIndex.get(id)
  }
  /** Derived references to original mutable records; warm exact reads never traverse unrelated operations. */
  private findParallel(id: string | undefined): BrowserTaskParallelRecord | undefined {
    const records = this.document.parallel
    if (this.indexedParallel !== records || this.indexedParallelCount > (records?.length ?? 0)) {
      this.indexedParallel = records; this.indexedParallelCount = 0; this.parallelIndex.clear()
    }
    while (this.indexedParallelCount < (records?.length ?? 0)) {
      const record = records![this.indexedParallelCount++]!; this.parallelIndex.set(record.operationId, record)
    }
    return id === undefined ? undefined : this.parallelIndex.get(id)
  }
  private allocateId(): string {
    let id: string
    do { id = identity(this.id()) } while (this.document.assets.some(asset => asset.id === id) ||
      this.document.runs.some(run => run.id === id) || this.document.batches?.some(batch => batch.id === id))
    return id
  }

  async ready(): Promise<void> { this.loaded ??= this.load(); await this.loaded }
  subscribe(listener: (browserId: string) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  async state(browserId?: string): Promise<BrowserTaskAssetState> {
    await this.ready()
    const selectedParallel = browserId ? this.findParallel(this.document.selectedParallel?.find(item => item.browserId === browserId)?.operationId) : undefined
    return copy({
      ...(browserId ? { parallel: selectedParallel ? this.parallelSummary(selectedParallel) : null } : {}),
      assets: this.document.assets.filter(asset => !browserId || asset.browserId === browserId),
      runs: this.document.runs.filter(run => !browserId || run.browserId === browserId).map(run => this.projectRun(run)),
      batches: (this.document.batches ?? []).filter(batch => !browserId || batch.browserId === browserId),
      ...(browserId ? { selectedRunId: this.document.selectedRuns?.find(item => item.browserId === browserId)?.runId ?? null,
        activeBatchId: this.activeBrowsers.get(browserId)?.batchId ?? null } : {}),
      ...(this.warning ? { warning: this.warning } : {})
    })
  }
  async get(assetId: string): Promise<BrowserTaskAsset | null> {
    await this.ready(); return copy(this.document.assets.find(asset => asset.id === assetId) ?? null)
  }

  /** Exact current definition only; cumulative versions/runs stay in this original document. */
  async draft(assetId: string): Promise<Pick<BrowserTaskAsset, 'id' | 'browserId' | 'revision' | 'sourceRecordingId' | 'importedFrom' | 'draft'> & { warning?: string }> {
    await this.ready()
    if (this.loadUnavailable) throw new AgentMuxError('The original task draft could not be read. Existing data is retained.', 'BROWSER_TASK_DRAFT_UNAVAILABLE')
    const asset = this.requireAsset(assetId)
    return copy({ id: asset.id, browserId: asset.browserId, revision: asset.revision, ...(asset.sourceRecordingId === undefined ? { importedFrom: asset.importedFrom! } : { sourceRecordingId: asset.sourceRecordingId }), draft: asset.draft, ...(this.warning ? { warning: this.warning } : {}) })
  }

  /** The actual run chosen by the execution owner, including an explicitly resumed earlier cursor. */
  async currentRun(browserId: string): Promise<BrowserTaskAssetRun | null> {
    await this.ready()
    if (this.loadUnavailable) throw new Error('The selected asset execution is unavailable.')
    const selected = this.document.selectedRuns?.find(item => item.browserId === browserId)
    const run = selected && this.document.runs.find(item => item.id === selected.runId && item.browserId === browserId)
    return run ? copy(this.projectRun(run)) : null
  }

  /** Main supplies the real journal id before any page call, against the actual immutable cursor. */
  async bindOperation(execution: BrowserTaskStepExecution, operationId: string): Promise<boolean> {
    return this.change(async () => {
      const bound = this.exactRun(execution)
      if (!bound || bound.run.status !== 'running' || bound.version.steps[bound.run.nextStep]?.id !== execution.stepId) return false
      recordStepOperation(bound.run, execution.stepId, operationId)
      try { await this.updateRun(bound.run); return true }
      catch { return false } // Optional completion recording cannot block the healthy page action.
    })
  }

  async executionVersion(execution: BrowserTaskStepExecution): Promise<BrowserTaskVersion | null> {
    await this.ready()
    const bound = this.exactRun(execution)
    return bound && bound.run.status === 'running' && bound.version.steps[bound.run.nextStep]?.id === execution.stepId ? copy(bound.version) : null
  }

  /** Synchronous authority check after async observation/handle resolution, before dispatch. */
  isExecutionCurrent(execution: BrowserTaskStepExecution, operationId: string): boolean {
    if (this.loadUnavailable) return false
    const selected = this.document.selectedRuns?.find(item => item.browserId === execution.browserId)
    const bound = this.exactRun(execution)
    return !!selected && !!bound && bound.run.status === 'running' && this.isActiveUnder(selected.runId, bound.run) &&
      bound.version.steps[bound.run.nextStep]?.id === execution.stepId && bound.run.operationIds.includes(operationId)
  }
  /** The run is the selected root itself or the exact child at each running ancestor's current item. */
  private isActiveUnder(rootId: string, run: BrowserTaskAssetRun): boolean {
    let current = run
    for (let depth = 1; depth <= BROWSER_TASK_SUBFLOW_MAX_DEPTH; depth += 1) {
      if (current.id === rootId) return true
      const parent = current.parent && this.findRun(current.parent!.runId)
      if (!parent || parent.status !== 'running' || this.currentChild(parent) !== current) return false
      current = parent
    }
    return false
  }

  async markCompletionUnavailable(tuple: BrowserTaskRunIdentity): Promise<void> {
    await this.change(async () => {
      const bound = this.exactRun(tuple)
      if (!bound) return
      bound.run.completionWarning = 'Completion recording is unavailable for this run. Browser and Agent work remains; restore its recorded facts before verifying again.'
      try { await this.updateRun(bound.run) } catch { /* Keep the live notice when its optional save also fails. */ }
    })
  }

  /** Main-only: the trusted Continue/control owner supplies these actual facts before returning control. */
  async recordHumanCheckpoint(tuple: BrowserTaskRunIdentity, checkpointId: string,
    actual: { pendingCheckpointId: string; nextStep: number; controlBefore: 'human' | 'agent' }): Promise<BrowserTaskHumanCheckpointSaved> {
    return this.change(async () => {
      const bound = this.exactRun(tuple)
      if (!bound || this.loadUnavailable || actual.controlBefore !== 'human' || bound.run.status !== 'waiting-human' ||
          actual.pendingCheckpointId !== checkpointId || bound.run.pendingCheckpointId !== checkpointId ||
          bound.run.nextStep !== actual.nextStep || bound.version.steps[actual.nextStep - 1]?.kind !== 'checkpoint' ||
          bound.version.steps[actual.nextStep - 1]?.id !== checkpointId) {
        return { saved: false, fact: null, warning: HUMAN_FACT_UNAVAILABLE }
      }
      const { run, version } = bound
      const existing = run.humanCheckpoints?.find(fact => fact.checkpointId === checkpointId)
      if (existing) return { saved: true, fact: copy(existing) }
      const at = this.now()
      const fact: BrowserTaskHumanCheckpoint = { runId: tuple.runId, browserId: tuple.browserId, assetId: tuple.assetId, version: tuple.version,
        checkpointId, pendingCursor: actual.nextStep,
        origin: 'trusted-ui', controlBefore: 'human', confirmedAt: at }
      // The existing queue serializes every asset/progress producer. Publish only this run's facts,
      // after durable success; never swap a document over another Browser's in-memory progress.
      const candidateRun = { ...run, humanCheckpoints: [...(run.humanCheckpoints ?? []), fact], updatedAt: at }
      const facts = normalizeHumanCheckpoints(candidateRun, version)
      if (!facts) return { saved: false, fact: null, warning: HUMAN_FACT_UNAVAILABLE }
      const candidate = copy(this.document)
      const target = candidate.runs.find(item => item.id === run.id)!
      target.humanCheckpoints = facts; target.updatedAt = at
      try {
        await this.store.save(candidate)
        run.humanCheckpoints = facts; run.updatedAt = at
        this.warning = undefined
        return { saved: true, fact: copy(fact) }
      } catch {
        this.warning = HUMAN_FACT_SAVE_FAILED
        return { saved: false, fact: null, warning: HUMAN_FACT_SAVE_FAILED }
      } finally { this.notify(run.browserId) }
    })
  }

  /** No waiting/control/cursor inference creates approval. Only an exact stored event is returned. */
  async readExactFact(tuple: BrowserTaskRunIdentity, checkpointId: string): Promise<BrowserTaskHumanCheckpointRead> {
    await this.ready()
    const bound = this.exactRun(tuple)
    if (!bound || this.loadUnavailable || this.warning === HUMAN_FACT_SAVE_FAILED) return { status: 'unavailable', warning: HUMAN_FACT_UNAVAILABLE }
    const cursor = bound.version.steps.findIndex(step => step.kind === 'checkpoint' && step.id === checkpointId) + 1
    if (cursor === 0 || bound.run.humanCheckpoints === undefined) return { status: 'unavailable', warning: HUMAN_FACT_UNAVAILABLE }
    const fact = bound.run.humanCheckpoints.find(item => item.checkpointId === checkpointId)
    if (fact) return { status: 'available', fact: copy(fact) }
    // A passed cursor without its event may be an old/unrecorded Continue or failed optional save.
    if (cursor <= bound.run.nextStep && browserTaskReachedCheckpoints(bound.version.steps, bound.run).has(checkpointId) && bound.run.pendingCheckpointId !== checkpointId) return { status: 'unavailable', warning: HUMAN_FACT_UNAVAILABLE }
    return { status: 'not-recorded' }
  }

  /** The loader is the original Main recorder; a client supplies only the frozen metadata intent. */
  async importRecording(input: BrowserTaskCreateInput, readRecording: () => Promise<BrowserDemonstrationDraft | null>): Promise<BrowserTaskAsset> {
    const request = parseBrowserTaskCreateInput(input)
    return this.change(async () => {
      if (this.loadUnavailable) throw new AgentMuxError(this.warning ?? 'Original task creation receipts could not be read. Existing data is kept; check the original request after repairing storage.', 'BROWSER_TASK_CREATE_UNAVAILABLE')
      const existing = creationAsset(this.document, request)
      if (existing) {
        const saved = await this.readCreation(request)
        if (saved.status !== 'created') await this.persistCreation(request)
        return copy(existing)
      }
      const recording = await readRecording()
      if (!recording || recording.id !== request.sourceRecordingId || recording.browserId !== request.browserId || recording.revision !== request.sourceRevision || !['stopped', 'interrupted'].includes(recording.status)) {
        throw new AgentMuxError('The exact stopped demonstration changed or is unavailable. The original recording and task data are kept.', 'BROWSER_TASK_CREATE_SOURCE_CONFLICT')
      }
      const at = this.now()
      const steps: BrowserTaskStep[] = recording.steps.map(step => ({
        id: identity(step.id), kind: step.method === 'fillInput' ? 'fill' : step.method === 'gotoUrl' ? 'navigate' : 'click',
        url: safeUrl(step.url), ...(step.target ? { target: target(step.target) } : {}),
        ...(step.inputKey ? { parameterKey: parameterKey(step.inputKey) } : {}), reviewed: false,
        warning: text(step.blockedReason || 'Review the demonstrated step before execution.')
      }))
      const keys = [...new Set(steps.flatMap(step => step.parameterKey ? [step.parameterKey] : []))]
      const asset: BrowserTaskAsset = {
        id: request.assetId, browserId: identity(recording.browserId), sourceRecordingId: identity(recording.id), creation: copy(request),
        revision: 1, draft: content({ name: request.name, url: steps[0]?.url ?? safeUrl(recording.url), steps,
          parameters: keys.map(key => ({ key, label: key, secret: true })) }), versions: [], createdAt: at, updatedAt: at
      }
      this.document.assets.push(asset)
      await this.persistCreation(request)
      return copy(asset)
    })
  }

  /** Export only an explicitly selected definition; no runtime/recording document enters the bundle. */
  async exportPortable(assetId: string, expectedRevision: number, version?: number): Promise<BrowserTaskPortableBundle> {
    return this.change(async () => {
      if (this.loadUnavailable || this.warning) throw new AgentMuxError('The task definition is not confirmed saved. Repair storage and read the original draft before exporting.', 'BROWSER_TASK_EXPORT_UNAVAILABLE')
      const asset = this.requireAsset(assetId)
      if (asset.revision !== expectedRevision) throw revisionChanged(asset, expectedRevision)
      const selected = version === undefined ? asset.draft : asset.versions.find(item => item.version === version)
      if (!selected) throw new AgentMuxError('That immutable task version is unavailable.', 'BROWSER_TASK_VERSION_UNAVAILABLE')
      const { name, url, steps, parameters, completion } = selected
      const definition = portableContent({ name, url, steps, parameters, ...(completion ? { completion } : {}) })
      return parseBrowserTaskPortableBundle({ format: 'agentmux.browser-task', version: 1,
        source: { assetId, revision: asset.revision, ...(version === undefined ? {} : { publishedVersion: version }) }, definition })
    })
  }

  /** One new local definition. Its original frozen intent uses the same document and durable receipt. */
  async importPortable(input: BrowserTaskImportInput): Promise<BrowserTaskAsset> {
    const { request, binding, definition } = portableIntent(input)
    return this.change(async () => {
      if (this.loadUnavailable) throw new AgentMuxError('Original task import receipts could not be read. Keep the same input and repair storage.', 'BROWSER_TASK_CREATE_UNAVAILABLE')
      const existing = creationAsset(this.document, binding)
      if (existing) {
        const saved = await this.readCreation(binding)
        if (saved.status !== 'created') await this.persistCreation(binding)
        return copy(existing)
      }
      const ids = new Map(definition.steps.map(step => [step.id, mintObjectId()]))
      const remap = (id: string | null): string | null => id === null ? null : ids.get(id)!
      const steps = definition.steps.map(step => ({ ...step, id: ids.get(step.id)!, reviewed: false,
        ...(step.subflow?.target.kind === 'local' ? { subflow: { ...step.subflow, target: { kind: 'imported' as const, source: { assetId: step.subflow.target.assetId, version: step.subflow.target.version } } } } : {}),
        ...(step.nextStepId === undefined ? {} : { nextStepId: remap(step.nextStepId) }),
        ...(typeof step.onFail === 'object' ? { onFail: { goto: remap(step.onFail.goto)! } } : {}),
        ...(step.branch ? { branch: { ...step.branch, onTrue: remap(step.branch.onTrue), onFalse: remap(step.branch.onFalse) } } : {}) }))
      const completion = definition.completion && { criteria: definition.completion.criteria.map(item => item.kind !== 'human-checkpoint'
        ? { ...item, stepId: remap(item.stepId)! } : { ...item, checkpointId: remap(item.checkpointId)! }) }
      const at = this.now(), asset: BrowserTaskAsset = { id: request.assetId, browserId: request.browserId, revision: 1,
        importedFrom: copy(request.bundle.source), creation: binding, draft: content({ ...definition, steps, ...(completion ? { completion } : {}) }), versions: [], createdAt: at, updatedAt: at }
      this.document.assets.push(asset)
      await this.persistCreation(binding)
      return copy(asset)
    })
  }

  async inspectPortableImport(input: BrowserTaskImportInput): Promise<BrowserTaskCreateStatus> {
    const { binding } = portableIntent(input)
    return this.change(() => this.readCreation(binding))
  }

  /** Read the original durable binding. This never creates, resumes or replays a write. */
  async inspectCreation(input: BrowserTaskCreateInput): Promise<BrowserTaskCreateStatus> {
    const request = parseBrowserTaskCreateInput(input)
    return this.change(() => this.readCreation(request))
  }

  private async readCreation(request: BrowserTaskCreateInput | BrowserTaskPortableBinding): Promise<BrowserTaskCreateStatus> {
    const original = creationAsset(this.document, request)
    const identity = { createOperationId: request.createOperationId, assetId: request.assetId, browserId: request.browserId }
    try {
      const raw = await this.store.load(), saved = raw ? normalizeDocument(raw) : { version: 1 as const, assets: [], runs: [] }
      const confirmed = creationAsset(saved, request)
      if (this.loadUnavailable) {
        this.document = saved
        this.interruptRestoredExecutions()
        this.loadUnavailable = false; this.warning = undefined
      }
      else if (confirmed && !original) this.document.assets.push(copy(confirmed))
      if (isDeepStrictEqual(this.document, saved)) this.warning = undefined
      if (confirmed) { this.notify(request.browserId); return { ...identity, status: 'created' } }
      return { ...identity, status: original ? 'unknown' : 'not-found', ...(original ? { warning: 'This original creation is not confirmed saved. Continue this same request to save its original asset; no new identity is needed.' } : {}) }
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'BROWSER_TASK_CREATE_CONFLICT') throw error
      return { ...identity, status: 'unknown', warning: 'The original creation receipt could not be read. Its input, asset identity and existing data are kept. Check the same request after repairing storage.' }
    }
  }

  private async persistCreation(request: BrowserTaskCreateInput | BrowserTaskPortableBinding): Promise<void> {
    try { await this.persist(request.browserId) }
    catch {
      throw new AgentMuxError('Task creation saving is unconfirmed. Keep this original request and asset identity; check its receipt before continuing. Nothing is automatically created again.',
        'BROWSER_TASK_CREATE_UNCONFIRMED', JSON.stringify({ createOperationId: request.createOperationId, assetId: request.assetId, browserId: request.browserId }))
    }
  }

  async edit(assetId: string, expectedRevision: number, replacement: unknown): Promise<BrowserTaskAsset> {
    return this.change(async () => {
      const asset = this.requireAsset(assetId)
      // A full replacement is deliberate. In particular, an empty step list stays empty.
      const next = content(replacement)
      const revisionConflict = asset.revision !== expectedRevision
        ? revisionChanged(asset, expectedRevision) : null
      const change = { target: { kind: 'browser-task', id: assetId },
        location: { browserId: asset.browserId }, before: asset.draft.name,
        requested: next.name, ownerRevision: asset.revision }
      const apply = async (): Promise<BrowserTaskAsset> => {
        if (revisionConflict) throw revisionConflict
        asset.draft = next
        asset.revision += 1; asset.updatedAt = this.now()
        await this.persistAuthoring(asset)
        return copy(asset)
      }
      return this.options.nameAudit
        ? await this.options.nameAudit.run([change], apply,
          result => ({ actual: result.draft.name, ownerRevision: result.revision,
            reason: result.draft.name === change.before ? 'unchanged' : null }),
          error => error === revisionConflict ? 'failed' : 'unknown') : await apply()
    })
  }
  async saveVersion(assetId: string, expectedRevision: number): Promise<BrowserTaskAsset> {
    return this.change(async () => {
      const asset = this.requireAsset(assetId)
      if (asset.revision !== expectedRevision) throw revisionChanged(asset, expectedRevision)
      if (!asset.draft.steps.length) throw new Error('The draft has no steps. Add a reviewed step before saving a runnable version.')
      validateBrowserTaskPath(asset.draft.steps)
      this.subflowDepth(asset.browserId, asset.draft.steps)
      asset.versions.push({ ...copy(asset.draft), version: (asset.versions.at(-1)?.version ?? 0) + 1, savedAt: this.now() })
      asset.revision += 1; asset.updatedAt = this.now()
      await this.persistAuthoring(asset)
      return copy(asset)
    })
  }

  async stop(runId: string): Promise<BrowserTaskAssetRun | null> {
    // The Manager's real operation cancellation is separate, addressed by its journal operationId.
    return this.change(async () => {
      const run = this.document.runs.find(item => item.id === runId)
      if (!run) return null
      // A subflow tree stops as one invocation; completed and already-ended runs keep their results.
      const affected = this.treeRuns(this.rootOf(run).id).filter(item => item.status === 'ready' || item.status === 'running' || item.status === 'waiting-human')
      if (affected.length) {
        for (const item of affected) { item.status = 'stopped'; item.warning = 'Task stopped. Completed steps remain; inspect the page before another run.'; item.updatedAt = this.now() }
        await this.persist(run.browserId)
      }
      return copy(this.projectRun(run))
    })
  }

  /** Used by runBrowserTaskAsset. Caller is the trusted Client action; continuation has no Agent API. */
  async run(input: BrowserTaskAssetRunInput, host: BrowserTaskAssetHost, budget?: BrowserTaskRunBudget, parallel?: BrowserTaskParallelExecution): Promise<BrowserTaskAssetRun> {
    return await this.execute(input, host, budget, undefined, parallel)
  }

  /** A subflow frame runs inside its root's lease and shares the root's one cost budget. */
  private async execute(input: BrowserTaskAssetRunInput, host: BrowserTaskAssetHost, budget?: BrowserTaskRunBudget, frame?: SubflowFrame, parallel?: BrowserTaskParallelExecution): Promise<BrowserTaskAssetRun> {
    await this.ready()
    const browserId = identity(input.browserId)
    // GUI and public callers share the same bounded fresh-value contract.
    if (!frame && input.calls !== undefined) input = { ...input, ...parseBrowserTaskInvocation({ parameters: input.parameters, calls: input.calls }) }
    const parameters = { ...input.parameters }
    if (!frame && this.isBrowserExecuting(browserId, budget?.batchId, parallel?.operationId)) throw new Error('A task is already executing in this Browser.')
    if (!frame && Buffer.byteLength(JSON.stringify({ parameters, calls: input.calls ?? {} })) > BROWSER_TASK_BATCH_MAX_BYTES) throw new Error('Task invocation values exceed their 64 KiB budget.')
    const ownsLease = !frame && !this.activeBrowsers.has(browserId)
    if (ownsLease) this.activeBrowsers.set(browserId, {})
    let run: BrowserTaskAssetRun | undefined
    try {
      const prepared = await this.change(async () => {
        const asset = this.requireAsset(input.assetId)
        const sourceBrowserId = frame?.sourceBrowserId ?? parallel?.sourceBrowserId ?? browserId
        if (asset.browserId !== sourceBrowserId) throw new Error('This task asset belongs to another Browser library.')
        const parallelTarget = parallel ? this.parallelExecution(input, parallel) : undefined
        const version = asset.versions.find(item => item.version === input.version)
        if (!version) throw new Error('Task version is unavailable. Select a retained version before running.')
        const existing = input.runId ? this.document.runs.find(item => item.id === input.runId) : undefined
        if (input.runId && !existing) throw new Error('Task run is unavailable; it was not restarted.')
        if (existing && !frame && !isDeepStrictEqual(existing.orchestration, parallel ? { operationId: parallel.operationId, targetId: parallel.targetId, sourceBrowserId: parallel.sourceBrowserId } : undefined)) throw new Error('Continue this original target through its parallel operation, preserving its shared admission and fresh values.')
        if (existing && !isDeepStrictEqual(existing.parent, frame?.parent)) {
          throw new Error(existing.parent ? 'Continue this subflow item through its original root run to keep its items and shared budget.' : 'Task continuation identity changed; the original run was retained.')
        }
        if (existing && (existing.assetId !== asset.id || existing.version !== version.version || existing.browserId !== browserId)) {
          throw new Error('Task continuation identity changed; the original run was retained.')
        }
        if (existing && this.document.batches?.some(batch => batch.items.some(item => item.runId === existing.id) && batch.id !== budget?.batchId)) {
          throw new Error('Continue this item through its original batch to preserve its bounds and progress.')
        }
        if (existing && existing.status !== 'waiting-human' && existing.status !== 'ready') {
          throw new Error('This task cannot be continued automatically. Review completed and uncertain steps before creating another run.')
        }
        if (host.control(browserId) !== 'agent') throw new Error('The person has Browser control. Return control explicitly before running the task.')
        validateBrowserTaskPath(version.steps)
        validateTaskSegment(version, parameters, existing?.nextStep ?? 0, input.mode, host.dialogTypes)
        this.validateCalls(sourceBrowserId, version, input.calls, frame?.depth ?? 1)
        const batch = budget ? this.document.batches?.find(batch => batch.id === budget.batchId && batch.browserId === browserId && batch.assetId === asset.id && batch.version === version.version && batch.status === 'running') : undefined
        const batchItem = batch?.items[batch.nextItem]
        if (budget && (!batchItem || (batchItem.runId && batchItem.runId !== existing?.id) || this.activeBrowsers.get(browserId)?.batchId !== budget.batchId)) throw new Error('The original batch item changed before its task was prepared.')
        const next = existing ?? {
          id: this.allocateId(), assetId: asset.id, version: version.version, browserId,
          nextStep: 0, status: 'ready' as const, operationIds: [], stepExecutions: [], branchDecisions: [], executedMillis: 0, humanCheckpoints: [], startedAt: this.now(), updatedAt: this.now(),
          ...(frame ? { parent: copy(frame.parent) } : {}),
          ...(parallel ? { orchestration: { operationId: parallel.operationId, targetId: parallel.targetId, sourceBrowserId: parallel.sourceBrowserId } } : {})
        }
        if (parallelTarget && !existing) { parallelTarget.runId = next.id; parallelTarget.phase = 'bound' }
        if (frame && !existing) {
          // Bind the child to its exact parent item in the same save that creates it.
          const item = this.callItem(frame.parent)
          if (!item || item.runId) throw new Error('The original subflow item changed before its child run was prepared.')
          item.runId = next.id
        }
        if (!existing) {
          this.document.runs.push(next)
        }
        if (batchItem) batchItem.runId = next.id
        if (!frame) {
          host.onRunPrepared(next.id)
          this.document.selectedRuns = [...(this.document.selectedRuns ?? []).filter(item => item.browserId !== browserId), { browserId, runId: next.id }]
        }
        delete next.pendingCheckpointId; delete next.warning
        next.status = 'ready'
        await this.persist(next.browserId)
        return { run: next, version: copy(version) }
      })
      run = prepared.run
      const version = prepared.version
      const tree = { sourceBrowserId: frame?.sourceBrowserId ?? parallel?.sourceBrowserId ?? browserId, rootId: frame?.rootId ?? run.id, depth: frame?.depth ?? 1, ...(frame?.navigationGuard ? { navigationGuard: frame.navigationGuard } : {}), limits: frame?.limits ?? {
        operations: Math.min(BROWSER_TASK_MAX_OPERATIONS, budget?.operations ?? BROWSER_TASK_MAX_OPERATIONS),
        timeMillis: Math.min(BROWSER_TASK_MAX_EXECUTED_MILLIS, budget?.timeMillis ?? BROWSER_TASK_MAX_EXECUTED_MILLIS) } }
      let actions = 0
      // Script failures of the step at this cursor index in this invocation; a forward cursor never revisits it.
      let failed = { index: -1, count: 0 }
      const currentStep = version.steps[run.nextStep]
      const previousDecision = currentStep?.kind === 'subflow' && this.callHasOperations(run.id, currentStep.id) ? undefined
        : run.branchDecisions?.find(fact => fact.result !== 'unknown' && fact.nextStepId === currentStep?.id && run!.stepExecutions?.at(-1)?.operationId === fact.operationId)
      let selectedByBranch: { stepId: string; index: number; navigationId: string } | undefined = previousDecision ? { stepId: previousDecision.stepId, index: version.steps.findIndex(step => step.id === previousDecision.stepId), navigationId: previousDecision.navigationId } : undefined
      const invalidateSelection = async () => {
        const selected = selectedByBranch!
        await this.change(async () => {
          if (run!.status === 'stopped') return
          run!.nextStep = selected.index; run!.status = 'ready'
          const fact = run!.branchDecisions?.find(item => item.stepId === selected.stepId)
          if (fact) { fact.result = 'unknown'; delete fact.nextStepId }
          run!.warning = 'The condition page changed before the selected action. No action was sent; inspect the original page and observe the condition again.'
          await this.updateRun(run!)
        })
        host.yieldControl(browserId)
        return copy(this.projectRun(run!))
      }
      const inheritedNavigation = (): string | undefined => frame?.navigationGuard && !this.callHasOperations(frame.navigationGuard.runId, frame.navigationGuard.stepId)
        ? frame.navigationGuard.navigationId : undefined
      const pauseForNavigation = async () => {
        await this.change(async () => {
          if (run!.status !== 'stopped') {
            run!.status = 'ready'; run!.warning = 'The condition page changed before this subflow action. No action was sent; inspect its original condition again.'
          }
          await this.updateRun(run!)
        })
        return copy(this.projectRun(run!))
      }
      while (run.nextStep < version.steps.length) {
        if (run.status === 'stopped') break
        if (inheritedNavigation() !== undefined && host.navigationId?.(browserId) !== inheritedNavigation()) return await pauseForNavigation()
        if (selectedByBranch && host.navigationId?.(browserId) !== selectedByBranch.navigationId) return await invalidateSelection()
        const step = version.steps[run.nextStep]!
        if (step.kind === 'checkpoint') {
          host.yieldControl(browserId)
          await this.change(async () => {
            if (run!.status === 'stopped') return
            run!.nextStep += 1; run!.status = 'waiting-human'; run!.pendingCheckpointId = step.id
            run!.warning = 'Human checkpoint reached. Review the page, then explicitly return control to continue the remaining steps.'
            await this.updateRun(run!)
          })
          return copy(this.projectRun(run))
        }
        const cost = this.treeCost(tree.rootId)
        if (cost.operations >= tree.limits.operations || cost.executedMillis >= tree.limits.timeMillis) {
          await this.change(async () => { run!.status = 'interrupted'; run!.warning = 'Task execution budget reached. Existing actions and progress remain; no further step was sent.'; await this.updateRun(run!) })
          host.yieldControl(browserId)
          return copy(this.projectRun(run))
        }
        // A selected path may need fresh parameters not known before its condition ran.
        // Retain that selected cursor and let the person supply them; never execute an earlier arm again.
        try { validateTaskSegment(version, parameters, run.nextStep, input.mode, host.dialogTypes) }
        catch (error) {
          await this.change(async () => { run!.status = 'ready'; run!.warning = error instanceof Error ? error.message : 'The selected path needs review before execution.'; await this.updateRun(run!) })
          return copy(this.projectRun(run))
        }
        if (step.kind === 'subflow') {
          const navigationGuard = selectedByBranch && !this.callHasOperations(run.id, step.id)
            ? { runId: run.id, stepId: step.id, navigationId: selectedByBranch.navigationId } : tree.navigationGuard
          if (!await this.runSubflow(run, version, step, input, host, { ...tree, ...(navigationGuard ? { navigationGuard } : {}) })) {
            if (selectedByBranch && !this.callHasOperations(run.id, step.id) && host.navigationId?.(browserId) !== selectedByBranch.navigationId) return await invalidateSelection()
            return copy(this.projectRun(run))
          }
          selectedByBranch = undefined
          actions += 1
          if (input.mode === 'step' && run.nextStep < version.steps.length) {
            await this.change(async () => { if (run!.status !== 'stopped') run!.status = 'ready'; await this.updateRun(run!) })
            return copy(this.projectRun(run))
          }
          continue
        }
        const expectedNavigationId = selectedByBranch?.navigationId ?? inheritedNavigation()
        const execution: BrowserTaskStepExecution = { browserId, runId: run.id, assetId: run.assetId, version: run.version, stepId: step.id,
          ...(expectedNavigationId === undefined ? {} : { expectedNavigationId }) }
        const navigationId = step.kind === 'branch' ? host.navigationId?.(browserId) ?? null : null
        const download = version.completion?.criteria.find(item => item.kind === 'download-readable' && item.stepId === step.id)
        const script = step.kind === 'branch' ? compileBrowserTaskBranchObservation(step, execution)
          : compileAssetStep(step, parameters, download?.kind === 'download-readable' ? download.path : undefined)
        // Write-ahead cursor: restart during a call is uncertain, so no automatic replay is offered.
        const started = await this.change(async () => {
          if (run!.status === 'stopped') return false
          run!.status = 'running'; await this.updateRun(run!)
          return true
        })
        // A listener can stop the cursor across the await; discard the earlier loop narrowing.
        if (!started || (run as BrowserTaskAssetRun).status === 'stopped') break
        if (inheritedNavigation() !== undefined && host.navigationId?.(browserId) !== inheritedNavigation()) return await pauseForNavigation()
        if (selectedByBranch && host.navigationId?.(browserId) !== selectedByBranch.navigationId) return await invalidateSelection()
        const branchIndex = run.nextStep
        let report: BrowserScriptRunReport, retry = false
        const callStartedAt = performance.now()
        execution.deadlineMillis = callStartedAt + tree.limits.timeMillis - this.treeCost(tree.rootId).executedMillis
        try { report = await host.runScript(browserId, script, execution, { parameters, sensitive: version.parameters.length > 0 }) }
        catch {
          await this.change(async () => {
            run!.executedMillis = (run!.executedMillis ?? 0) + Math.max(0, performance.now() - callStartedAt)
            if (run!.status !== 'stopped') {
              run!.status = 'interrupted'; run!.warning = 'The Browser call did not produce a known result. Inspect the page; this step was not replayed.'
            }
            await this.updateRun(run!)
          })
          return copy(this.projectRun(run))
        }
        await this.change(async () => {
          const stopped = run!.status === 'stopped'
          run!.executedMillis = (run!.executedMillis ?? 0) + Math.max(0, performance.now() - callStartedAt)
          // A real journal id is required; asset/run ids are never passed as operation ids.
          if (!report.runOperation.id || report.runOperation.browserId !== browserId) {
            run!.status = 'interrupted'; run!.warning = 'The Browser operation identity could not be confirmed. Inspect the page before continuing.'
          } else {
            recordStepOperation(run!, step.id, report.runOperation.id)
            if (step.kind === 'branch') {
              const decision = evaluateBrowserTaskBranch({ execution, report, navigationId,
                currentNavigationId: host.navigationId?.(browserId) ?? null,
                current: !stopped && run!.status === 'running' && version.steps[run!.nextStep]?.id === step.id && host.control(browserId) === 'agent' })
              const destination = decision.result === 'true' ? step.branch!.onTrue : decision.result === 'false' ? step.branch!.onFalse : undefined
              run!.branchDecisions = [...(run!.branchDecisions ?? []).filter(item => item.stepId !== step.id),
                { stepId: step.id, operationId: report.runOperation.id, navigationId: decision.navigationId, result: decision.result,
                  ...(destination === undefined ? {} : { nextStepId: destination }) }]
              if (decision.result === 'unknown') {
                run!.status = 'ready'; run!.warning = 'Condition is unknown or its page changed. No path was chosen; inspect the original page and explicitly return control to observe again.'
              } else {
                run!.nextStep = browserTaskNextIndex(version.steps, run!.nextStep, destination)
                selectedByBranch = { stepId: step.id, index: branchIndex, navigationId: decision.navigationId }
              }
            } else if (report.outcome.kind === 'completed') {
              if (failed.index === run!.nextStep) run!.warning = `Task step ${stepName(step)} completed on attempt ${failed.count + 1} after ${failed.count} script failure${failed.count === 1 ? '' : 's'}.`
              run!.nextStep = browserTaskNextIndex(version.steps, run!.nextStep, step.nextStepId)
            } else if (report.outcome.kind === 'script-failed' && !stopped) {
              // Only a known script failure is handled by the step itself. Stopped, interrupted and
              // indeterminate results keep the branch below: never retried, never continued.
              failed = { index: run!.nextStep, count: failed.index === run!.nextStep ? failed.count + 1 : 1 }
              const next = afterStepFailure(step, failed.count, report), operationId = report.runOperation.id
              const attempts = `${failed.count} attempt${failed.count === 1 ? '' : 's'}`
              const sent = next.actionMayHaveRun ? ' A page action of the failed attempt may already have run, so it was not retried.' : ''
              if (next.then === 'retry') {
                retry = true
                run!.warning = `Task step ${stepName(step)} attempt ${failed.count} failed (script-failed); retrying, ${failed.count} of ${step.retry} retries used.`
              } else if (next.then === 'stop') {
                run!.status = 'failed'
                run!.warning = `Task step ${stepName(step)} failed (script-failed) after ${attempts}.${sent} Earlier steps remain; inspect operation ${operationId} before another action.`
              } else {
                run!.failedSteps = [...(run!.failedSteps ?? []), { stepId: step.id, operationId }]
                run!.nextStep = browserTaskNextIndex(version.steps, run!.nextStep, next.then === 'continue' ? step.nextStepId : next.then.goto)
                run!.warning = `Task step ${stepName(step)} failed (script-failed) after ${attempts}.${sent} Its failure handling moved on; this run cannot complete as a success.`
              }
            } else {
              run!.status = report.outcome.kind === 'stopped' ? 'stopped' : report.outcome.kind === 'script-failed' ? 'failed' : 'interrupted'
              run!.warning = 'The Browser step did not complete. Earlier steps remain; inspect the operation details before another action.'
            }
          }
          if (stopped) run!.status = 'stopped'
          await this.updateRun(run!)
        })
        // A retry keeps this cursor and passes the same stop, budget, segment and compile checks again.
        if (retry && run.status === 'running') continue
        if (run.status !== 'running') {
          if (step.kind === 'branch' && run.status === 'ready') host.yieldControl(browserId)
          return copy(this.projectRun(run))
        }
        if (step.kind !== 'branch') selectedByBranch = undefined
        actions += 1
        if (input.mode === 'step' && actions === 1 && run.nextStep < version.steps.length) {
          await this.change(async () => { run!.status = 'ready'; await this.updateRun(run!) })
          return copy(this.projectRun(run))
        }
      }
      await this.change(async () => {
        if (run!.status !== 'stopped' && run!.failedSteps?.length) {
          run!.status = 'failed'
          run!.warning = `Task reached the end of its path with failed steps: ${run!.failedSteps.map(fact => `${stepName(version.steps.find(step => step.id === fact.stepId) ?? { id: fact.stepId })} (operation ${fact.operationId})`).join(', ')}. Each failure is recorded; this run is not a success.`
        } else run!.status = run!.status === 'stopped' ? 'stopped' : 'completed'
        await this.updateRun(run!)
      })
      return copy(this.projectRun(run))
    } finally {
      if (ownsLease) { this.activeBrowsers.delete(browserId); this.pumpParallel() }
    }
  }

  /**
   * Delegate each explicit item to one original child run of the fixed version, in order.
   * Completed items are never rerun; a waiting, failed or unknown item ends this parent advance.
   * Returns true only when the parent cursor moved past the subflow step.
   */
  private async runSubflow(run: BrowserTaskAssetRun, version: BrowserTaskVersion, step: BrowserTaskStep, input: BrowserTaskAssetRunInput,
    host: BrowserTaskAssetHost, tree: Omit<SubflowFrame, 'parent'>): Promise<boolean> {
    const pause = async (status: BrowserTaskAssetRun['status'], warning: string): Promise<false> => {
      await this.change(async () => { if (run.status !== 'stopped') { run.status = status; run.warning = warning } await this.updateRun(run) })
      return false
    }
    const supplied = input.calls && Object.hasOwn(input.calls, step.id) ? input.calls[step.id] : undefined
    if (!supplied) return await pause('ready', `Subflow ${stepName(step)} needs fresh call items for this invocation. Nothing was run.`)
    const target = step.subflow!.target as { kind: 'local'; assetId: string; version: number }
    const ids = supplied.items.map(item => item.id)
    const call = await this.change(async () => {
      let call = run.calls?.find(call => call.stepId === step.id)
      if (run.status === 'stopped' || (call && !isDeepStrictEqual(call.items.map(item => item.id), ids))) return call ? 'changed' as const : null
      if (!call) {
        call = { stepId: step.id, assetId: target.assetId, version: target.version, nextItem: 0, items: ids.map(id => ({ id })) }
        run.calls = [...(run.calls ?? []), call]
        await this.updateRun(run)
      }
      return call
    })
    if (call === 'changed') return await pause('ready', `Subflow ${stepName(step)} items must keep their original ids and order. Completed items remain; nothing was run.`)
    if (!call) return false
    while (call.nextItem < call.items.length) {
      if (run.status === 'stopped') return false
      const item = call.items[call.nextItem]!, values = supplied.items[call.nextItem]!
      const existing = item.runId ? this.document.runs.find(child => child.id === item.runId) : undefined
      if (existing && existing.status !== 'ready' && existing.status !== 'waiting-human') {
        return await pause(existing.status === 'completed' || existing.status === 'running' ? 'interrupted' : existing.status,
          `Subflow ${stepName(step)} item ${JSON.stringify(item.id)} ended ${existing.status}. Completed items remain; inspect its run before another invocation.`)
      }
      if (!item.runId && this.treeRuns(tree.rootId).length - 1 >= BROWSER_TASK_SUBFLOW_MAX_CHILDREN) {
        return await pause('interrupted', `This invocation reached its ${BROWSER_TASK_SUBFLOW_MAX_CHILDREN} subflow child runs. Completed items remain; no further item was sent.`)
      }
      const cost = this.treeCost(tree.rootId)
      if (cost.operations >= tree.limits.operations || cost.executedMillis >= tree.limits.timeMillis) {
        return await pause('interrupted', 'Task execution budget reached. Existing actions and progress remain; no further step was sent.')
      }
      const started = await this.change(async () => {
        if (run.status === 'stopped') return false
        run.status = 'running'; delete run.warning; await this.updateRun(run); return true
      })
      if (!started) return false
      try {
        await this.execute({ browserId: run.browserId, assetId: target.assetId, version: target.version, parameters: { ...supplied.parameters, ...values.parameters },
          ...(values.calls ? { calls: values.calls } : {}), ...(item.runId ? { runId: item.runId } : {}) }, host, undefined,
        { parent: { runId: run.id, stepId: step.id, itemId: item.id }, ...tree, depth: tree.depth + 1 })
      } catch (error) {
        return await pause(item.runId ? 'interrupted' : 'ready', `Subflow ${stepName(step)} item ${JSON.stringify(item.id)}: ${error instanceof Error ? error.message : 'its child run did not start.'}`)
      }
      const advanced = await this.change(async () => {
        const child = this.document.runs.find(child => child.id === item.runId)
        if (run.status === 'stopped') return false
        if (child?.status === 'completed') { call.nextItem += 1; await this.updateRun(run); return true }
        const status = child && child.status !== 'running' ? child.status : 'interrupted'
        run.status = status
        run.warning = `Subflow ${stepName(step)} item ${JSON.stringify(item.id)} ${status === 'waiting-human' ? 'is waiting for the person' : `stopped at ${status}`}. Completed items remain; ` +
          (status === 'waiting-human' || status === 'ready' ? 'continue this root run with the same items and fresh values.' : 'inspect its run before another invocation.')
        await this.updateRun(run); return false
      })
      if (!advanced) return false
    }
    await this.change(async () => {
      if (run.status !== 'stopped') run.nextStep = browserTaskNextIndex(version.steps, run.nextStep, step.nextStepId)
      await this.updateRun(run)
    })
    return run.status !== 'stopped'
  }

  /** Fresh call items must match this exact version's subflow steps and their fixed callees. */
  private validateCalls(browserId: string, version: BrowserTaskVersion, calls: BrowserTaskInvocationCalls | undefined, depth: number): void {
    for (const [stepId, call] of Object.entries(calls ?? {})) {
      const step = version.steps.find(step => step.id === stepId && step.kind === 'subflow')
      if (!step) throw new Error('Subflow call items name a step that is not a subflow of this version. Nothing was run.')
      if (depth >= BROWSER_TASK_SUBFLOW_MAX_DEPTH) throw new Error(`Subflows may nest at most ${BROWSER_TASK_SUBFLOW_MAX_DEPTH} levels. Nothing was run.`)
      const callee = this.callee(browserId, step), once = step.subflow!.iteration === 'once'
      const items = Array.isArray(call?.items) ? call.items : []
      if ((once ? items.length !== 1 : items.length < 1 || items.length > BROWSER_TASK_SUBFLOW_MAX_ITEMS) || new Set(items.map(item => item?.id)).size !== items.length) {
        throw new Error(`Subflow ${stepName(step)} takes ${once ? 'exactly one item' : `1–${BROWSER_TASK_SUBFLOW_MAX_ITEMS} uniquely identified items`}. Nothing was run.`)
      }
      for (const [key, value] of Object.entries(call.parameters ?? {})) {
        if (typeof value !== 'string' || value.length > 16_384 || !callee.parameters.some(parameter => parameter.key === key)) throw new Error(`Subflow ${stepName(step)} parameters must be declared by its fixed version. Nothing was run.`)
      }
      for (const item of items) {
        identity(item.id)
        for (const [key, value] of Object.entries(item.parameters ?? {})) {
          const parameter = callee.parameters.find(parameter => parameter.key === key)
          if (typeof value !== 'string' || value.length > 16_384 || !parameter || parameter.secret) throw new Error('Per-item subflow values must use declared non-secret parameters; supply secrets once for the call. Nothing was run.')
        }
        this.validateCalls(browserId, callee, item.calls, depth + 1)
      }
    }
  }

  /** The parent condition is consumed by its first original child operation, including across Continue. */
  private callHasOperations(runId: string, stepId: string): boolean {
    const call = this.findRun(runId)?.calls?.find(call => call.stepId === stepId)
    return !!call?.items.some(item => item.runId && this.treeRuns(item.runId).some(run => run.operationIds.length > 0))
  }
  private callItem(parent: BrowserTaskRunParent): { id: string; runId?: string } | undefined {
    return this.document.runs.find(run => run.id === parent.runId)?.calls?.find(call => call.stepId === parent.stepId)?.items.find(item => item.id === parent.itemId)
  }
  /** The root and every child bound through its original call items. */
  private treeRuns(rootId: string): BrowserTaskAssetRun[] {
    const result: BrowserTaskAssetRun[] = [], pending = [rootId]
    while (pending.length && result.length <= BROWSER_TASK_SUBFLOW_MAX_CHILDREN) {
      const runId = pending.shift()!
      const run = this.findRun(runId)
      if (!run || result.includes(run)) continue
      result.push(run)
      for (const call of run.calls ?? []) for (const item of call.items) if (item.runId) pending.push(item.runId)
    }
    return result
  }
  private treeCost(rootId: string): { operations: number; executedMillis: number } {
    const runs = this.treeRuns(rootId)
    return { operations: runs.reduce((sum, run) => sum + run.operationIds.length, 0), executedMillis: runs.reduce((sum, run) => sum + (run.executedMillis ?? 0), 0) }
  }
  private rootOf(run: BrowserTaskAssetRun): BrowserTaskAssetRun {
    let current = run
    for (let depth = 1; current.parent && depth < BROWSER_TASK_SUBFLOW_MAX_DEPTH; depth += 1) {
      const parent = this.findRun(current.parent!.runId)
      if (!parent) break
      current = parent
    }
    return current
  }
  /** The exact child bound at the run's current subflow cursor, if any. */
  private currentChild(run: BrowserTaskAssetRun): BrowserTaskAssetRun | undefined {
    const version = this.document.assets.find(asset => asset.id === run.assetId)?.versions.find(item => item.version === run.version)
    const call = run.calls?.find(call => call.stepId === version?.steps[run.nextStep]?.id)
    const runId = call?.items[call.nextItem]?.runId
    return runId ? this.document.runs.find(child => child.id === runId) : undefined
  }

  /** One exact run tree for public inspection: no asset bodies, values or approval payloads. */
  async inspect(browserId: string, runId?: string): Promise<{ rootRunId: string; currentRunId: string; runs: BrowserTaskAssetRun[]; operationCount: number; executedMillis: number } | null> {
    await this.ready()
    if (this.loadUnavailable) throw new AgentMuxError(this.warning ?? 'Task runs could not be read. Existing data is retained.', 'BROWSER_TASK_RUNS_UNAVAILABLE')
    const id = runId ?? this.document.selectedRuns?.find(item => item.browserId === browserId)?.runId
    if (!id) return null
    const target = this.document.runs.find(run => run.id === id)
    if (!target || target.browserId !== browserId) throw new AgentMuxError('This task run does not belong to the Browser.', 'BROWSER_TASK_RUN_NOT_FOUND')
    const root = this.rootOf(target), runs = this.treeRuns(root.id)
    let current = root
    for (let child = this.currentChild(current); child && runs.includes(child); child = this.currentChild(current)) current = child
    const cost = this.treeCost(root.id)
    return copy({ rootRunId: root.id, currentRunId: current.id, runs: runs.map(run => this.projectRun(run)), operationCount: cost.operations, executedMillis: cost.executedMillis })
  }

  /** The deepest run awaiting its own human checkpoint under this root, for the trusted Continue owner. */
  async waitingLeaf(runId: string): Promise<BrowserTaskAssetRun | null> {
    await this.ready()
    let current = this.findRun(runId)
    for (let child = current && this.currentChild(current); child; child = this.currentChild(child)) current = child
    return current && current.status === 'waiting-human' && current.pendingCheckpointId ? copy(current) : null
  }

  /** Freeze one original version and target set before admitting any page work. */
  async startParallel(browserId: string, assetId: string, versionNumber: number, supplied: BrowserTaskParallelInput, host: BrowserTaskParallelHost): Promise<BrowserTaskParallelSummary> {
    await this.ready()
    const input = parseBrowserTaskParallelInput(supplied)
    const prepared = await this.change(async () => {
      const asset = this.requireAsset(assetId), version = asset.versions.find(item => item.version === versionNumber)
      if (asset.browserId !== browserId || !version) throw new Error('The exact source task version is unavailable in this Browser library.')
      validateBrowserTaskPath(version.steps); this.subflowDepth(browserId, version.steps)
      const previous = this.findParallel(input.operationId)
      const intent = { browserId, assetId, version: versionNumber, requestedConcurrency: input.concurrency ?? 2,
        targets: input.targets.map(({ id, browserId, profileId }) => ({ id, browserId, profileId })) }
      if (previous) {
        if (!isDeepStrictEqual(parallelIntent(previous), intent)) throw new AgentMuxError('This operation id already belongs to another frozen task target set. Its original records were retained.', 'BROWSER_TASK_PARALLEL_CONFLICT')
        return { record: previous, created: false }
      }
      for (const target of input.targets) this.validateCalls(browserId, version, target.calls, 1)
      const record: BrowserTaskParallelRecord = { ...intent, operationId: input.operationId,
        concurrency: Math.min(intent.requestedConcurrency, input.targets.length, this.parallelCapacity()),
        status: 'running', startedAt: this.now(), updatedAt: this.now(), targets: intent.targets.map(target => ({ ...target, phase: 'queued' })) }
      this.document.parallel = [...(this.document.parallel ?? []), record]
      this.unconfirmedParallel.add(record.operationId)
      this.document.selectedParallel = [...(this.document.selectedParallel ?? []).filter(item => item.browserId !== browserId), { browserId, operationId: record.operationId }]
      try { await this.persist(browserId) }
      catch {
        record.status = 'interrupted'; record.warning = 'The original execution admission could not be confirmed. Inspect this same operation id; no remaining target was automatically replayed.'
        throw new AgentMuxError(record.warning, 'BROWSER_TASK_PARALLEL_UNCONFIRMED', JSON.stringify({ browserId, operationId: record.operationId }))
      }
      return { record, created: true }
    })
    const { record } = prepared
    // Existing operation ids are observations, even if their original write reply was lost.
    if (prepared.created) {
      this.activeParallel.set(record.operationId, { record, invocations: new Map(input.targets.map(target => [target.id, { input: target, host }])), targets: new Set(), finishing: false })
      this.pumpParallel()
    }
    return this.parallelSummary(record)
  }

  /** Each explicit continuation retains its own request ID; repeats only read its original receipt. */
  async continueParallel(browserId: string, operationId: string, targetId: string, supplied: BrowserTaskParallelContinuationInput, host: BrowserTaskParallelHost, intent: 'human' | 'control'): Promise<BrowserTaskParallelContinuationReceipt> {
    const input = parseBrowserTaskParallelContinuationInput(supplied)
    const prepared = await this.change(async () => {
      if (this.loadUnavailable) throw new AgentMuxError(this.warning ?? 'Original task records are unavailable.', 'BROWSER_TASK_RUNS_UNAVAILABLE')
      const record = this.findParallel(operationId), target = record?.targets.find(target => target.id === targetId)
      if (!record || record.browserId !== browserId || !target) throw new AgentMuxError('The original continuation target could not be read; its identity was retained.', 'BROWSER_TASK_PARALLEL_NOT_FOUND')
      const original = record.continuations?.find(item => item.id === input.continuationId)
      if (original) {
        if (original.targetId !== targetId || original.expectedRevision !== input.expectedRevision) throw new AgentMuxError('This continuation ID already belongs to another original intent. Inspect it before a new request.', 'BROWSER_TASK_PARALLEL_CONFLICT')
        return { record, target, enqueue: false, info: this.continuationInfo(record, original) }
      }
      const refuse = (warning: string) => ({ record, target, enqueue: false, info: { id: input.continuationId, targetId, admission: 'refused' as const, warning } })
      if (this.continuationRevision(record, target) !== input.expectedRevision || record.status === 'stopped') return refuse('The original target cursor or admission changed. No continuation was admitted; read its current facts before another explicit request.')
      const run = this.findRun(target.runId)
      if (run?.status === 'waiting-human' && intent !== 'human') return refuse('This original target is waiting for the person. Public control cannot approve its human checkpoint.')
      const previousStatus = record.status
      const originalIntent = { id: input.continuationId, targetId, expectedRevision: input.expectedRevision }
      record.continuations = [...(record.continuations ?? []), originalIntent]
      target.pendingContinuationId = input.continuationId
      record.status = 'running'; record.updatedAt = this.now(); delete target.error
      this.unconfirmedContinuations.add(this.continuationKey(record.operationId, input.continuationId))
      try { await this.persist(browserId) }
      catch {
        record.status = previousStatus; delete target.pendingContinuationId; record.warning = 'Continuation admission saving is unconfirmed. Keep this original continuation ID and inspect it; no remaining work was automatically replayed.'
        throw new AgentMuxError(record.warning, 'BROWSER_TASK_PARALLEL_UNCONFIRMED', JSON.stringify({ browserId, operationId, continuationId: input.continuationId }))
      }
      return { record, target, enqueue: true, info: this.continuationInfo(record, originalIntent) }
    })
    if (prepared.enqueue) {
      const previous = this.activeParallel.get(operationId)
      const context: ActiveTaskParallel = previous && !previous.finishing ? previous : { record: prepared.record, invocations: new Map(), targets: new Set(), finishing: false }
      context.invocations.set(targetId, { input: { id: targetId, browserId: prepared.target.browserId, profileId: prepared.target.profileId, parameters: input.parameters, ...(input.calls === undefined ? {} : { calls: input.calls }) }, host })
      this.activeParallel.set(operationId, context); this.pumpParallel()
    }
    return { run: this.parallelSummary(prepared.record), continuation: prepared.info }
  }

  private continuationKey(operationId: string, continuationId: string): string { return operationId + '\0' + continuationId }
  private continuationInfo(record: BrowserTaskParallelRecord, intent: NonNullable<BrowserTaskParallelRecord['continuations']>[number]): BrowserTaskParallelContinuation {
    return { id: intent.id, targetId: intent.targetId, admission: this.confirmedContinuations.has(this.continuationKey(record.operationId, intent.id)) ? 'confirmed' : 'unknown', ...(record.warning || this.warning ? { warning: record.warning ?? this.warning! } : {}) }
  }
  /** Revision is a compare-and-set token over original facts, never permission or a page observation. */
  private continuationRevision(record: BrowserTaskParallelRecord, target: BrowserTaskParallelRecord['targets'][number]): string | undefined {
    if (record.status === 'stopped' || this.activeParallel.get(record.operationId)?.invocations.has(target.id) || target.pendingContinuationId && record.status === 'running') return undefined
    const active = this.activeBrowsers.get(target.browserId)
    if (active?.target === target) return undefined
    const run = this.findRun(target.runId)
    if (target.phase !== 'queued' && (!run || run.status !== 'ready' && run.status !== 'waiting-human')) return undefined
    return createHash('sha256').update(JSON.stringify({ source: [record.operationId, record.browserId, record.assetId, record.version], target: [target.id, target.browserId, target.profileId, target.runId ?? null],
      runs: run ? this.treeRuns(run.id).map(item => [item.id, item.status, item.nextStep, item.operationIds, item.pendingCheckpointId ?? null, item.calls ?? []]) : [] })).digest('hex')
  }

  /** Stop the original target set; native cancellation belongs to the original Manager. */
  async stopParallel(browserId: string, operationId: string, cancel: (target: { browserId: string; runId?: string }) => void): Promise<BrowserTaskParallelSummary | null> {
    return await this.change(async () => {
      if (this.loadUnavailable) throw new AgentMuxError(this.warning ?? 'Original task records are unavailable.', 'BROWSER_TASK_RUNS_UNAVAILABLE')
      const record = this.findParallel(operationId)
      if (!record || record.browserId !== browserId) return null
      let changed = false
      for (const target of record.targets) {
        delete target.pendingContinuationId
        const lease = this.activeBrowsers.get(target.browserId)
        if (lease?.parallelId === operationId && lease.target === target) cancel({ browserId: target.browserId, ...(target.runId ? { runId: target.runId } : {}) })
        if (!target.runId && (target.phase === 'queued' || target.phase === 'preparing')) { target.phase = 'stopped'; changed = true }
        if (target.runId) for (const run of this.treeRuns(target.runId)) if (run.status === 'ready' || run.status === 'running' || run.status === 'waiting-human') {
          run.status = 'stopped'; run.warning = 'The original parallel execution stopped. Completed and uncertain page effects remain in their original operations.'; run.updatedAt = this.now(); changed = true
        }
      }
      if (changed) {
        record.status = 'stopped'; this.activeParallel.get(operationId)?.invocations.clear(); record.updatedAt = this.now()
        record.warning = 'No further target or task step will be sent. Completed and uncertain effects were not undone; inspect the original Browser operations.'
        await this.persist(browserId)
      }
      return this.parallelSummary(record)
    })
  }

  async listParallel(browserId: string, before?: string, limit = 32): Promise<BrowserTaskParallelList> {
    await this.ready()
    if (this.loadUnavailable) throw new AgentMuxError(this.warning ?? 'Original task records are unavailable.', 'BROWSER_TASK_RUNS_UNAVAILABLE')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('Task execution page size must be 1–64.')
    const records = (this.document.parallel ?? []).filter(record => record.browserId === browserId).reverse()
    const index = before === undefined ? -1 : records.findIndex(record => record.operationId === before)
    if (before !== undefined && index < 0) throw new Error('The original execution history boundary is unavailable in this library.')
    const runs = records.slice(index + 1, index + 1 + limit).map(record => this.parallelSummary(record))
    return copy({ runs, page: { before: before ?? null, limit, nextBefore: index + 1 + runs.length < records.length ? runs.at(-1)!.operationId : null } })
  }

  async inspectParallel(browserId: string, operationId?: string, after?: string, limit = 32, continuationId?: string): Promise<BrowserTaskParallelInspection | null> {
    await this.ready()
    if (this.loadUnavailable) throw new AgentMuxError(this.warning ?? 'Original task records are unavailable.', 'BROWSER_TASK_RUNS_UNAVAILABLE')
    const selected = operationId ?? this.document.selectedParallel?.find(item => item.browserId === browserId)?.operationId
    if (!selected) return null
    const record = this.findParallel(selected)
    if (!record || record.browserId !== browserId) throw new AgentMuxError('This original task execution is unavailable in the source Browser library.', 'BROWSER_TASK_PARALLEL_NOT_FOUND')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('Task execution page size must be 1–64.')
    const index = after === undefined ? -1 : record.targets.findIndex(target => target.id === after)
    if (after !== undefined && index < 0) throw new Error('The target page boundary does not belong to this original execution.')
    // Only an unconfirmed admission needs original-writer reconciliation; ordinary polling stays bounded.
    if (!this.confirmedParallel.has(record.operationId)) {
      try {
        const stored = normalizeDocument(await this.store.load())
        if (stored.parallel?.some(saved => saved.operationId === record.operationId && isDeepStrictEqual(parallelIntent(saved), parallelIntent(record)))) this.confirmedParallel.add(record.operationId)
      } catch { /* An unavailable observation is not an empty execution or permission to replay. */ }
    }
    const continuation = continuationId ? record.continuations?.find(item => item.id === continuationId) : undefined
    if (continuation && !this.confirmedContinuations.has(this.continuationKey(record.operationId, continuation.id))) {
      try {
        const stored = normalizeDocument(await this.store.load())
        if (stored.parallel?.some(group => group.operationId === record.operationId && group.continuations?.some(item => isDeepStrictEqual(item, continuation)))) this.confirmedContinuations.add(this.continuationKey(record.operationId, continuation.id))
      } catch { /* No observation of an ACK is permission to replay the request. */ }
    }
    const targets = record.targets.slice(index + 1, index + 1 + limit).map(target => this.parallelTarget(record, target))
    return copy({ run: this.parallelSummary(record), targets, ...(continuationId === undefined ? {} : { continuation: continuation ? this.continuationInfo(record, continuation) : null }), page: { after: after ?? null, limit,
      nextAfter: index + 1 + targets.length < record.targets.length ? targets.at(-1)!.id : null } })
  }

  /** Unfinished original targets are cold Profile references, independent of visible Tabs. */
  async profileReferences(profileId: string): Promise<{ operationId: string; targetId: string; browserId: string }[]> {
    await this.ready()
    if (this.loadUnavailable) throw new Error('Task target references are unknown; original records were retained.')
    return (this.document.parallel ?? []).flatMap(record => record.status === 'stopped' ? [] : record.targets.flatMap(target => {
      if (target.profileId !== profileId) return []
      const run = this.findRun(target.runId)
      return target.phase === 'queued' || target.phase === 'preparing' || run && ['ready', 'running', 'waiting-human', 'interrupted'].includes(run.status)
        ? [{ operationId: record.operationId, targetId: target.id, browserId: target.browserId }] : []
    }))
  }

  /** Main-private authority for a root admitted by this exact live target operation. */
  assertParallelExecution(input: BrowserTaskAssetRunInput, execution: BrowserTaskParallelExecution): void {
    this.parallelExecution(input, execution)
  }
  private parallelExecution(input: BrowserTaskAssetRunInput, execution: BrowserTaskParallelExecution): BrowserTaskParallelRecord['targets'][number] {
    const active = this.activeParallel.get(execution.operationId), record = active?.record
    const target = record?.targets.find(target => target.id === execution.targetId)
    const lease = this.activeBrowsers.get(input.browserId)
    if (!active || !record || record.status !== 'running' || !target || record.browserId !== execution.sourceBrowserId || record.assetId !== input.assetId || record.version !== input.version ||
        target.browserId !== input.browserId || target.profileId !== execution.profileId || lease?.parallelId !== execution.operationId || lease.target !== target ||
        target.runId !== input.runId) throw new Error('The original parallel target admission changed. No replacement run was started.')
    return target
  }

  private parallelTarget(record: BrowserTaskParallelRecord, target: BrowserTaskParallelRecord['targets'][number]): BrowserTaskParallelTargetProgress {
    const run = this.findRun(target.runId), held = this.parallelProfiles.get(target.profileId)
    const continuationRevision = this.continuationRevision(record, target)
    return { id: target.id, browserId: target.browserId, profileId: target.profileId, phase: target.phase,
      ...(run ? { run: { id: run.id, status: run.status, nextStep: run.nextStep, operationCount: this.treeCost(run.id).operations } } : {}),
      ...(continuationRevision ? { continuationRevision } : {}), ...(target.error ? { error: copy(target.error) } : {}),
      ...(target.phase === 'queued' && held ? { waitingForProfile: { operationId: held.parallelId!, targetId: held.target!.id } } : {}) }
  }
  private parallelSummary(record: BrowserTaskParallelRecord): BrowserTaskParallelSummary {
    const counts: BrowserTaskParallelCounts = { queued: 0, preparing: 0, running: 0, waitingHuman: 0, ready: 0, completed: 0, interrupted: 0, failed: 0, stopped: 0 }
    for (const target of record.targets) {
      const run = this.findRun(target.runId)
      if (run) counts[run.status === 'waiting-human' ? 'waitingHuman' : run.status] += 1
      else counts[target.phase === 'failed' ? 'failed' : target.phase === 'stopped' ? 'stopped' : target.phase === 'preparing' ? 'preparing' : 'queued'] += 1
    }
    const settled = !this.activeParallel.has(record.operationId) && !counts.queued && !counts.preparing
    const status = record.status === 'stopped' || !settled ? record.status : parallelResultStatus(counts)
    return { operationId: record.operationId, browserId: record.browserId, assetId: record.assetId, version: record.version, status,
      targetCount: record.targets.length, concurrency: record.concurrency, requestedConcurrency: record.requestedConcurrency, counts,
      startedAt: record.startedAt, updatedAt: record.updatedAt, admission: this.confirmedParallel.has(record.operationId) ? 'confirmed' : 'unknown',
      ...(record.warning || this.warning ? { warning: record.warning ?? this.warning! } : {}) }
  }
  private pumpParallel(): void {
    if (this.pumpingParallel) return
    this.pumpingParallel = true
    try {
      while (this.parallelProfiles.size < this.parallelCapacity()) {
        const contexts = [...this.activeParallel.values()]
        const start = (contexts.findIndex(context => context.record.operationId === this.lastParallelAdmission) + 1) % Math.max(1, contexts.length)
        let admitted = false
        for (let offset = 0; offset < contexts.length; offset += 1) {
          const context = contexts[(start + offset) % contexts.length]!, record = context.record
          if (context.finishing || record.status !== 'running' || context.targets.size >= record.concurrency) continue
          const target = record.targets.find(target => (target.phase === 'queued' || target.pendingContinuationId !== undefined) && context.invocations.has(target.id) && !context.targets.has(target.id) && !this.activeBrowsers.has(target.browserId) && !this.parallelProfiles.has(target.profileId))
          if (!target) continue
          const lease: TaskBrowserLease = { parallelId: record.operationId, target, sourceBrowserId: record.browserId }
          context.targets.add(target.id); this.parallelProfiles.set(target.profileId, lease); this.activeBrowsers.set(target.browserId, lease)
          this.lastParallelAdmission = record.operationId; admitted = true
          void this.executeParallelTarget(context, target).finally(() => {
            if (this.activeBrowsers.get(target.browserId) === lease) this.activeBrowsers.delete(target.browserId)
            if (this.parallelProfiles.get(target.profileId) === lease) this.parallelProfiles.delete(target.profileId)
            context.targets.delete(target.id); context.invocations.delete(target.id); this.finishParallel(context); this.pumpParallel()
          })
          break
        }
        if (!admitted) break
      }
      for (const context of this.activeParallel.values()) this.finishParallel(context)
    } finally { this.pumpingParallel = false }
  }
  private async executeParallelTarget(context: ActiveTaskParallel, target: BrowserTaskParallelRecord['targets'][number]): Promise<void> {
    const record = context.record
    try {
      const admitted = await this.change(async () => {
        if (record.status === 'stopped') return false
        target.phase = target.runId ? 'bound' : 'preparing'; delete target.pendingContinuationId; record.updatedAt = this.now(); await this.persist(record.browserId); return true
      })
      if (!admitted) return
      const { input: values, host } = context.invocations.get(target.id)!
      await host.runTask({ browserId: target.browserId, assetId: record.assetId, version: record.version, ...(target.runId ? { runId: target.runId } : {}), parameters: values.parameters,
        ...(values.calls === undefined ? {} : { calls: values.calls }) },
      { operationId: record.operationId, targetId: target.id, sourceBrowserId: record.browserId, profileId: target.profileId })
    } catch (error) {
      await this.change(async () => {
        if (record.status === 'stopped') return
        if (!target.runId) target.phase = 'failed'
        target.error = { code: 'BROWSER_TASK_TARGET_FAILED', message: target.runId
          ? 'This target did not confirm completion. Inspect its original run and Browser operation receipts; other targets remain available.'
          : 'This exact Browser/Profile target could not be admitted. Check its availability and automation permission before a new operation; other targets remain available.' }
        record.updatedAt = this.now()
        try { await this.persist(record.browserId) } catch { if (this.warning) record.warning = this.warning }
      })
    }
  }
  private finishParallel(context: ActiveTaskParallel): void {
    if (context.finishing || context.targets.size || context.record.targets.some(target => context.invocations.has(target.id) && (target.phase === 'queued' || target.phase === 'preparing' || target.pendingContinuationId !== undefined))) return
    context.finishing = true
    void this.change(async () => {
      const summary = this.parallelSummary(context.record), counts = summary.counts
      if (context.record.status !== 'stopped') context.record.status = parallelResultStatus(counts)
      context.record.updatedAt = this.now()
      try { await this.persist(context.record.browserId) } catch { if (this.warning) context.record.warning = this.warning }
    }).finally(() => { if (this.activeParallel.get(context.record.operationId) === context) this.activeParallel.delete(context.record.operationId); this.pumpParallel() })
  }

  /** The original execution lease also covers batch preparation and the gaps between its items. */
  isBrowserExecuting(browserId: string, batchId?: string, parallelId?: string): boolean {
    const active = this.activeBrowsers.get(browserId)
    return !!active && (batchId === undefined || active.batchId !== batchId) && (parallelId === undefined || active.parallelId !== parallelId)
  }

  async stopBatch(browserId: string, batchId: string): Promise<BrowserTaskBatchRun | null> {
    return this.change(async () => {
      const batch = this.document.batches?.find(item => item.id === batchId && item.browserId === browserId)
      if (!batch) return null
      if (batch.status !== 'completed') {
        batch.status = 'stopped'; batch.warning = 'Batch stopped. Original item runs and completed actions remain; no remaining item was replayed.'
        const run = this.document.runs.find(run => run.id === batch.items[batch.nextItem]?.runId)
        if (run && run.status !== 'completed' && run.status !== 'interrupted') { run.status = 'stopped'; run.updatedAt = this.now() }
        batch.updatedAt = this.now(); await this.persist(browserId)
      }
      return copy(batch)
    })
  }

  async runBatch(input: BrowserTaskBatchInput, host: BrowserTaskBatchHost): Promise<BrowserTaskBatchRun> {
    await this.ready(); validateBrowserTaskBatchValues(input)
    const browserId = identity(input.browserId)
    if (this.activeBrowsers.has(browserId)) throw new Error('A task is already executing in this Browser.')
    const lease: { batchId?: string } = {}; this.activeBrowsers.set(browserId, lease)
    const supplied = copy(input)
    let batch: BrowserTaskBatchRun | undefined
    try {
      batch = await this.change(async () => {
        const asset = this.requireAsset(input.assetId), version = asset.versions.find(version => version.version === input.version)
        if (asset.browserId !== browserId || !version) throw new Error('The batch asset version belongs to another Browser or is unavailable.')
        if (version.steps.some(step => step.kind === 'subflow')) throw new Error('This version calls subflows. Run it directly and give each subflow its explicit items; a batch cannot share that budget.')
        validateBrowserTaskPath(version.steps)
        for (const item of supplied.items) {
          identity(item.id)
          for (const key of Object.keys(item.parameters)) {
            const parameter = version.parameters.find(parameter => parameter.key === key)
            if (!parameter || parameter.secret) throw new Error('Per-item batch values must use declared non-secret parameters; supply secrets once for this invocation.')
          }
        }
        for (const key of Object.keys(supplied.parameters)) if (!version.parameters.some(parameter => parameter.key === key)) throw new Error('Batch invocation parameter is not declared by the immutable version.')
        const previous = input.batchId ? this.document.batches?.find(batch => batch.id === input.batchId) : undefined
        if (input.batchId && !previous) throw new Error('Original batch progress is unavailable; it was not restarted.')
        if (previous && (previous.browserId !== browserId || previous.assetId !== asset.id || previous.version !== version.version ||
            previous.items.length !== supplied.items.length || previous.items.some((item, index) => item.id !== supplied.items[index]?.id))) throw new Error('Batch identity or item order changed; original progress was retained.')
        if (previous && previous.status !== 'ready' && previous.status !== 'waiting-human') throw new Error('This batch cannot continue automatically. Inspect its completed and uncertain original runs.')
        const next: BrowserTaskBatchRun = previous ?? { id: this.allocateId(), browserId, assetId: asset.id, version: version.version,
          items: supplied.items.map(item => ({ id: item.id })), nextItem: 0, status: 'ready', operationCount: 0, executedMillis: 0, startedAt: this.now(), updatedAt: this.now() }
        if (!previous) {
          this.document.batches ??= []
          this.document.batches.push(next)
        }
        lease.batchId = next.id; next.status = 'running'; delete next.warning; next.updatedAt = this.now()
        await this.persist(browserId); return next
      })
      while (batch.nextItem < batch.items.length) {
        if (batch.status === 'stopped') break
        const item = batch.items[batch.nextItem]!, previous = this.document.runs.find(run => run.id === item.runId)
        const related = batch.items.flatMap(item => { const run = this.document.runs.find(run => run.id === item.runId); return run ? [run] : [] })
        batch.operationCount = related.reduce((sum, run) => sum + run.operationIds.length, 0)
        batch.executedMillis = related.reduce((sum, run) => sum + (run.executedMillis ?? 0), 0)
        if (batch.operationCount >= BROWSER_TASK_BATCH_MAX_OPERATIONS || batch.executedMillis >= BROWSER_TASK_BATCH_MAX_MILLIS || Buffer.byteLength(JSON.stringify(batch)) > BROWSER_TASK_BATCH_MAX_BYTES) {
          batch.status = 'interrupted'; batch.warning = 'Batch execution budget reached. Original item runs remain; no next item was sent.'
          await this.persist(browserId); return copy(batch)
        }
        let result: BrowserTaskAssetRun
        try {
          result = await host.runTask({ browserId, assetId: batch.assetId, version: batch.version, parameters: { ...supplied.parameters, ...supplied.items[batch.nextItem]!.parameters }, ...(item.runId ? { runId: item.runId } : {}) },
            { batchId: batch.id, operations: BROWSER_TASK_BATCH_MAX_OPERATIONS - batch.operationCount + (previous?.operationIds.length ?? 0),
              timeMillis: BROWSER_TASK_BATCH_MAX_MILLIS - batch.executedMillis + (previous?.executedMillis ?? 0) })
        } catch {
          if ((batch as BrowserTaskBatchRun).status !== 'stopped') { batch.status = 'interrupted'; batch.warning = 'Batch item did not produce a known original task result. Its progress remains; inspect the page before any remaining item.' }
          batch.updatedAt = this.now(); await this.persist(browserId); return copy(batch)
        }
        await this.change(async () => {
          const original = this.document.runs.find(run => run.id === item.runId)
          if (!original || result.id !== original.id || result.browserId !== browserId || result.assetId !== batch!.assetId || result.version !== batch!.version ||
              result.status !== original.status || result.nextStep !== original.nextStep) {
            if (batch!.status !== 'stopped') { batch!.status = 'interrupted'; batch!.warning = 'The batch item result could not be bound to its original run. No next item was sent.' }
          } else if (batch!.status !== 'stopped') {
            if (original.status === 'completed') batch!.nextItem += 1
            else { batch!.status = original.status; batch!.warning = original.warning ?? 'Inspect this original task run before continuing the batch.' }
          }
          const related = batch!.items.flatMap(item => { const run = this.document.runs.find(run => run.id === item.runId); return run ? [run] : [] })
          batch!.operationCount = related.reduce((sum, run) => sum + run.operationIds.length, 0)
          batch!.executedMillis = related.reduce((sum, run) => sum + (run.executedMillis ?? 0), 0)
          batch!.updatedAt = this.now(); await this.persist(browserId)
        })
        if (batch.status !== 'running') return copy(batch)
      }
      await this.change(async () => { if (batch!.status !== 'stopped') batch!.status = 'completed'; batch!.updatedAt = this.now(); await this.persist(browserId) })
      return copy(batch)
    } finally { if (this.activeBrowsers.get(browserId) === lease) { this.activeBrowsers.delete(browserId); this.notify(browserId) } }
  }

  /** Exact retained callee in the same Browser. Imported references stay unbound until edited. */
  private callee(browserId: string, step: BrowserTaskStep): BrowserTaskVersion {
    const target = step.subflow?.target
    if (target?.kind !== 'local') throw new Error(`Subflow ${stepName(step)} has an unbound imported target. Choose an exact local task version before publishing or running it.`)
    const asset = this.document.assets.find(asset => asset.id === target.assetId)
    const version = asset?.browserId === browserId ? asset.versions.find(version => version.version === target.version) : undefined
    if (!version) throw new Error(`Subflow ${stepName(step)} names a task version that is unavailable in this Browser. Nothing was run.`)
    return version
  }
  /** Validate only this definition’s retained dependency closure, reusing shared callees. */
  private subflowDepth(browserId: string, steps: BrowserTaskStep[], ancestors = new Set<string>(), depths = new Map<string, number>()): number {
    let depth = 1
    for (const step of steps) if (step.kind === 'subflow') {
      const callee = this.callee(browserId, step), target = step.subflow!.target as { assetId: string; version: number }
      const key = JSON.stringify([target.assetId, target.version])
      if (ancestors.has(key)) throw new Error('Subflows cannot recursively call an active task version.')
      let childDepth = depths.get(key)
      if (childDepth === undefined) {
        ancestors.add(key)
        childDepth = this.subflowDepth(browserId, callee.steps, ancestors, depths)
        ancestors.delete(key); depths.set(key, childDepth)
      }
      depth = Math.max(depth, 1 + childDepth)
      if (depth > BROWSER_TASK_SUBFLOW_MAX_DEPTH) throw new Error(`Subflows may nest at most ${BROWSER_TASK_SUBFLOW_MAX_DEPTH} levels including this task.`)
    }
    return depth
  }
  private requireAsset(id: string): BrowserTaskAsset {
    const asset = this.document.assets.find(item => item.id === id)
    if (!asset) throw new Error('Task asset is unavailable; existing Browser work was retained.')
    return asset
  }
  private exactRun(tuple: BrowserTaskRunIdentity): { run: BrowserTaskAssetRun; version: BrowserTaskVersion } | null {
    const run = this.findRun(tuple.runId)
    const asset = this.document.assets.find(item => item.id === tuple.assetId)
    const version = asset?.versions.find(item => item.version === tuple.version)
    if (!run || !asset || !version || run.browserId !== tuple.browserId || asset.browserId !== (this.rootOf(run).orchestration?.sourceBrowserId ?? tuple.browserId) ||
        run.assetId !== tuple.assetId || run.version !== tuple.version) return null
    return { run, version }
  }
  /** The durable cursor and exact facts keep an optional recording failure visible after later saves. */
  private projectRun(run: BrowserTaskAssetRun): BrowserTaskAssetRun {
    const version = this.document.assets.find(asset => asset.id === run.assetId)?.versions.find(item => item.version === run.version)
    const confirmed = new Set(run.humanCheckpoints?.map(fact => fact.checkpointId))
    const reached = version ? browserTaskReachedCheckpoints(version.steps, run) : new Set<string>()
    const unavailable = version?.steps.some((step, index) => step.kind === 'checkpoint' && index < run.nextStep && reached.has(step.id) &&
      step.id !== run.pendingCheckpointId && !confirmed.has(step.id))
    if (!unavailable) return run
    return { ...run, warning: run.warning ? `${run.warning} ${HUMAN_FACT_UNAVAILABLE}` : HUMAN_FACT_UNAVAILABLE }
  }
  private async change<T>(action: () => Promise<T>): Promise<T> {
    await this.ready()
    const next = this.tail.then(action)
    this.tail = next.then(() => {}, () => {})
    return next
  }
  private async updateRun(run: BrowserTaskAssetRun): Promise<void> { run.updatedAt = this.now(); await this.persist(run.browserId) }
  private async persistAuthoring(asset: BrowserTaskAsset): Promise<void> {
    try { await this.persist(asset.browserId) }
    catch {
      throw new AgentMuxError('Task assets could not be saved. The live draft remains; read browser task assets for its current revision, restore storage and inspect before retrying.',
        'BROWSER_TASK_SAVE_UNCONFIRMED', JSON.stringify({ browserId: asset.browserId, assetId: asset.id, currentRevision: asset.revision, saved: 'unconfirmed' }))
    }
  }
  private async persist(browserId?: string): Promise<void> {
    if (this.loadUnavailable) throw new Error(this.warning)
    // These costs are a projection of the original item runs, including a call that is still
    // running or stopped. There is no second batch execution/cost authority.
    for (const batch of this.document.batches ?? []) {
      if (browserId && batch.browserId !== browserId) continue
      const related = batch.items.flatMap(item => { const run = this.document.runs.find(run => run.id === item.runId); return run ? [run] : [] })
      batch.operationCount = related.reduce((sum, run) => sum + run.operationIds.length, 0)
      batch.executedMillis = related.reduce((sum, run) => sum + (run.executedMillis ?? 0), 0)
    }
    try { await this.store.save(copy(this.document)); this.warning = undefined; for (const id of this.unconfirmedParallel) this.confirmedParallel.add(id); this.unconfirmedParallel.clear(); for (const id of this.unconfirmedContinuations) this.confirmedContinuations.add(id); this.unconfirmedContinuations.clear() }
    catch {
      this.warning = 'Task assets could not be saved. The live draft and previous Browser work remain; restore storage before executing another step.'
      throw new Error(this.warning)
    } finally {
      if (browserId) {
        this.notify(browserId)
        const lease = this.activeBrowsers.get(browserId), run = this.findRun(lease?.target?.runId)
        if (lease?.sourceBrowserId && lease.sourceBrowserId !== browserId && lease.observedStatus !== run?.status) {
          if (run) lease.observedStatus = run.status
          this.notify(lease.sourceBrowserId)
        }
      }
    }
  }
  private notify(browserId: string): void {
    for (const listener of [...this.listeners]) {
      try { void Promise.resolve(listener(browserId)).catch(() => {}) }
      catch { /* A failed projection cannot change the durable action/cursor fact. */ }
    }
  }
  private async load(): Promise<void> {
    let restored = false
    try {
      this.document = normalizeDocument(await this.store.load() ?? { version: 1, assets: [], runs: [] })
      restored = true
      for (const record of this.document.parallel ?? []) { this.confirmedParallel.add(record.operationId); for (const item of record.continuations ?? []) this.confirmedContinuations.add(this.continuationKey(record.operationId, item.id)) }
      if (this.interruptRestoredExecutions()) await this.persist()
    } catch {
      this.loadUnavailable = !restored
      this.warning = restored
        ? 'Original task records were restored. Saving their restart status is unconfirmed; inspect the original operations and restore storage before another execution. Browser and Agent work remain available.'
        : 'Task assets could not be restored. The existing file was retained; restore storage to review it. Browser and Agent work remain available.'
    }
  }
  /** Storage becoming readable later still restores execution facts through the same owner. */
  private interruptRestoredExecutions(): boolean {
    let changed = false
    for (const run of this.document.runs) if (run.status === 'running') {
      run.status = 'interrupted'; run.warning = 'Restart interrupted the Browser step. Inspect the page and its operation history; it was not automatically replayed.'
      run.updatedAt = this.now(); changed = true
    }
    for (const record of this.document.parallel ?? []) if (record.status === 'running') {
      record.status = 'interrupted'; record.warning = 'The previous task scheduler ended. Original target/run bindings remain; no target was automatically replayed.'; record.updatedAt = this.now(); changed = true
    }
    for (const batch of this.document.batches ?? []) if (batch.status === 'running') {
      batch.status = 'interrupted'; batch.warning = 'Restart interrupted this batch. Original item runs remain; uncertain actions and remaining items were not replayed.'; batch.updatedAt = this.now(); changed = true
    }
    return changed
  }
}

export async function runBrowserTaskAsset(assets: BrowserTaskAssets, input: BrowserTaskAssetRunInput, host: BrowserTaskAssetHost, budget?: BrowserTaskRunBudget, parallel?: BrowserTaskParallelExecution): Promise<BrowserTaskAssetRun> {
  return await assets.run(input, host, budget, parallel)
}

function stepName(step: Pick<BrowserTaskStep, 'id' | 'label'>): string { return JSON.stringify(step.label || step.id) }

/**
 * What a page step does after one known script failure. Only an attempt whose operation sent no
 * page action may run again: a failed action can have half-applied, and replaying it could send it
 * twice. Steps the operation cannot describe count as possibly sent.
 */
function afterStepFailure(step: BrowserTaskStep, attempts: number, report: BrowserScriptRunReport): { then: 'retry' | BrowserTaskStepFailure; actionMayHaveRun: boolean } {
  const calls = report.runOperation.steps
  const actionMayHaveRun = !Array.isArray(calls) || calls.some(call => !call || typeof call !== 'object' ||
    typeof (call as { method?: unknown }).method !== 'string' || BROWSER_PAGE_MUTATING_CAPABILITY_NAMES.has((call as { method: string }).method))
  if (!actionMayHaveRun && attempts <= (step.retry ?? 0)) return { then: 'retry', actionMayHaveRun }
  return { then: step.onFail ?? 'stop', actionMayHaveRun }
}

/** Page steps that send exactly one existing Browser page function; the replay compiler checks it against the real page API. */
const PAGE_STEP_METHOD = { click: 'click', fill: 'fillInput', upload: 'uploadFiles', navigate: 'gotoUrl', press: 'pressKey', hover: 'hover', scroll: 'scroll', drag: 'drag', tap: 'tap', longPress: 'longPress', swipe: 'swipe', pinch: 'pinch' } as const satisfies
  Record<Exclude<BrowserTaskStep['kind'], 'checkpoint' | 'branch' | 'wait' | 'assert' | 'subflow' | 'extract'>, string>

function compileAssetStep(step: BrowserTaskStep, parameters: Record<string, string>, downloadPath?: string): string {
  if (!step.reviewed) throw new Error('Review the demonstrated step before executing it.')
  if (step.kind === 'extract') {
    if (!step.extraction || !step.url) throw new Error('A reviewed extraction needs its saved schema and page identity.')
    return `await extractStructured(${JSON.stringify(step.extraction)}); return { taskStepId: ${JSON.stringify(step.id)} }`
  }
  // Wait and assert only read the page; they need no element handle of their own.
  if (step.kind === 'wait' || step.kind === 'assert') return compileBrowserTaskCheck(step)
  if (step.kind === 'checkpoint' || step.kind === 'branch' || step.kind === 'subflow') throw new Error('Checkpoints, conditions and subflows keep their own continuation; they are not page calls.')
  if (step.kind !== 'navigate' && (!step.target || step.target.count !== 1 || step.target.ordinal !== 1)) {
    throw new Error('The task target is unknown or ambiguous. Locate the actual page target before executing it.')
  }
  if ((step.kind === 'drag' || step.kind === 'swipe') && (!step.destination || step.destination.count !== 1 || step.destination.ordinal !== 1)) throw new Error('The drag destination is unknown or ambiguous. Locate the actual drop target before executing it.')
  const replay: BrowserReplayStep = {
    ...((step.kind === 'drag' || step.kind === 'swipe') ? { destination: step.destination } : {}),
    method: downloadPath ? 'download' : PAGE_STEP_METHOD[step.kind],
    url: step.url, ...(step.target ? { target: step.target } : {}),
    args: downloadPath ? [{ path: downloadPath }] : step.kind === 'fill' ? [parameters[step.parameterKey!]] : step.kind === 'upload' ? [step.parameterKeys!.map(key => parameters[key])] : step.kind === 'navigate' ? [step.url]
      : step.kind === 'press' ? [step.key] : step.kind === 'longPress' ? [{ durationMs: step.durationMs ?? 600 }]
      : step.kind === 'pinch' ? [{ scale: step.scale ?? 2 }] : []
  }
  if (!step.url) throw new Error('The reviewed page identity is unavailable. Locate the intended page before executing this step.')
  return `${compileBrowserSteps({ url: step.kind === 'navigate' ? 'about:blank' : step.url, steps: [replay] })}\nreturn { taskStepId: ${JSON.stringify(step.id)} }`
}

function validateTaskSegment(version: BrowserTaskVersion, values: Record<string, string>, nextStep: number, mode?: 'run' | 'step', dialogTypes?: BrowserTaskAssetHost['dialogTypes']): void {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Provide the task parameters for this invocation.')
  const first = version.steps[nextStep]
  if (first?.kind === 'subflow' && !first.reviewed) throw new Error('Review the subflow and its fixed task version before executing it.')
  if (first?.kind === 'branch') {
    if (!first.reviewed || !first.branch) throw new Error('Review the condition and both paths before executing it.')
    return
  }
  for (const step of browserTaskSegment(version.steps, nextStep)) {
    if (step.dialog && dialogTypes && !dialogTypes.includes(step.dialog.type)) throw new AgentMuxError('This Browser host does not support the declared ' + step.dialog.type + ' dialog. No task action was sent; keep the definition for a compatible host.', 'HOST_CAPABILITY_UNAVAILABLE')
    for (const key of browserTaskStepParameterKeys(step)) {
      const definition = version.parameters.find(item => item.key === key)
      if (!definition || typeof values[key] !== 'string' || !values[key] || values[key]!.length > 16_384) {
        throw new Error(`A fresh value is required for parameter ${definition?.label ?? key}.`)
      }
    }
    // Use the same compiler guards before any action in this invocation. A later blocked step
    // must not leave earlier actions applied with a cursor that still appears to be running.
    compileAssetStep(step, values)
    if (mode === 'step') break
  }
}
function identity(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid task identity')
  return value
}
function text(value: string): string {
  if (typeof value !== 'string') throw new Error('Invalid task label')
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240)
}
function parameterKey(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('Parameter keys must start with a letter and contain only letters, digits, underscores or dashes.')
  return value
}
function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:', 'about:'].includes(url.protocol)) return ''
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    return url.toString().slice(0, 2_048)
  } catch { return '' }
}
function target(value: BrowserReplayTarget): BrowserReplayTarget {
  draftFields(value, ['role', 'name', 'ordinal', 'count'])
  if (!value || !value.role || typeof value.name !== 'string' || !Number.isSafeInteger(value.ordinal) || !Number.isSafeInteger(value.count) ||
      value.ordinal < 1 || value.count < value.ordinal) throw new Error('Invalid task target')
  return { role: text(value.role), name: text(value.name), ordinal: value.ordinal, count: value.count }
}
function revisionChanged(asset: BrowserTaskAsset, expectedRevision: number): AgentMuxError {
  return new AgentMuxError('Task draft changed; read browser task assets and edit the current revision.', 'BROWSER_TASK_REVISION_CONFLICT',
    JSON.stringify({ browserId: asset.browserId, assetId: asset.id, expectedRevision, currentRevision: asset.revision }))
}
function portableContent(value: unknown, strict = false): BrowserTaskContent {
  const definition = content(value)
  validateBrowserTaskPath(definition.steps)
  for (const step of definition.steps) {
    step.reviewed = false
    // A previous recording warning is local observation, never part of a portable definition.
    delete step.warning
  }
  for (const item of definition.completion?.criteria ?? []) if (item.kind === 'download-readable' &&
      (item.path.startsWith('/') || /^[a-z]:[\\/]/i.test(item.path) || item.path.split(/[\\/]/).some(part => part === '..'))) {
    throw new AgentMuxError('Portable download paths must stay relative to the target Workspace.', 'BROWSER_TASK_PORTABLE_INVALID')
  }
  if (strict && !isDeepStrictEqual(definition, value)) throw new AgentMuxError('Portable task definition must use the canonical exported fields with unreviewed steps.', 'BROWSER_TASK_PORTABLE_INVALID')
  return definition
}
function portableIntent(input: BrowserTaskImportInput): { request: BrowserTaskImportInput; binding: BrowserTaskPortableBinding; definition: BrowserTaskContent } {
  const request = parseBrowserTaskImportInput(input)
  const definition = portableContent(request.bundle.definition, true)
  const normalized = { ...request.bundle, definition }
  // Hash the complete normalized definition/parameter schema and exact origin, not display text.
  const bundleSha256 = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
  return { request, definition, binding: { kind: 'portable', createOperationId: request.createOperationId, assetId: request.assetId,
    browserId: request.browserId, bundleSha256, source: copy(request.bundle.source) } }
}
function creationAsset(document: BrowserTaskAssetDocument, request: BrowserTaskCreateInput | BrowserTaskPortableBinding): BrowserTaskAsset | undefined {
  const byOperation = document.assets.find(asset => asset.creation?.createOperationId === request.createOperationId)
  const byAsset = document.assets.find(asset => asset.id === request.assetId)
  if ((byOperation && !isDeepStrictEqual(byOperation.creation, request)) || (byAsset && !isDeepStrictEqual(byAsset.creation, request)) ||
      document.runs.some(run => run.id === request.assetId) || document.batches?.some(batch => batch.id === request.assetId)) {
    throw new AgentMuxError('This task creation operation or proposed asset identity belongs to another intent. Keep the original request and inspect it.', 'BROWSER_TASK_CREATE_CONFLICT')
  }
  return byOperation
}
function draftFields(value: unknown, fields: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) throw new Error('Invalid or unsupported task draft field')
}
function content(value: unknown): BrowserTaskContent {
  draftFields(value, ['name', 'url', 'steps', 'parameters', 'completion'])
  const raw = value as BrowserTaskContent
  if (!raw || !Array.isArray(raw.steps) || raw.steps.length > MAX_STEPS || !Array.isArray(raw.parameters) || raw.parameters.length > MAX_PARAMETERS) throw new Error('Invalid task draft or budget')
  if (typeof raw.name !== 'string' || typeof raw.url !== 'string') throw new Error('Invalid task name or URL')
  const parameters: BrowserTaskParameter[] = raw.parameters.map(parameter => {
    draftFields(parameter, ['key', 'label', 'secret'])
    if (typeof parameter.label !== 'string' || typeof parameter.secret !== 'boolean') throw new Error('Invalid task parameter')
    return { key: parameterKey(parameter.key), label: text(parameter.label), secret: parameter.secret }
  })
  if (new Set(parameters.map(item => item.key)).size !== parameters.length) throw new Error('Duplicate task parameter')
  const steps: BrowserTaskStep[] = raw.steps.map(step => {
    draftFields(step, ['id', 'kind', 'url', 'target', 'destination', 'durationMs', 'scale', 'parameterKey', 'parameterKeys', 'dialog', 'subflow', 'extraction', 'label', 'branch', 'wait', 'timeoutMs', 'assert', 'key', 'onFail', 'retry', 'nextStepId', 'reviewed', 'warning'])
    if (!step || !STEP_KINDS.includes(step.kind)) throw new Error('Invalid task step')
    if (typeof step.url !== 'string' || typeof step.reviewed !== 'boolean' || (step.label !== undefined && typeof step.label !== 'string') || (step.warning !== undefined && typeof step.warning !== 'string')) throw new Error('Invalid task step field')
    const url = safeUrl(step.url)
    if (step.parameterKeys !== undefined && (step.kind !== 'upload' || !Array.isArray(step.parameterKeys) || step.parameterKeys.length < 1 || step.parameterKeys.length > 4 || new Set(step.parameterKeys).size !== step.parameterKeys.length)) throw new Error('An upload declares 1–4 distinct fresh file parameters.')
    if (step.kind === 'upload' && !step.parameterKeys) throw new Error('An upload needs fresh Workspace file parameters.')
    if (step.dialog !== undefined) {
      draftFields(step.dialog, ['type', 'action', 'promptParameterKey'])
      if (step.kind !== 'click' || !['alert','confirm','prompt','beforeunload'].includes(step.dialog.type) || !['accept','dismiss'].includes(step.dialog.action)) throw new Error('A click dialog declares its expected type and answer.')
      if (step.dialog.type === 'beforeunload' && step.dialog.action === 'accept') throw new Error('Only the person can approve leaving a page with unsaved input.')
      if (step.dialog.promptParameterKey !== undefined && (step.dialog.type !== 'prompt' || step.dialog.action !== 'accept')) throw new Error('Only an accepted prompt takes a fresh answer parameter.')
    }
    if ((step.kind === 'extract') !== (step.extraction !== undefined)) throw new Error('An extraction schema belongs only to its extraction step.')
    if (step.kind === 'extract' && (step.target || step.destination || step.parameterKey || step.parameterKeys || step.dialog || step.subflow)) throw new Error('An extraction declares only its reviewed page and field schema.')
    if (step.extraction) draftFields(step.extraction, ['within', 'fields'])
    if (step.destination && step.kind !== 'drag' && step.kind !== 'swipe') throw new Error('Only drag and swipe steps have a destination.')
    if (step.durationMs !== undefined && (step.kind !== 'longPress' || !Number.isFinite(step.durationMs) || step.durationMs <= 0)) throw new Error('Only long press steps declare a positive finite contact duration.')
    if (step.scale !== undefined && (step.kind !== 'pinch' || !Number.isFinite(step.scale) || step.scale <= 0)) throw new Error('Only pinch steps declare a positive finite scale.')
    return { id: identity(step.id), kind: step.kind, url, ...(step.target ? { target: target(step.target) } : {}),
      ...(step.destination ? { destination: target(step.destination) } : {}),
      ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
      ...(step.scale !== undefined ? { scale: step.scale } : {}),
      ...(step.parameterKeys ? { parameterKeys: step.parameterKeys.map(parameterKey) } : {}),
      ...(step.dialog ? { dialog: { type: step.dialog.type, action: step.dialog.action, ...(step.dialog.promptParameterKey !== undefined ? { promptParameterKey: parameterKey(step.dialog.promptParameterKey) } : {}) } } : {}),
      ...(step.extraction !== undefined ? { extraction: parseBrowserStructuredOutputRequest(step.extraction) } : {}),
      ...(step.subflow !== undefined ? { subflow: subflowCall(step.subflow) } : {}),
      ...(step.parameterKey ? { parameterKey: parameterKey(step.parameterKey) } : {}), ...(step.label ? { label: text(step.label) } : {}),
      ...(step.branch !== undefined ? { branch: branch(step.branch) } : {}),
      ...(step.wait !== undefined ? { wait: waitCondition(step.wait) } : {}),
      ...(step.timeoutMs !== undefined ? { timeoutMs: waitTimeout(step.timeoutMs) } : {}),
      ...(step.assert !== undefined ? { assert: assertion(step.assert) } : {}),
      ...(step.key !== undefined ? { key: keyName(step.key) } : {}),
      ...(step.onFail !== undefined ? { onFail: stepFailure(step.onFail) } : {}),
      ...(step.retry !== undefined ? { retry: retryCount(step.retry) } : {}),
      ...(step.nextStepId !== undefined ? { nextStepId: step.nextStepId === null ? null : identity(step.nextStepId) } : {}),
      reviewed: step.reviewed === true, ...(step.warning ? { warning: text(step.warning) } : {}) }
  })
  if (new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('Duplicate task step identity')
  for (const step of steps) if (step.kind === 'branch' ? !step.branch : step.branch !== undefined) throw new Error('Condition declaration belongs only to a condition step.')
  for (const step of steps) {
    if ((step.kind === 'wait') !== (step.wait !== undefined) || (step.kind === 'wait') !== (step.timeoutMs !== undefined)) throw new Error('A wait step declares its condition and timeout; other steps cannot.')
    if ((step.kind === 'assert') !== (step.assert !== undefined)) throw new Error('An assert step declares its expected page fact; other steps cannot.')
    if ((step.kind === 'press') !== (step.key !== undefined)) throw new Error('A press step declares its key; other steps cannot.')
    if ((step.kind === 'checkpoint' || step.kind === 'branch' || step.kind === 'subflow') && (step.onFail !== undefined || step.retry !== undefined)) throw new Error('Checkpoints, conditions and subflows keep their own continuation; failure handling belongs to page steps.')
    if ((step.kind === 'subflow') !== (step.subflow !== undefined) || (step.kind === 'subflow' && (step.target || step.destination || step.parameterKey || step.parameterKeys || step.dialog))) throw new Error('A subflow step declares only its fixed callee version and iteration; page fields belong to page steps.')
  }
  for (const step of steps) {
    if (step.kind === 'fill' && !step.parameterKey) throw new Error('Task fill parameter is not defined')
    for (const key of browserTaskStepParameterKeys(step)) if (!parameters.some(parameter => parameter.key === key)) throw new Error('Task parameter is not defined')
  }
  let completion = raw.completion
  if (completion !== undefined) {
    if (!completion || typeof completion !== 'object' || Object.keys(completion).some(key => key !== 'criteria') || !Array.isArray(completion.criteria)) throw new Error('Invalid completion declaration')
    const criteria = completion.criteria
    for (const item of criteria) draftFields(item, item.kind === 'field-equals'
      ? ['kind', 'stepId', 'key', 'expected'] : item.kind === 'download-readable'
        ? ['kind', 'stepId', 'path'] : ['kind', 'checkpointId'])
    parseBrowserOutcomeCriteriaRequest({ criteria: criteria.map(item => item.kind === 'field-equals'
      ? { kind: item.kind, key: item.key, expected: item.expected } : item.kind === 'download-readable'
        ? { kind: item.kind, path: item.path } : item) })
    const downloads = criteria.filter(item => item.kind === 'download-readable')
    if (downloads.length > 1) throw new Error('Declare one download producer per version; field conditions and checkpoints may accompany it.')
    const producer = downloads[0]?.stepId ?? steps.find(isPageStep)?.id
    const producerIndex = steps.findIndex(step => step.id === producer)
    if (producerIndex < 0 || !isPageStep(steps[producerIndex]!)) throw new Error('Completion needs a real page producer before its checkpoint.')
    for (const item of criteria) {
      const step = item.kind === 'human-checkpoint' ? undefined : steps.find(step => step.id === item.stepId)
      if (item.kind === 'field-equals') {
        const field = step?.extraction?.fields.find(field => field.key === item.key)
        if (step?.kind !== 'extract' || !field || field.type !== typeof item.expected) throw new Error('A field condition needs its exact extraction step, key and declared type.')
      }
      if (item.kind === 'download-readable' && (step?.dialog !== undefined || step?.kind !== 'click' || !item.path.trim() || item.path.length > 512)) throw new Error('Download completion needs a reviewed click and a Workspace path.')
      if (item.kind === 'human-checkpoint' && !steps.some((step, index) => step.kind === 'checkpoint' && step.id === item.checkpointId && index > producerIndex)) throw new Error('Declare the checkpoint after its real producer.')
    }
    const keys = criteria.map(item => item.kind === 'field-equals' ? JSON.stringify([item.kind, item.stepId, item.key])
      : item.kind === 'download-readable' ? JSON.stringify([item.kind, item.stepId]) : JSON.stringify([item.kind, item.checkpointId]))
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate completion condition')
    completion = { criteria: criteria.map(item => item.kind === 'field-equals'
      ? { kind: item.kind, stepId: identity(item.stepId), key: item.key, expected: item.expected }
      : item.kind === 'download-readable' ? { kind: item.kind, stepId: identity(item.stepId), path: item.path }
        : { kind: item.kind, checkpointId: identity(item.checkpointId) }) }
  }
  return { name: text(raw.name), url: safeUrl(raw.url), steps, parameters, ...(completion ? { completion: copy(completion) } : {}) }
}
function normalizeDocument(value: unknown): BrowserTaskAssetDocument {
  const raw = value as BrowserTaskAssetDocument
  if (!raw || raw.version !== 1 || !Array.isArray(raw.assets) || !Array.isArray(raw.runs)) throw new Error('Invalid task asset document')
  const assets = raw.assets.map(asset => {
    if (!asset || !Number.isSafeInteger(asset.revision) || asset.revision < 1 || !Number.isFinite(asset.createdAt) || !Number.isFinite(asset.updatedAt) ||
        !Array.isArray(asset.versions)) throw new Error('Invalid task asset')
    const versions = asset.versions.map((version, index) => {
      if (version.version !== index + 1 || !Number.isFinite(version.savedAt)) throw new Error('Invalid task version')
      const { version: _version, savedAt: _savedAt, ...definition } = version
      return { ...content(definition), version: version.version, savedAt: version.savedAt }
    })
    const creation = asset.creation === undefined ? undefined : 'kind' in asset.creation ? parseBrowserTaskPortableBinding(asset.creation) : parseBrowserTaskCreateInput(asset.creation)
    const portable = creation && 'kind' in creation ? creation : undefined
    if (creation && (creation.assetId !== asset.id || creation.browserId !== asset.browserId ||
        ('sourceRecordingId' in creation && creation.sourceRecordingId !== asset.sourceRecordingId))) throw new Error('Task creation binding does not match its original asset')
    if (portable ? asset.sourceRecordingId !== undefined || !isDeepStrictEqual(asset.importedFrom, portable.source) : asset.importedFrom !== undefined) throw new Error('Task provenance does not match its original creation')
    return { id: identity(asset.id), browserId: identity(asset.browserId),
      ...(portable ? { importedFrom: copy(portable.source) } : { sourceRecordingId: identity(asset.sourceRecordingId!) }), revision: asset.revision,
      ...(creation ? { creation } : {}),
      draft: content(asset.draft), versions, createdAt: asset.createdAt, updatedAt: asset.updatedAt }
  })
  if (new Set(assets.map(asset => asset.id)).size !== assets.length) throw new Error('Duplicate task asset identity')
  const creations = assets.flatMap(asset => asset.creation ? [asset.creation.createOperationId] : [])
  if (new Set(creations).size !== creations.length) throw new Error('Duplicate task creation operation identity')
  const parallel = normalizeBrowserTaskParallelRecords(raw.parallel, assets)
  const runs = raw.runs.map(run => {
    const asset = assets.find(item => item.id === run.assetId)
    const version = asset?.versions.find(item => item.version === run.version)
    if (!run || !asset || !version || !Number.isSafeInteger(run.nextStep) || run.nextStep < 0 || run.nextStep > version.steps.length ||
        !['ready', 'running', 'waiting-human', 'completed', 'interrupted', 'failed', 'stopped'].includes(run.status) ||
        !Array.isArray(run.operationIds) || run.operationIds.length > MAX_STEPS || !Number.isFinite(run.startedAt) || !Number.isFinite(run.updatedAt)) throw new Error('Invalid task run')
    const humanCheckpoints = normalizeHumanCheckpoints(run, version)
    return { id: identity(run.id), assetId: asset.id, version: version.version, browserId: identity(run.browserId), nextStep: run.nextStep, status: run.status,
      operationIds: run.operationIds.map(identity), ...normalizePathFacts(run, version), ...normalizeCallFacts(run, version),
      ...(run.orchestration === undefined ? {} : { orchestration: parseBrowserTaskParallelBinding(run.orchestration) }),
      ...(run.pendingCheckpointId ? { pendingCheckpointId: identity(run.pendingCheckpointId) } : {}),
      ...(humanCheckpoints !== undefined ? { humanCheckpoints } : {}),
      ...(run.completionWarning ? { completionWarning: text(run.completionWarning) } : {}),
      ...(run.warning ? { warning: text(run.warning) } : {}), startedAt: run.startedAt, updatedAt: run.updatedAt }
  })
  if (new Set(runs.map(run => run.id)).size !== runs.length) throw new Error('Duplicate task run identity')
  for (const run of runs) {
    for (const call of run.calls ?? []) call.items.forEach((item, index) => {
      const child = item.runId ? runs.find(child => child.id === item.runId) : undefined
      if (item.runId && (!child || child.browserId !== run.browserId || child.assetId !== call.assetId || child.version !== call.version ||
          !isDeepStrictEqual(child.parent, { runId: run.id, stepId: call.stepId, itemId: item.id }) || (index < call.nextItem && child.status !== 'completed'))) throw new Error('Invalid subflow child binding')
    })
    if (run.parent && runs.find(parent => parent.id === run.parent!.runId)?.calls?.find(call => call.stepId === run.parent!.stepId)?.items.find(item => item.id === run.parent!.itemId)?.runId !== run.id) throw new Error('Subflow child has no original parent item')
    // Every stored child must reach a root within the same finite nesting contract.
    // Checking individual edges alone would accept a mutually bound cycle.
    let current = run
    const ancestors = new Set<string>([current.id])
    for (let depth = 1; current.parent; depth += 1) {
      const parent = runs.find(candidate => candidate.id === current.parent!.runId)
      if (!parent || depth >= BROWSER_TASK_SUBFLOW_MAX_DEPTH || ancestors.has(parent.id)) throw new Error('Invalid subflow parent chain')
      ancestors.add(parent.id); current = parent
    }
  }
  for (const run of runs) {
    let root = run
    while (root.parent) root = runs.find(candidate => candidate.id === root.parent!.runId)!
    const binding = root.orchestration, asset = assets.find(asset => asset.id === run.assetId)!
    if (run.parent && run.orchestration) throw new Error('A child task cannot declare a second parallel root')
    if (!binding) { if (asset.browserId !== run.browserId) throw new Error('Task execution changed its original Browser'); continue }
    const record = parallel.find(record => record.operationId === binding.operationId), target = record?.targets.find(target => target.id === binding.targetId)
    if (!record || !target || target.phase !== 'bound' || target.runId !== root.id || target.browserId !== root.browserId || run.browserId !== root.browserId ||
      asset.browserId !== record.browserId || binding.sourceBrowserId !== record.browserId || root.assetId !== record.assetId || root.version !== record.version) throw new Error('Parallel task execution is not bound to its original source and target')
  }
  for (const record of parallel) for (const target of record.targets) if (target.runId && !runs.some(run => run.id === target.runId && run.orchestration?.operationId === record.operationId && run.orchestration.targetId === target.id)) throw new Error('Parallel target lost its original root run')
  const selectedParallel = raw.selectedParallel ?? []
  if (!Array.isArray(selectedParallel) || new Set(selectedParallel.map(item => item.browserId)).size !== selectedParallel.length || selectedParallel.some(item => !parallel.some(record => record.browserId === item.browserId && record.operationId === item.operationId))) throw new Error('Invalid selected parallel execution')
  const selectedRuns = Array.isArray(raw.selectedRuns) &&
    new Set(raw.selectedRuns.map(item => item?.browserId)).size === raw.selectedRuns.length &&
    raw.selectedRuns.every(item => item && runs.some(run => run.id === item.runId && run.browserId === item.browserId))
    ? raw.selectedRuns.map(item => ({ browserId: identity(item.browserId), runId: identity(item.runId) })) : undefined
  const batches = raw.batches === undefined ? undefined : normalizeBatches(raw.batches, assets, runs)
  return { version: 1, assets, runs, ...(batches ? { batches } : {}), ...(selectedRuns ? { selectedRuns } : {}), parallel, selectedParallel }
}

/** Damaged/missing optional facts do not damage valid asset progress or manufacture an empty history. */
function normalizeHumanCheckpoints(run: BrowserTaskAssetRun, version: BrowserTaskVersion): BrowserTaskHumanCheckpoint[] | undefined {
  if (!Array.isArray(run.humanCheckpoints) || run.humanCheckpoints.length > version.steps.filter(step => step.kind === 'checkpoint').length) return undefined
  const facts: BrowserTaskHumanCheckpoint[] = []
  for (const fact of run.humanCheckpoints) {
    if (!fact || fact.runId !== run.id || fact.browserId !== run.browserId || fact.assetId !== run.assetId || fact.version !== run.version ||
        fact.origin !== 'trusted-ui' || fact.controlBefore !== 'human' || !Number.isSafeInteger(fact.pendingCursor) || fact.pendingCursor < 1 ||
        fact.pendingCursor > run.nextStep || version.steps[fact.pendingCursor - 1]?.kind !== 'checkpoint' ||
        version.steps[fact.pendingCursor - 1]?.id !== fact.checkpointId || !Number.isFinite(fact.confirmedAt) ||
        fact.confirmedAt < run.startedAt || fact.confirmedAt > run.updatedAt || facts.some(item => item.checkpointId === fact.checkpointId)) return undefined
    facts.push({ runId: run.id, browserId: run.browserId, assetId: run.assetId, version: run.version, checkpointId: fact.checkpointId,
      pendingCursor: fact.pendingCursor, origin: 'trusted-ui', controlBefore: 'human', confirmedAt: fact.confirmedAt })
  }
  return facts
}

/** Subflow targets name one exact retained version; never latest, a name or a page result. */
function subflowCall(value: BrowserTaskSubflow): BrowserTaskSubflow {
  draftFields(value, ['target', 'iteration'])
  if (value.iteration !== 'once' && value.iteration !== 'each') throw new Error('A subflow runs once or each explicit item.')
  const raw = value.target as Record<string, unknown> | undefined
  if (raw?.kind === 'local') {
    draftFields(raw, ['kind', 'assetId', 'version'])
    return { target: { kind: 'local', assetId: identity(raw.assetId as string), version: versionNumber(raw.version) }, iteration: value.iteration }
  }
  if (raw?.kind === 'imported') {
    draftFields(raw, ['kind', 'source'])
    draftFields(raw.source, ['assetId', 'version'])
    const source = raw.source as { assetId: string; version: unknown }
    return { target: { kind: 'imported', source: { assetId: identity(source.assetId), version: versionNumber(source.version) } }, iteration: value.iteration }
  }
  throw new Error('A subflow names one exact local task version.')
}
function versionNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('A subflow names one exact retained version number.')
  return value as number
}
/** The one producer rule shared by completion declarations and Main outcome registration. */
export function isPageStep(step: BrowserTaskStep): boolean { return step.kind !== 'checkpoint' && step.kind !== 'branch' && step.kind !== 'subflow' }
function branch(value: NonNullable<BrowserTaskStep['branch']>): NonNullable<BrowserTaskStep['branch']> {
  draftFields(value, ['condition', 'onTrue', 'onFalse'])
  if (!value || !value.condition || !['page-url-is', 'element-present'].includes(value.condition.kind) ||
      (value.onTrue !== null && typeof value.onTrue !== 'string') || (value.onFalse !== null && typeof value.onFalse !== 'string')) throw new Error('Invalid task condition declaration')
  draftFields(value.condition, value.condition.kind === 'page-url-is' ? ['kind', 'url'] : ['kind', 'target'])
  if (value.condition.kind === 'element-present') draftFields(value.condition.target, ['role', 'name'])
  const condition = value.condition.kind === 'page-url-is'
    ? { kind: value.condition.kind, url: safeUrl(value.condition.url) }
    : { kind: value.condition.kind, target: { role: text(value.condition.target.role), name: text(value.condition.target.name) } }
  if (condition.kind === 'page-url-is' ? !condition.url : !condition.target.role) throw new Error('Condition needs a reviewed page URL or a semantic element role.')
  return { condition, onTrue: value.onTrue === null ? null : identity(value.onTrue), onFalse: value.onFalse === null ? null : identity(value.onFalse) }
}
function semanticTarget(value: BrowserTaskSemanticTarget): BrowserTaskSemanticTarget {
  draftFields(value, ['role', 'name'])
  if (!value || typeof value.role !== 'string' || typeof value.name !== 'string' || !value.role.trim()) throw new Error('A page check needs a semantic element role and name.')
  return { role: text(value.role), name: text(value.name) }
}
function checkUrl(value: string): string {
  const url = safeUrl(value)
  if (!url) throw new Error('A page check needs a reviewed http, https or about URL.')
  return url
}
function waitCondition(value: BrowserTaskWait): BrowserTaskWait {
  if (!value || typeof value !== 'object') throw new Error('Invalid wait condition')
  draftFields(value, value.kind === 'element-present' ? ['kind', 'target'] : ['kind', 'url'])
  if (value.kind === 'element-present') return { kind: value.kind, target: semanticTarget(value.target) }
  if (value.kind === 'url-is') return { kind: value.kind, url: checkUrl(value.url) }
  throw new Error('Invalid wait condition')
}
function waitTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > BROWSER_TASK_WAIT_MAX_MILLIS) throw new Error(`Wait timeout must be 1-${BROWSER_TASK_WAIT_MAX_MILLIS} ms.`)
  return value
}
function assertion(value: BrowserTaskAssertion): BrowserTaskAssertion {
  if (!value || typeof value !== 'object') throw new Error('Invalid assertion')
  draftFields(value, value.kind === 'text-present' ? ['kind', 'text'] : value.kind === 'url-is' ? ['kind', 'url'] : ['kind', 'target'])
  if (value.kind === 'element-present' || value.kind === 'element-absent') return { kind: value.kind, target: semanticTarget(value.target) }
  if (value.kind === 'url-is') return { kind: value.kind, url: checkUrl(value.url) }
  if (value.kind === 'text-present' && typeof value.text === 'string' && value.text.trim()) return { kind: value.kind, text: text(value.text) }
  throw new Error('Invalid assertion')
}
function keyName(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 32 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('A press step needs one key name.')
  return value
}
function stepFailure(value: BrowserTaskStepFailure): BrowserTaskStepFailure {
  if (value === 'stop' || value === 'continue') return value
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.goto === 'string') return { goto: identity(value.goto) }
  throw new Error('Step failure handling is stop, continue or goto a later step.')
}
function retryCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > BROWSER_TASK_MAX_RETRIES) throw new Error(`Step retry must be 0-${BROWSER_TASK_MAX_RETRIES}.`)
  return value
}
function recordStepOperation(run: BrowserTaskAssetRun, stepId: string, operationId: string): void {
  const id = identity(operationId)
  if (!run.operationIds.includes(id)) run.operationIds.push(id)
  if (!run.stepExecutions?.some(item => item.operationId === id)) run.stepExecutions = [...(run.stepExecutions ?? []), { stepId, operationId: id }]
}
function normalizePathFacts(run: BrowserTaskAssetRun, version: BrowserTaskVersion): Pick<BrowserTaskAssetRun, 'stepExecutions' | 'branchDecisions' | 'failedSteps' | 'executedMillis'> {
  const facts: Pick<BrowserTaskAssetRun, 'stepExecutions' | 'branchDecisions' | 'failedSteps' | 'executedMillis'> = {}
  if (run.stepExecutions !== undefined) {
    if (!Array.isArray(run.stepExecutions) || run.stepExecutions.length > MAX_STEPS ||
        new Set(run.stepExecutions.map(item => item.operationId)).size !== run.stepExecutions.length ||
        run.stepExecutions.some(item => !version.steps.some(step => step.id === item.stepId) || !run.operationIds.includes(item.operationId))) throw new Error('Invalid task executed path')
    facts.stepExecutions = run.stepExecutions.map(item => ({ stepId: identity(item.stepId), operationId: identity(item.operationId) }))
  }
  if (run.branchDecisions !== undefined) {
    if (!Array.isArray(run.branchDecisions) || run.branchDecisions.length > 16 || new Set(run.branchDecisions.map(item => item.stepId)).size !== run.branchDecisions.length) throw new Error('Invalid task condition facts')
    facts.branchDecisions = run.branchDecisions.map(item => {
      const step = version.steps.find(step => step.id === item.stepId && step.kind === 'branch')
      const expected = item.result === 'true' ? step?.branch?.onTrue : item.result === 'false' ? step?.branch?.onFalse : undefined
      if (!step || !['true', 'false', 'unknown'].includes(item.result) || !run.operationIds.includes(item.operationId) ||
          item.nextStepId !== expected || !run.stepExecutions?.some(fact => fact.stepId === step.id && fact.operationId === item.operationId)) throw new Error('Invalid task condition path binding')
      return { stepId: identity(item.stepId), operationId: identity(item.operationId), navigationId: typeof item.navigationId === 'string' ? item.navigationId.slice(0, 128) : '',
        result: item.result, ...(expected === undefined ? {} : { nextStepId: expected }) }
    })
  }
  if (run.failedSteps !== undefined) {
    if (!Array.isArray(run.failedSteps) || run.failedSteps.length > MAX_STEPS || new Set(run.failedSteps.map(item => item.stepId)).size !== run.failedSteps.length ||
        run.failedSteps.some(item => !version.steps.some(step => step.id === item.stepId && step.kind !== 'checkpoint' && step.kind !== 'branch') ||
          !run.stepExecutions?.some(fact => fact.stepId === item.stepId && fact.operationId === item.operationId))) throw new Error('Invalid task failed step facts')
    facts.failedSteps = run.failedSteps.map(item => ({ stepId: identity(item.stepId), operationId: identity(item.operationId) }))
  }
  if (run.executedMillis !== undefined) {
    if (!Number.isFinite(run.executedMillis) || run.executedMillis < 0) throw new Error('Invalid task execution time budget')
    facts.executedMillis = run.executedMillis
  }
  return facts
}

function normalizeCallFacts(run: BrowserTaskAssetRun, version: BrowserTaskVersion): Pick<BrowserTaskAssetRun, 'parent' | 'calls'> {
  const facts: Pick<BrowserTaskAssetRun, 'parent' | 'calls'> = {}
  if (run.parent !== undefined) {
    draftFields(run.parent, ['runId', 'stepId', 'itemId'])
    facts.parent = { runId: identity(run.parent.runId), stepId: identity(run.parent.stepId), itemId: identity(run.parent.itemId) }
  }
  if (run.calls !== undefined) {
    if (!Array.isArray(run.calls) || new Set(run.calls.map(call => call?.stepId)).size !== run.calls.length) throw new Error('Invalid subflow call facts')
    facts.calls = run.calls.map(call => {
      draftFields(call, ['stepId', 'assetId', 'version', 'nextItem', 'items'])
      const step = version.steps.find(step => step.id === call.stepId && step.kind === 'subflow')
      const target = step?.subflow?.target
      if (target?.kind !== 'local' || target.assetId !== call.assetId || target.version !== call.version || !Array.isArray(call.items) || call.items.length < 1 ||
          call.items.length > BROWSER_TASK_SUBFLOW_MAX_ITEMS || (step!.subflow!.iteration === 'once' && call.items.length !== 1) ||
          new Set(call.items.map(item => item?.id)).size !== call.items.length || !Number.isSafeInteger(call.nextItem) || call.nextItem < 0 || call.nextItem > call.items.length) throw new Error('Invalid subflow call facts')
      return { stepId: call.stepId, assetId: call.assetId, version: call.version, nextItem: call.nextItem,
        items: call.items.map(item => { draftFields(item, ['id', 'runId']); return { id: identity(item.id), ...(item.runId === undefined ? {} : { runId: identity(item.runId) }) } }) }
    })
  }
  return facts
}

function normalizeBatches(value: BrowserTaskBatchRun[], assets: BrowserTaskAsset[], runs: BrowserTaskAssetRun[]): BrowserTaskBatchRun[] {
  if (!Array.isArray(value) || new Set(value.map(batch => batch.id)).size !== value.length) throw new Error('Invalid batch progress collection')
  return value.map(batch => {
    const asset = assets.find(asset => asset.id === batch.assetId && asset.browserId === batch.browserId)
    if (!asset?.versions.some(version => version.version === batch.version) || !Array.isArray(batch.items) || batch.items.length < 1 || batch.items.length > 16 ||
        new Set(batch.items.map(item => item.id)).size !== batch.items.length || !Number.isSafeInteger(batch.nextItem) || batch.nextItem < 0 || batch.nextItem > batch.items.length ||
        !['ready', 'running', 'waiting-human', 'completed', 'interrupted', 'failed', 'stopped'].includes(batch.status) ||
        !Number.isSafeInteger(batch.operationCount) || batch.operationCount < 0 || batch.operationCount > 256 || !Number.isFinite(batch.executedMillis) || batch.executedMillis < 0 ||
        !Number.isFinite(batch.startedAt) || !Number.isFinite(batch.updatedAt) || batch.updatedAt < batch.startedAt) throw new Error('Invalid batch progress')
    const items = batch.items.map((item, index) => {
      const run = item.runId ? runs.find(run => run.id === item.runId && run.browserId === batch.browserId && run.assetId === batch.assetId && run.version === batch.version) : undefined
      if ((item.runId && (!run || index > batch.nextItem)) || (index < batch.nextItem && run?.status !== 'completed')) throw new Error('Invalid original batch item run')
      return { id: identity(item.id), ...(run ? { runId: run.id } : {}) }
    })
    if (new Set(items.flatMap(item => item.runId ? [item.runId] : [])).size !== items.filter(item => item.runId).length || (batch.status === 'completed' && batch.nextItem !== items.length)) throw new Error('Invalid batch item execution identity')
    const related = items.flatMap(item => { const run = runs.find(run => run.id === item.runId); return run ? [run] : [] })
    if (batch.operationCount !== related.reduce((sum, run) => sum + run.operationIds.length, 0) ||
        batch.executedMillis !== related.reduce((sum, run) => sum + (run.executedMillis ?? 0), 0)) throw new Error('Batch costs are not bound to original item runs')
    return { id: identity(batch.id), browserId: asset.browserId, assetId: asset.id, version: batch.version, items, nextItem: batch.nextItem, status: batch.status,
      operationCount: batch.operationCount, executedMillis: batch.executedMillis, startedAt: batch.startedAt, updatedAt: batch.updatedAt, ...(batch.warning ? { warning: text(batch.warning) } : {}) }
  })
}

function parallelIntent(record: BrowserTaskParallelRecord) {
  return { browserId: record.browserId, assetId: record.assetId, version: record.version, requestedConcurrency: record.requestedConcurrency, targets: record.targets.map(({ id, browserId, profileId }) => ({ id, browserId, profileId })) }
}
