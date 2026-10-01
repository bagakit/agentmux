import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { durableWriteFile } from '@agentmux/core'
import type { BrowserDemonstrationDraft } from '../shared/browser-demonstration.js'
import type { BrowserReplayStep, BrowserReplayTarget } from '../shared/browser-operation.js'
import type { BrowserScriptRunReport } from '../shared/contracts.js'
import type {
  BrowserTaskAsset, BrowserTaskAssetDocument, BrowserTaskAssetRun, BrowserTaskAssetRunInput,
  BrowserTaskAssetState, BrowserTaskContent, BrowserTaskParameter, BrowserTaskStep, BrowserTaskVersion,
  BrowserTaskHumanCheckpoint, BrowserTaskHumanCheckpointRead, BrowserTaskHumanCheckpointSaved, BrowserTaskRunIdentity, BrowserTaskStepExecution, BrowserTaskBatchInput, BrowserTaskBatchRun
} from '../shared/browser-task-assets.js'
import { compileBrowserSteps } from './browser-replay-compiler.js'
import { parseBrowserOutcomeCriteriaRequest } from '../shared/browser-outcome-criteria.js'
import { browserTaskNextIndex, browserTaskSegment, browserTaskReachedCheckpoints, validateBrowserTaskPath, BROWSER_TASK_MAX_EXECUTED_MILLIS, BROWSER_TASK_MAX_OPERATIONS } from '../shared/browser-task-path.js'
import { compileBrowserTaskBranchObservation, evaluateBrowserTaskBranch } from './browser-task-branch.js'
import { validateBrowserTaskBatchValues, BROWSER_TASK_BATCH_MAX_OPERATIONS, BROWSER_TASK_BATCH_MAX_MILLIS, BROWSER_TASK_BATCH_MAX_BYTES, type BrowserTaskBatchHost, type BrowserTaskRunBudget } from './browser-task-batch.js'

export const BROWSER_TASK_ASSETS_FILE = 'browser-task-assets.json'
const MAX_ASSETS = 32
const MAX_VERSIONS = 16
const MAX_STEPS = 128
const MAX_PARAMETERS = 32
const MAX_RUNS = 64
const MAX_FILE_BYTES = 1_048_576
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
    if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw new Error('Task asset document exceeds its byte budget')
    return normalizeDocument(JSON.parse(source))
  }
  async save(document: BrowserTaskAssetDocument): Promise<void> {
    const source = `${JSON.stringify(normalizeDocument(document), null, 2)}\n`
    if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw new Error('Task asset document exceeds its byte budget')
    await mkdir(dirname(this.path), { recursive: true })
    await durableWriteFile(this.path, source)
  }
}

