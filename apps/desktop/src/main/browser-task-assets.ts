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
  BrowserTaskHumanCheckpoint, BrowserTaskHumanCheckpointRead, BrowserTaskHumanCheckpointSaved, BrowserTaskRunIdentity
} from '../shared/browser-task-assets.js'
import { compileBrowserSteps } from './browser-replay-compiler.js'

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
  runScript(browserId: string, script: string): Promise<BrowserScriptRunReport>
  yieldControl(browserId: string): void
  control(browserId: string): 'human' | 'agent'
}

export class BrowserTaskAssets {
  private document: BrowserTaskAssetDocument = { version: 1, assets: [], runs: [] }
  private loaded: Promise<void> | undefined
  private tail: Promise<void> = Promise.resolve()
  private loadUnavailable = false
  private warning: string | undefined
  private activeBrowsers = new Set<string>()
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
      runs: this.document.runs.filter(run => !browserId || run.browserId === browserId),
      ...(this.warning ? { warning: this.warning } : {})
    })
  }
  async get(assetId: string): Promise<BrowserTaskAsset | null> {
    await this.ready(); return copy(this.document.assets.find(asset => asset.id === assetId) ?? null)
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
    if (cursor <= bound.run.nextStep && bound.run.pendingCheckpointId !== checkpointId) return { status: 'unavailable', warning: HUMAN_FACT_UNAVAILABLE }
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
      return copy(run)
    })
  }

  /** Used by runBrowserTaskAsset. Caller is the trusted Client action; continuation has no Agent API. */
  async run(input: BrowserTaskAssetRunInput, host: BrowserTaskAssetHost): Promise<BrowserTaskAssetRun> {
    await this.ready()
    const browserId = identity(input.browserId)
    const parameters = { ...input.parameters }
    if (this.activeBrowsers.has(browserId)) throw new Error('A task is already executing in this Browser.')
    this.activeBrowsers.add(browserId)
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
        if (existing && existing.status !== 'waiting-human' && existing.status !== 'ready') {
          throw new Error('This task cannot be continued automatically. Review completed and uncertain steps before creating another run.')
        }
        if (host.control(browserId) !== 'agent') throw new Error('The person has Browser control. Return control explicitly before running the task.')
        validateTaskSegment(version, parameters, existing?.nextStep ?? 0, input.mode)
        const next = existing ?? {
          id: identity(this.id()), assetId: asset.id, version: version.version, browserId,
          nextStep: 0, status: 'ready' as const, operationIds: [], humanCheckpoints: [], startedAt: this.now(), updatedAt: this.now()
        }
        if (!existing) {
          if (this.document.runs.length >= MAX_RUNS) throw new Error('Task run budget reached; previous run facts were retained.')
          this.document.runs.push(next)
        }
        host.onRunPrepared(next.id)
        delete next.pendingCheckpointId; delete next.warning
        next.status = 'ready'
        await this.persist(next.browserId)
        return { run: next, version: copy(version) }
      })
      run = prepared.run
      const version = prepared.version
      let actions = 0
      while (run.nextStep < version.steps.length) {
        if (run.status === 'stopped') break
        const step = version.steps[run.nextStep]!
        if (step.kind === 'checkpoint') {
          host.yieldControl(browserId)
          await this.change(async () => {
            if (run!.status === 'stopped') return
            run!.nextStep += 1; run!.status = 'waiting-human'; run!.pendingCheckpointId = step.id
            run!.warning = 'Human checkpoint reached. Review the page, then explicitly return control to continue the remaining steps.'
            await this.updateRun(run!)
          })
          return copy(run)
        }
        const script = compileAssetStep(step, parameters)
        // Write-ahead cursor: restart during a call is uncertain, so no automatic replay is offered.
        const started = await this.change(async () => {
          if (run!.status === 'stopped') return false
          run!.status = 'running'; await this.updateRun(run!)
          return true
        })
        // A listener can stop the cursor across the await; discard the earlier loop narrowing.
        if (!started || (run as BrowserTaskAssetRun).status === 'stopped') break
        let report: BrowserScriptRunReport
        try { report = await host.runScript(browserId, script) }
        catch {
          await this.change(async () => {
            if (run!.status !== 'stopped') {
              run!.status = 'interrupted'; run!.warning = 'The Browser call did not produce a known result. Inspect the page; this step was not replayed.'
            }
            await this.updateRun(run!)
          })
          return copy(run)
        }
        await this.change(async () => {
          const stopped = run!.status === 'stopped'
          // A real journal id is required; asset/run ids are never passed as operation ids.
          if (!report.runOperation.id || report.runOperation.browserId !== browserId) {
            run!.status = 'interrupted'; run!.warning = 'The Browser operation identity could not be confirmed. Inspect the page before continuing.'
          } else {
            run!.operationIds.push(identity(report.runOperation.id))
            if (report.outcome.kind === 'completed') run!.nextStep += 1
            else {
              run!.status = report.outcome.kind === 'stopped' ? 'stopped' : report.outcome.kind === 'script-failed' ? 'failed' : 'interrupted'
              run!.warning = 'The Browser step did not complete. Earlier steps remain; inspect the operation details before another action.'
            }
          }
          if (stopped) run!.status = 'stopped'
          await this.updateRun(run!)
        })
        if (run.status !== 'running') return copy(run)
        actions += 1
        if (input.mode === 'step' && actions === 1 && run.nextStep < version.steps.length) {
          await this.change(async () => { run!.status = 'ready'; await this.updateRun(run!) })
          return copy(run)
        }
      }
      await this.change(async () => {
        run!.status = run!.status === 'stopped' ? 'stopped' : 'completed'
        await this.updateRun(run!)
      })
      return copy(run)
    } finally {
      this.activeBrowsers.delete(browserId)
    }
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
  private async change<T>(action: () => Promise<T>): Promise<T> {
    await this.ready()
    const next = this.tail.then(action)
    this.tail = next.then(() => {}, () => {})
    return next
  }
  private async updateRun(run: BrowserTaskAssetRun): Promise<void> { run.updatedAt = this.now(); await this.persist(run.browserId) }
  private async persist(browserId?: string): Promise<void> {
    if (this.loadUnavailable) throw new Error(this.warning)
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
      if (changed) await this.persist()
    } catch {
      this.loadUnavailable = true
      this.warning = 'Task assets could not be restored. The existing file was retained; restore storage to review it. Browser and Agent work remain available.'
    }
  }
}

