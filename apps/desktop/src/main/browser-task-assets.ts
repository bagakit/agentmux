import { browserTaskStepParameterKeys } from '../shared/browser-task-assets.js'
import { createHash } from 'node:crypto'
import { parseBrowserTaskImportInput, parseBrowserTaskPortableBundle, parseBrowserTaskPortableBinding, type BrowserTaskImportInput, type BrowserTaskPortableBinding, type BrowserTaskPortableBundle } from '@agentmux/core/control'
import { mintObjectId } from '@agentmux/core/object-id'
import { AgentMuxError } from '@agentmux/core'
import type { NameChangeAudit } from './name-change-audit.js'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseBrowserTaskCreateInput, type BrowserTaskCreateInput, type BrowserTaskCreateStatus } from '../shared/browser-task-creation.js'
import { BROWSER_PAGE_MUTATING_CAPABILITY_NAMES, durableWriteFile } from '@agentmux/core'
import type { BrowserDemonstrationDraft } from '../shared/browser-demonstration.js'
import type { BrowserReplayStep, BrowserReplayTarget } from '@agentmux/browser/model/browser-operation'
import type { BrowserScriptRunReport } from '../shared/contracts.js'
import type {
  BrowserTaskAsset, BrowserTaskAssetDocument, BrowserTaskAssetRun, BrowserTaskAssetRunInput,
  BrowserTaskAssetState, BrowserTaskContent, BrowserTaskParameter, BrowserTaskStep, BrowserTaskVersion,
  BrowserTaskHumanCheckpoint, BrowserTaskHumanCheckpointRead, BrowserTaskHumanCheckpointSaved, BrowserTaskRunIdentity, BrowserTaskStepExecution, BrowserTaskBatchInput, BrowserTaskBatchRun,
  BrowserTaskAssertion, BrowserTaskSemanticTarget, BrowserTaskStepFailure, BrowserTaskWait
} from '../shared/browser-task-assets.js'
import { compileBrowserSteps } from './browser-replay-compiler.js'
import { compileBrowserTaskCheck } from './browser-task-check.js'
import { parseBrowserOutcomeCriteriaRequest } from '@agentmux/browser/model/browser-outcome-criteria'
import { browserTaskNextIndex, browserTaskSegment, browserTaskReachedCheckpoints, validateBrowserTaskPath, BROWSER_TASK_MAX_EXECUTED_MILLIS, BROWSER_TASK_MAX_OPERATIONS, BROWSER_TASK_MAX_RETRIES, BROWSER_TASK_WAIT_MAX_MILLIS } from '../shared/browser-task-path.js'
import { compileBrowserTaskBranchObservation, evaluateBrowserTaskBranch } from './browser-task-branch.js'
import { validateBrowserTaskBatchValues, BROWSER_TASK_BATCH_MAX_OPERATIONS, BROWSER_TASK_BATCH_MAX_MILLIS, BROWSER_TASK_BATCH_MAX_BYTES, type BrowserTaskBatchHost, type BrowserTaskRunBudget } from './browser-task-batch.js'

export const BROWSER_TASK_ASSETS_FILE = 'browser-task-assets.json'
const MAX_STEPS = 128
const MAX_PARAMETERS = 32
const STEP_KINDS: readonly BrowserTaskStep['kind'][] = ['click', 'fill', 'upload', 'navigate', 'checkpoint', 'branch', 'wait', 'assert', 'press', 'hover', 'scroll', 'drag', 'tap', 'longPress', 'swipe', 'pinch']
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
    await durableWriteFile(this.path, source)
  }
}