/** Main is the one Browser control owner. This Client keeps progress, never a second approval bit. */
export interface BrowserTaskAssetHost {
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
  constructor(private readonly store: BrowserTaskAssetStore, options: { now?: () => number; id?: () => string } = {}) {
    this.now = options.now ?? Date.now; this.id = options.id ?? randomUUID
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

  /** Called with the actual Main-owned recording, never a Renderer-supplied replacement. */
  async importRecording(recording: BrowserDemonstrationDraft, name = 'Demonstrated task'): Promise<BrowserTaskAsset> {
    return this.change(async () => {
      if (this.document.assets.length >= MAX_ASSETS) throw new Error('Task asset budget reached; existing assets were retained.')
      const at = this.now()
      const steps: BrowserTaskStep[] = recording.steps.map(step => ({
        id: identity(step.id), kind: step.method === 'fillInput' ? 'fill' : step.method === 'gotoUrl' ? 'navigate' : 'click',
        url: safeUrl(step.url), ...(step.target ? { target: target(step.target) } : {}),
        ...(step.inputKey ? { parameterKey: parameterKey(step.inputKey) } : {}), reviewed: false,
        warning: text(step.blockedReason || 'Review the demonstrated step before execution.')
      }))
      const keys = [...new Set(steps.flatMap(step => step.parameterKey ? [step.parameterKey] : []))]
      const asset: BrowserTaskAsset = {
        id: identity(this.id()), browserId: identity(recording.browserId), sourceRecordingId: identity(recording.id),
        revision: 1, draft: content({ name, url: steps[0]?.url ?? safeUrl(recording.url), steps,
          parameters: keys.map(key => ({ key, label: key, secret: true })) }), versions: [], createdAt: at, updatedAt: at
      }
      this.document.assets.push(asset)
      await this.persist(asset.browserId)
      return copy(asset)
    })
  }

  async edit(assetId: string, expectedRevision: number, replacement: BrowserTaskContent): Promise<BrowserTaskAsset> {
    return this.change(async () => {
      const asset = this.requireAsset(assetId)
      if (asset.revision !== expectedRevision) throw new Error('Task draft changed; reload before editing.')
      // A full replacement is deliberate. In particular, an empty step list stays empty.
      asset.draft = content(replacement)
      asset.revision += 1; asset.updatedAt = this.now()
      await this.persist(asset.browserId)
      return copy(asset)
    })
  }
  async saveVersion(assetId: string, expectedRevision: number): Promise<BrowserTaskAsset> {
    return this.change(async () => {
      const asset = this.requireAsset(assetId)
      if (asset.revision !== expectedRevision) throw new Error('Task draft changed; reload before saving its version.')
      if (asset.versions.length >= MAX_VERSIONS) throw new Error('Task version budget reached; old versions were retained.')
      if (!asset.draft.steps.length) throw new Error('The draft has no steps. Add a reviewed step before saving a runnable version.')
      validateBrowserTaskPath(asset.draft.steps)
      asset.versions.push({ ...copy(asset.draft), version: (asset.versions.at(-1)?.version ?? 0) + 1, savedAt: this.now() })
      asset.revision += 1; asset.updatedAt = this.now()
      await this.persist(asset.browserId)
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
        validateTaskSegment(version, parameters, existing?.nextStep ?? 0, input.mode)
        const batch = budget ? this.document.batches?.find(batch => batch.id === budget.batchId && batch.browserId === browserId && batch.assetId === asset.id && batch.version === version.version && batch.status === 'running') : undefined
        const batchItem = batch?.items[batch.nextItem]
        if (budget && (!batchItem || (batchItem.runId && batchItem.runId !== existing?.id) || this.activeBrowsers.get(browserId)?.batchId !== budget.batchId)) throw new Error('The original batch item changed before its task was prepared.')
        const next = existing ?? {
          id: identity(this.id()), assetId: asset.id, version: version.version, browserId,
          nextStep: 0, status: 'ready' as const, operationIds: [], stepExecutions: [], branchDecisions: [], executedMillis: 0, humanCheckpoints: [], startedAt: this.now(), updatedAt: this.now()
        }
        if (!existing) {
          if (this.document.runs.length >= MAX_RUNS) throw new Error('Task run budget reached; previous run facts were retained.')
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
        try { validateTaskSegment(version, parameters, run.nextStep, input.mode) }
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
        let report: BrowserScriptRunReport
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
            } else if (report.outcome.kind === 'completed') run!.nextStep = browserTaskNextIndex(version.steps, run!.nextStep, step.nextStepId)
            else {
              run!.status = report.outcome.kind === 'stopped' ? 'stopped' : report.outcome.kind === 'script-failed' ? 'failed' : 'interrupted'
              run!.warning = 'The Browser step did not complete. Earlier steps remain; inspect the operation details before another action.'
            }
          }
          if (stopped) run!.status = 'stopped'
          await this.updateRun(run!)
        })
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
        run!.status = run!.status === 'stopped' ? 'stopped' : 'completed'
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
        const next: BrowserTaskBatchRun = previous ?? { id: identity(this.id()), browserId, assetId: asset.id, version: version.version,
          items: supplied.items.map(item => ({ id: item.id })), nextItem: 0, status: 'ready', operationCount: 0, executedMillis: 0, startedAt: this.now(), updatedAt: this.now() }
        if (!previous) {
          this.document.batches ??= []
          if (this.document.batches.length >= 32) throw new Error('Batch progress budget reached; existing runs were retained.')
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
      let changed = false
      for (const run of this.document.runs) if (run.status === 'running') {
        run.status = 'interrupted'; run.warning = 'Restart interrupted the Browser step. Inspect the page and its operation history; it was not automatically replayed.'
        run.updatedAt = this.now(); changed = true
      }
      for (const batch of this.document.batches ?? []) if (batch.status === 'running') {
        batch.status = 'interrupted'; batch.warning = 'Restart interrupted this batch. Original item runs remain; uncertain actions and remaining items were not replayed.'; batch.updatedAt = this.now(); changed = true
      }
      if (changed) await this.persist()
    } catch {
      this.loadUnavailable = true
      this.warning = 'Task assets could not be restored. The existing file was retained; restore storage to review it. Browser and Agent work remain available.'
    }
  }
}