export async function runBrowserTaskAsset(assets: BrowserTaskAssets, input: BrowserTaskAssetRunInput, host: BrowserTaskAssetHost): Promise<BrowserTaskAssetRun> {
  return await assets.run(input, host)
}

function compileAssetStep(step: BrowserTaskStep, parameters: Record<string, string>): string {
  if (!step.reviewed) throw new Error('Review the demonstrated step before executing it.')
  if (step.kind !== 'navigate' && (!step.target || step.target.count !== 1 || step.target.ordinal !== 1)) {
    throw new Error('The task target is unknown or ambiguous. Locate the actual page target before executing it.')
  }
  const replay: BrowserReplayStep = {
    method: step.kind === 'fill' ? 'fillInput' : step.kind === 'navigate' ? 'gotoUrl' : 'click',
    url: step.url, ...(step.target ? { target: step.target } : {}),
    args: step.kind === 'fill' ? [parameters[step.parameterKey!]] : step.kind === 'navigate' ? [step.url] : []
  }
  if (!step.url) throw new Error('The reviewed page identity is unavailable. Locate the intended page before executing this step.')
  return `${compileBrowserSteps({ url: step.kind === 'navigate' ? 'about:blank' : step.url, steps: [replay] })}\nreturn { taskStepId: ${JSON.stringify(step.id)} }`
}

function validateTaskSegment(version: BrowserTaskVersion, values: Record<string, string>, nextStep: number, mode?: 'run' | 'step'): void {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Provide the task parameters for this invocation.')
  for (const step of version.steps.slice(nextStep)) {
    if (step.kind === 'checkpoint') break
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
    if (!step || !['click', 'fill', 'navigate', 'checkpoint'].includes(step.kind)) throw new Error('Invalid task step')
    const url = safeUrl(step.url)
    return { id: identity(step.id), kind: step.kind, url, ...(step.target ? { target: target(step.target) } : {}),
      ...(step.parameterKey ? { parameterKey: parameterKey(step.parameterKey) } : {}), ...(step.label ? { label: text(step.label) } : {}),
      reviewed: step.reviewed === true, ...(step.warning ? { warning: text(step.warning) } : {}) }
  })
  if (new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('Duplicate task step identity')
  for (const step of steps) if (step.kind === 'fill' && !parameters.some(parameter => parameter.key === step.parameterKey)) throw new Error('Task fill parameter is not defined')
  return { name: text(raw.name), url: safeUrl(raw.url), steps, parameters }
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
      operationIds: run.operationIds.map(identity), ...(run.pendingCheckpointId ? { pendingCheckpointId: identity(run.pendingCheckpointId) } : {}),
      ...(humanCheckpoints !== undefined ? { humanCheckpoints } : {}),
      ...(run.warning ? { warning: text(run.warning) } : {}), startedAt: run.startedAt, updatedAt: run.updatedAt }
  })
  if (new Set(runs.map(run => run.id)).size !== runs.length) throw new Error('Duplicate task run identity')
  return { version: 1, assets, runs }
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