/** Main is the one Browser control owner. This Client keeps progress, never a second approval bit. */
export interface BrowserTaskAssetHost {
  /** Original host capability, independent of review, permissions and page text. Absent is unknown. */
  dialogTypes?: readonly import('@agentmux/core').AgentMuxBrowserDialogType[]
  /** Bind the actual cursor before its first durable/public projection. */
  onRunPrepared(runId: string): void
  runScript(browserId: string, script: string, execution: BrowserTaskStepExecution): Promise<BrowserScriptRunReport>
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
  private activeBrowsers = new Map<string, { batchId?: string }>()
  private readonly listeners = new Set<(browserId: string) => void | Promise<void>>()
  private readonly now: () => number
  private readonly id: () => string
  constructor(private readonly store: BrowserTaskAssetStore, private readonly options: { now?: () => number; id?: () => string; nameAudit?: NameChangeAudit } = {}) {
    this.now = options.now ?? Date.now; this.id = options.id ?? mintObjectId
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
    return copy({
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
    return selected?.runId === execution.runId && !!bound && bound.run.status === 'running' &&
      bound.version.steps[bound.run.nextStep]?.id === execution.stepId && bound.run.operationIds.includes(operationId)
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
        ...(step.nextStepId === undefined ? {} : { nextStepId: remap(step.nextStepId) }),
        ...(typeof step.onFail === 'object' ? { onFail: { goto: remap(step.onFail.goto)! } } : {}),
        ...(step.branch ? { branch: { ...step.branch, onTrue: remap(step.branch.onTrue), onFalse: remap(step.branch.onFalse) } } : {}) }))
      const completion = definition.completion && { criteria: definition.completion.criteria.map(item => item.kind === 'download-readable'
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
      if (run.status !== 'completed' && run.status !== 'interrupted') {
        run.status = 'stopped'; run.warning = 'Task stopped. Completed steps remain; inspect the page before another run.'
        await this.updateRun(run)
      }
      return copy(this.projectRun(run))
    })
  }

  /** Used by runBrowserTaskAsset. Caller is the trusted Client action; continuation has no Agent API. */
  async run(input: BrowserTaskAssetRunInput, host: BrowserTaskAssetHost, budget?: BrowserTaskRunBudget): Promise<BrowserTaskAssetRun> {
    await this.ready()
    const browserId = identity(input.browserId)
    const parameters = { ...input.parameters }
    if (this.isBrowserExecuting(browserId, budget?.batchId)) throw new Error('A task is already executing in this Browser.')
    const ownsLease = !this.activeBrowsers.has(browserId)
    if (ownsLease) this.activeBrowsers.set(browserId, {})
    let run: BrowserTaskAssetRun | undefined
    try {
      const prepared = await this.change(async () => {
        const asset = this.requireAsset(input.assetId)
        if (asset.browserId !== browserId) throw new Error('This task asset belongs to another Browser.')
        const version = asset.versions.find(item => item.version === input.version)
        if (!version) throw new Error('Task version is unavailable. Select a retained version before running.')
        const existing = input.runId ? this.document.runs.find(item => item.id === input.runId) : undefined
        if (input.runId && !existing) throw new Error('Task run is unavailable; it was not restarted.')
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
        const batch = budget ? this.document.batches?.find(batch => batch.id === budget.batchId && batch.browserId === browserId && batch.assetId === asset.id && batch.version === version.version && batch.status === 'running') : undefined
        const batchItem = batch?.items[batch.nextItem]
        if (budget && (!batchItem || (batchItem.runId && batchItem.runId !== existing?.id) || this.activeBrowsers.get(browserId)?.batchId !== budget.batchId)) throw new Error('The original batch item changed before its task was prepared.')
        const next = existing ?? {
          id: this.allocateId(), assetId: asset.id, version: version.version, browserId,
          nextStep: 0, status: 'ready' as const, operationIds: [], stepExecutions: [], branchDecisions: [], executedMillis: 0, humanCheckpoints: [], startedAt: this.now(), updatedAt: this.now()
        }
        if (!existing) {
          this.document.runs.push(next)
        }
        if (batchItem) batchItem.runId = next.id
        host.onRunPrepared(next.id)
        this.document.selectedRuns = [...(this.document.selectedRuns ?? []).filter(item => item.browserId !== browserId), { browserId, runId: next.id }]
        delete next.pendingCheckpointId; delete next.warning
        next.status = 'ready'
        await this.persist(next.browserId)
        return { run: next, version: copy(version) }
      })
      run = prepared.run
      const version = prepared.version
      let actions = 0
      // Script failures of the step at this cursor index in this invocation; a forward cursor never revisits it.
      let failed = { index: -1, count: 0 }
      const previousDecision = run.branchDecisions?.find(fact => fact.result !== 'unknown' && fact.nextStepId === version.steps[run!.nextStep]?.id && run!.stepExecutions?.at(-1)?.operationId === fact.operationId)
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
      while (run.nextStep < version.steps.length) {
        if (run.status === 'stopped') break
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
        if (run.operationIds.length >= Math.min(BROWSER_TASK_MAX_OPERATIONS, budget?.operations ?? BROWSER_TASK_MAX_OPERATIONS) || (run.executedMillis ?? 0) >= Math.min(BROWSER_TASK_MAX_EXECUTED_MILLIS, budget?.timeMillis ?? BROWSER_TASK_MAX_EXECUTED_MILLIS)) {
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
        const execution: BrowserTaskStepExecution = { browserId, runId: run.id, assetId: run.assetId, version: run.version, stepId: step.id, ...(selectedByBranch ? { expectedNavigationId: selectedByBranch.navigationId } : {}) }
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
        if (selectedByBranch && host.navigationId?.(browserId) !== selectedByBranch.navigationId) return await invalidateSelection()
        const branchIndex = run.nextStep
        let report: BrowserScriptRunReport, retry = false
        const callStartedAt = performance.now()
        execution.deadlineMillis = callStartedAt + Math.min(BROWSER_TASK_MAX_EXECUTED_MILLIS, budget?.timeMillis ?? BROWSER_TASK_MAX_EXECUTED_MILLIS) - (run.executedMillis ?? 0)
        try { report = await host.runScript(browserId, script, execution) }
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
      if (ownsLease) this.activeBrowsers.delete(browserId)
    }
  }

  /** The original execution lease also covers batch preparation and the gaps between its items. */
  isBrowserExecuting(browserId: string, batchId?: string): boolean {
    const active = this.activeBrowsers.get(browserId)
    return !!active && (batchId === undefined || active.batchId !== batchId)
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

  private requireAsset(id: string): BrowserTaskAsset {
    const asset = this.document.assets.find(item => item.id === id)
    if (!asset) throw new Error('Task asset is unavailable; existing Browser work was retained.')
    return asset
  }
  private exactRun(tuple: BrowserTaskRunIdentity): { run: BrowserTaskAssetRun; version: BrowserTaskVersion } | null {
    const run = this.document.runs.find(item => item.id === tuple.runId)
    const asset = this.document.assets.find(item => item.id === tuple.assetId)
    const version = asset?.versions.find(item => item.version === tuple.version)
    if (!run || !asset || !version || run.browserId !== tuple.browserId || asset.browserId !== tuple.browserId ||
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
    try { await this.store.save(copy(this.document)); this.warning = undefined }
    catch {
      this.warning = 'Task assets could not be saved. The live draft and previous Browser work remain; restore storage before executing another step.'
      throw new Error(this.warning)
    } finally { if (browserId) this.notify(browserId) }
  }
  private notify(browserId: string): void {
    for (const listener of [...this.listeners]) {
      try { void Promise.resolve(listener(browserId)).catch(() => {}) }
      catch { /* A failed projection cannot change the durable action/cursor fact. */ }
    }
  }
  private async load(): Promise<void> {
    try {
      this.document = normalizeDocument(await this.store.load() ?? { version: 1, assets: [], runs: [] })
      if (this.interruptRestoredExecutions()) await this.persist()
    } catch {
      this.loadUnavailable = true
      this.warning = 'Task assets could not be restored. The existing file was retained; restore storage to review it. Browser and Agent work remain available.'
    }
  }
  /** Storage becoming readable later still restores execution facts through the same owner. */
  private interruptRestoredExecutions(): boolean {
    let changed = false
    for (const run of this.document.runs) if (run.status === 'running') {
      run.status = 'interrupted'; run.warning = 'Restart interrupted the Browser step. Inspect the page and its operation history; it was not automatically replayed.'
      run.updatedAt = this.now(); changed = true
    }
    for (const batch of this.document.batches ?? []) if (batch.status === 'running') {
      batch.status = 'interrupted'; batch.warning = 'Restart interrupted this batch. Original item runs remain; uncertain actions and remaining items were not replayed.'; batch.updatedAt = this.now(); changed = true
    }
    return changed
  }
}

export async function runBrowserTaskAsset(assets: BrowserTaskAssets, input: BrowserTaskAssetRunInput, host: BrowserTaskAssetHost, budget?: BrowserTaskRunBudget): Promise<BrowserTaskAssetRun> {
  return await assets.run(input, host, budget)
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
  Record<Exclude<BrowserTaskStep['kind'], 'checkpoint' | 'branch' | 'wait' | 'assert'>, string>

function compileAssetStep(step: BrowserTaskStep, parameters: Record<string, string>, downloadPath?: string): string {
  if (!step.reviewed) throw new Error('Review the demonstrated step before executing it.')
  // Wait and assert only read the page; they need no element handle of their own.
  if (step.kind === 'wait' || step.kind === 'assert') return compileBrowserTaskCheck(step)
  if (step.kind === 'checkpoint' || step.kind === 'branch') throw new Error('Checkpoints and conditions keep their own continuation; they are not page calls.')
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
    draftFields(step, ['id', 'kind', 'url', 'target', 'destination', 'durationMs', 'scale', 'parameterKey', 'parameterKeys', 'dialog', 'label', 'branch', 'wait', 'timeoutMs', 'assert', 'key', 'onFail', 'retry', 'nextStepId', 'reviewed', 'warning'])
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
    if (step.destination && step.kind !== 'drag' && step.kind !== 'swipe') throw new Error('Only drag and swipe steps have a destination.')
    if (step.durationMs !== undefined && (step.kind !== 'longPress' || !Number.isFinite(step.durationMs) || step.durationMs <= 0)) throw new Error('Only long press steps declare a positive finite contact duration.')
    if (step.scale !== undefined && (step.kind !== 'pinch' || !Number.isFinite(step.scale) || step.scale <= 0)) throw new Error('Only pinch steps declare a positive finite scale.')
    return { id: identity(step.id), kind: step.kind, url, ...(step.target ? { target: target(step.target) } : {}),
      ...(step.destination ? { destination: target(step.destination) } : {}),
      ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
      ...(step.scale !== undefined ? { scale: step.scale } : {}),
      ...(step.parameterKeys ? { parameterKeys: step.parameterKeys.map(parameterKey) } : {}),
      ...(step.dialog ? { dialog: { type: step.dialog.type, action: step.dialog.action, ...(step.dialog.promptParameterKey !== undefined ? { promptParameterKey: parameterKey(step.dialog.promptParameterKey) } : {}) } } : {}),
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
    if ((step.kind === 'checkpoint' || step.kind === 'branch') && (step.onFail !== undefined || step.retry !== undefined)) throw new Error('Checkpoints and conditions keep their own continuation; failure handling belongs to page steps.')
  }
  for (const step of steps) {
    if (step.kind === 'fill' && !step.parameterKey) throw new Error('Task fill parameter is not defined')
    for (const key of browserTaskStepParameterKeys(step)) if (!parameters.some(parameter => parameter.key === key)) throw new Error('Task parameter is not defined')
  }
  let completion = raw.completion
  if (completion !== undefined) {
    if (!completion || typeof completion !== 'object' || Object.keys(completion).some(key => key !== 'criteria') || !Array.isArray(completion.criteria)) throw new Error('Invalid completion declaration')
    const criteria = completion.criteria
    for (const item of criteria) {
      if (item?.kind === 'download-readable' && Object.keys(item).some(key => !['kind', 'stepId', 'path'].includes(key))) throw new Error('Unknown download completion field')
    }
    parseBrowserOutcomeCriteriaRequest({ criteria: criteria.map(item => item.kind === 'download-readable'
      ? { kind: item.kind, path: item.path } : item) })
    const downloads = criteria.filter(item => item.kind === 'download-readable')
    if (downloads.length > 1) throw new Error('Declare one download producer per version; checkpoints may accompany it.')
    const producer = downloads[0]?.stepId ?? steps.find(step => step.kind !== 'checkpoint' && step.kind !== 'branch')?.id
    const producerIndex = steps.findIndex(step => step.id === producer)
    if (producerIndex < 0 || (steps[producerIndex]?.kind === 'checkpoint' || steps[producerIndex]?.kind === 'branch')) throw new Error('Completion needs a real page producer before its checkpoint.')
    for (const item of criteria) {
      if (item.kind === 'download-readable' && (steps[producerIndex]?.dialog !== undefined || steps[producerIndex]?.kind !== 'click' || !item.path.trim() || item.path.length > 512)) throw new Error('Download completion needs a reviewed click and a Workspace path.')
      if (item.kind === 'human-checkpoint' && !steps.some((step, index) => step.kind === 'checkpoint' && step.id === item.checkpointId && index > producerIndex)) throw new Error('Declare the checkpoint after its real producer.')
    }
    if (new Set(criteria.map(item => item.kind === 'download-readable' ? item.stepId : item.checkpointId)).size !== criteria.length) throw new Error('Duplicate completion condition')
    completion = { criteria: criteria.map(item => item.kind === 'download-readable'
      ? { kind: item.kind, stepId: identity(item.stepId), path: item.path }
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
  const runs = raw.runs.map(run => {
    const asset = assets.find(item => item.id === run.assetId)
    const version = asset?.versions.find(item => item.version === run.version)
    if (!run || !asset || !version || asset.browserId !== run.browserId || !Number.isSafeInteger(run.nextStep) || run.nextStep < 0 || run.nextStep > version.steps.length ||
        !['ready', 'running', 'waiting-human', 'completed', 'interrupted', 'failed', 'stopped'].includes(run.status) ||
        !Array.isArray(run.operationIds) || run.operationIds.length > MAX_STEPS || !Number.isFinite(run.startedAt) || !Number.isFinite(run.updatedAt)) throw new Error('Invalid task run')
    const humanCheckpoints = normalizeHumanCheckpoints(run, version)
    return { id: identity(run.id), assetId: asset.id, version: version.version, browserId: asset.browserId, nextStep: run.nextStep, status: run.status,
      operationIds: run.operationIds.map(identity), ...normalizePathFacts(run, version), ...(run.pendingCheckpointId ? { pendingCheckpointId: identity(run.pendingCheckpointId) } : {}),
      ...(humanCheckpoints !== undefined ? { humanCheckpoints } : {}),
      ...(run.completionWarning ? { completionWarning: text(run.completionWarning) } : {}),
      ...(run.warning ? { warning: text(run.warning) } : {}), startedAt: run.startedAt, updatedAt: run.updatedAt }
  })
  if (new Set(runs.map(run => run.id)).size !== runs.length) throw new Error('Duplicate task run identity')
  const selectedRuns = Array.isArray(raw.selectedRuns) &&
    new Set(raw.selectedRuns.map(item => item?.browserId)).size === raw.selectedRuns.length &&
    raw.selectedRuns.every(item => item && runs.some(run => run.id === item.runId && run.browserId === item.browserId))
    ? raw.selectedRuns.map(item => ({ browserId: identity(item.browserId), runId: identity(item.runId) })) : undefined
  const batches = raw.batches === undefined ? undefined : normalizeBatches(raw.batches, assets, runs)
  return { version: 1, assets, runs, ...(batches ? { batches } : {}), ...(selectedRuns ? { selectedRuns } : {}) }
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