export async function runBrowserTaskAsset(assets: BrowserTaskAssets, input: BrowserTaskAssetRunInput, host: BrowserTaskAssetHost, budget?: BrowserTaskRunBudget): Promise<BrowserTaskAssetRun> {
  return await assets.run(input, host, budget)
}

function compileAssetStep(step: BrowserTaskStep, parameters: Record<string, string>, downloadPath?: string): string {
  if (!step.reviewed) throw new Error('Review the demonstrated step before executing it.')
  if (step.kind !== 'navigate' && (!step.target || step.target.count !== 1 || step.target.ordinal !== 1)) {
    throw new Error('The task target is unknown or ambiguous. Locate the actual page target before executing it.')
  }
  const replay: BrowserReplayStep = {
    method: downloadPath ? 'download' : step.kind === 'fill' ? 'fillInput' : step.kind === 'navigate' ? 'gotoUrl' : 'click',
    url: step.url, ...(step.target ? { target: step.target } : {}),
    args: downloadPath ? [{ path: downloadPath }] : step.kind === 'fill' ? [parameters[step.parameterKey!]] : step.kind === 'navigate' ? [step.url] : []
  }
  if (!step.url) throw new Error('The reviewed page identity is unavailable. Locate the intended page before executing this step.')
  return `${compileBrowserSteps({ url: step.kind === 'navigate' ? 'about:blank' : step.url, steps: [replay] })}\nreturn { taskStepId: ${JSON.stringify(step.id)} }`
}

function validateTaskSegment(version: BrowserTaskVersion, values: Record<string, string>, nextStep: number, mode?: 'run' | 'step'): void {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Provide the task parameters for this invocation.')
  const first = version.steps[nextStep]
  if (first?.kind === 'branch') {
    if (!first.reviewed || !first.branch) throw new Error('Review the condition and both paths before executing it.')
    return
  }
  for (const step of browserTaskSegment(version.steps, nextStep)) {
    if (step.kind === 'fill') {
    const definition = version.parameters.find(item => item.key === step.parameterKey)
    if (!definition || typeof values[definition.key] !== 'string' || !values[definition.key] || values[definition.key]!.length > 16_384) {
      throw new Error(`A fresh value is required for parameter ${definition?.label ?? step.parameterKey ?? 'unknown'}.`)
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
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('Parameter keys must start with a letter and contain only letters, digits, underscores or dashes.')
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
  if (!value || !value.role || typeof value.name !== 'string' || !Number.isSafeInteger(value.ordinal) || !Number.isSafeInteger(value.count) ||
      value.ordinal < 1 || value.count < value.ordinal) throw new Error('Invalid task target')
  return { role: text(value.role), name: text(value.name), ordinal: value.ordinal, count: value.count }
}
function content(raw: BrowserTaskContent): BrowserTaskContent {
  if (!raw || !Array.isArray(raw.steps) || raw.steps.length > MAX_STEPS || !Array.isArray(raw.parameters) || raw.parameters.length > MAX_PARAMETERS) throw new Error('Invalid task draft or budget')
  const parameters: BrowserTaskParameter[] = raw.parameters.map(parameter => ({ key: parameterKey(parameter.key), label: text(parameter.label), secret: parameter.secret === true }))
  if (new Set(parameters.map(item => item.key)).size !== parameters.length) throw new Error('Duplicate task parameter')
  const steps: BrowserTaskStep[] = raw.steps.map(step => {
    if (!step || !['click', 'fill', 'navigate', 'checkpoint', 'branch'].includes(step.kind)) throw new Error('Invalid task step')
    const url = safeUrl(step.url)
    return { id: identity(step.id), kind: step.kind, url, ...(step.target ? { target: target(step.target) } : {}),
      ...(step.parameterKey ? { parameterKey: parameterKey(step.parameterKey) } : {}), ...(step.label ? { label: text(step.label) } : {}),
      ...(step.branch !== undefined ? { branch: branch(step.branch) } : {}),
      ...(step.nextStepId !== undefined ? { nextStepId: step.nextStepId === null ? null : identity(step.nextStepId) } : {}),
      reviewed: step.reviewed === true, ...(step.warning ? { warning: text(step.warning) } : {}) }
  })
  if (new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('Duplicate task step identity')
  for (const step of steps) if (step.kind === 'branch' ? !step.branch : step.branch !== undefined) throw new Error('Condition declaration belongs only to a condition step.')
  for (const step of steps) if (step.kind === 'fill' && !parameters.some(parameter => parameter.key === step.parameterKey)) throw new Error('Task fill parameter is not defined')
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
      if (item.kind === 'download-readable' && (steps[producerIndex]?.kind !== 'click' || !item.path.trim() || item.path.length > 512)) throw new Error('Download completion needs a reviewed click and a Workspace path.')
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
  if (!raw || raw.version !== 1 || !Array.isArray(raw.assets) || raw.assets.length > MAX_ASSETS || !Array.isArray(raw.runs) || raw.runs.length > MAX_RUNS) throw new Error('Invalid task asset document')
  const assets = raw.assets.map(asset => {
    if (!asset || !Number.isSafeInteger(asset.revision) || asset.revision < 1 || !Number.isFinite(asset.createdAt) || !Number.isFinite(asset.updatedAt) ||
        !Array.isArray(asset.versions) || asset.versions.length > MAX_VERSIONS) throw new Error('Invalid task asset')
    const versions = asset.versions.map((version, index) => {
      if (version.version !== index + 1 || !Number.isFinite(version.savedAt)) throw new Error('Invalid task version')
      return { ...content(version), version: version.version, savedAt: version.savedAt }
    })
    return { id: identity(asset.id), browserId: identity(asset.browserId), sourceRecordingId: identity(asset.sourceRecordingId), revision: asset.revision,
      draft: content(asset.draft), versions, createdAt: asset.createdAt, updatedAt: asset.updatedAt }
  })
  if (new Set(assets.map(asset => asset.id)).size !== assets.length) throw new Error('Duplicate task asset identity')
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
  const selectedRuns = Array.isArray(raw.selectedRuns) && raw.selectedRuns.length <= MAX_RUNS &&
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
  if (!value || !value.condition || !['page-url-is', 'element-present'].includes(value.condition.kind) ||
      (value.onTrue !== null && typeof value.onTrue !== 'string') || (value.onFalse !== null && typeof value.onFalse !== 'string')) throw new Error('Invalid task condition declaration')
  const condition = value.condition.kind === 'page-url-is'
    ? { kind: value.condition.kind, url: safeUrl(value.condition.url) }
    : { kind: value.condition.kind, target: { role: text(value.condition.target.role), name: text(value.condition.target.name) } }
  if (condition.kind === 'page-url-is' ? !condition.url : !condition.target.role) throw new Error('Condition needs a reviewed page URL or a semantic element role.')
  return { condition, onTrue: value.onTrue === null ? null : identity(value.onTrue), onFalse: value.onFalse === null ? null : identity(value.onFalse) }
}
function recordStepOperation(run: BrowserTaskAssetRun, stepId: string, operationId: string): void {
  const id = identity(operationId)
  if (!run.operationIds.includes(id)) run.operationIds.push(id)
  if (!run.stepExecutions?.some(item => item.operationId === id)) run.stepExecutions = [...(run.stepExecutions ?? []), { stepId, operationId: id }]
}
function normalizePathFacts(run: BrowserTaskAssetRun, version: BrowserTaskVersion): Pick<BrowserTaskAssetRun, 'stepExecutions' | 'branchDecisions' | 'executedMillis'> {
  const facts: Pick<BrowserTaskAssetRun, 'stepExecutions' | 'branchDecisions' | 'executedMillis'> = {}
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
  if (run.executedMillis !== undefined) {
    if (!Number.isFinite(run.executedMillis) || run.executedMillis < 0) throw new Error('Invalid task execution time budget')
    facts.executedMillis = run.executedMillis
  }
  return facts
}

function normalizeBatches(value: BrowserTaskBatchRun[], assets: BrowserTaskAsset[], runs: BrowserTaskAssetRun[]): BrowserTaskBatchRun[] {
  if (!Array.isArray(value) || value.length > 32 || new Set(value.map(batch => batch.id)).size !== value.length) throw new Error('Invalid batch progress collection')
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
