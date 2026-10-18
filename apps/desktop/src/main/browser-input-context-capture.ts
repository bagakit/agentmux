import { mintObjectId } from '@agentmux/core/object-id'
import { createHash } from 'node:crypto'
import { mkdir, open, link, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError, observeRead } from '@agentmux/core'
import { parseBrowserInputContext, type BrowserInputContext, type BrowserInputSelectionSource } from '@agentmux/core/browser-input-context'
import {
  createAgentInputContextCaptureRecord, parseAgentInputContextCaptureRecord, parseAgentInputContextCaptureReference,
  type AgentInputContextCaptureReader, type AgentInputContextCaptureRecord, type AgentInputContextCaptureReference
} from '@agentmux/core/agent-input-context-capture'
import type { BrowserInputContextFreeze, BrowserInputContextFreezeReceipt, BrowserInputScene, BrowserInputSceneReference,
  BrowserInputFrameCapture, BrowserInputFrameResult, BrowserInputSelectionPrepare, BrowserInputSelectionReceipt, BrowserInputSelectionArtifact } from '../shared/browser-input-context-capture.js'
import type { BrowserPng } from '../shared/contracts.js'
import type { PastedImageWriteReceipt } from './pasted-image-write.js'

type Preparation = { operationId: string; intentDigest: string; artifact: BrowserInputSelectionArtifact }
type RetainedScene = BrowserInputScene & { preparation?: Preparation }
type SelectionIntent = { schema: 'agentmux.browser-input-selection-intent.v1'; operationId: string; intentDigest: string; scene: BrowserInputSceneReference; frame: BrowserInputSceneReference }
type FileKind = 'scene' | 'input' | 'selection-intent'
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const selectionId = (id: string) => `selection-${digest(id)}`
function observation(context: BrowserInputContext, navigationId: string | null): BrowserInputSelectionSource {
  const matches = context.browser.navigationId === navigationId
  return { ...context.browser, navigationId,
    ...(matches && context.activity ? { operationId: context.activity.operationId,
      ...(context.activity.stepSequence === null ? {} : { stepSequence: context.activity.stepSequence }) } : {}),
    association: matches ? 'observed-during' : 'unknown' }
}

const unavailable = () => new AgentMuxError('The original Browser scene cannot be confirmed. Keep its reference and message; retry that original capture after restoring its owner. Other inputs remain available.', 'CONTROL_UNAVAILABLE')
const conflict = () => new AgentMuxError('This original input already names another message, recipient or Browser scene. Its retained capture was not replaced.', 'CONTROL_REQUEST_CONFLICT')
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) throw unavailable()
  return value
}

/** Exact immutable files; no directory scan, pruning, overwrite or startup dependency. */
export class BrowserInputContextCaptureFiles {
  constructor(private readonly directory: string) {}
  private path(kind: FileKind, id: string): string {
    return join(this.directory, `${kind}-${createHash('sha256').update(id).digest('hex')}.json`)
  }
  async read(kind: FileKind, id: string): Promise<unknown | null> {
    try { return JSON.parse(await readFile(this.path(kind, id), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  async put(kind: FileKind, id: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = this.path(kind, id), temporary = `${path}.${mintObjectId()}.partial`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
      try { await link(temporary, path) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // A concurrent publisher is authoritative too. Never replace its original fact.
        let original: unknown
        try { original = await this.read(kind, id) } catch { throw unavailable() }
        if (JSON.stringify(original) !== JSON.stringify(value)) throw conflict()
      }
      const directory = await open(this.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally {
      // A leftover private temporary file cannot replace the original publication/conflict result.
      await unlink(temporary).catch(() => {})
    }
  }
}

/** Main owns observations and provenance, while Core still owns input author, admission and delivery. */
export class BrowserInputContextCaptures implements AgentInputContextCaptureReader {
  private readonly scenes = new Map<string, RetainedScene>()
  private readonly inputs = new Map<string, { scene: BrowserInputSceneReference; receipt: BrowserInputContextFreezeReceipt }>()
  private readonly pending = new Map<string, Promise<BrowserInputContextFreezeReceipt>>()
  private readonly selectionPending = new Map<string, Promise<BrowserInputSelectionReceipt>>()
  constructor(private readonly options: {
    hostId: string
    source(browserId: string): BrowserInputContext | null
    files: BrowserInputContextCaptureFiles
    captureFrame?(browserId: string): Promise<BrowserInputFrameCapture>
    selectionImages?: {
      decode(png: BrowserPng): { bytes: Buffer; width: number; height: number; sha256: string }
      save(bytes: Buffer): Promise<PastedImageWriteReceipt>
    }
  }) {}

  async captureFrame(browserId: string): Promise<BrowserInputFrameResult> {
    if (!this.options.captureFrame) throw unavailable()
    const { capture, before, after } = await this.options.captureFrame(identity(browserId))
    if (capture.browserId !== browserId || before.browser.hostId !== this.options.hostId || after.browser.hostId !== this.options.hostId ||
        before.browser.browserId !== browserId || after.browser.browserId !== browserId) throw unavailable()
    const source = observation(before, capture.navigationId)
    const end = observation(after, after.browser.navigationId)
    const scene: BrowserInputScene = { reference: { hostId: this.options.hostId, captureId: mintObjectId() },
      inputContext: parseBrowserInputContext(before), diskDurability: 'unconfirmed',
      frame: { capturedAt: before.capturedAt, source,
        observationEnd: { ...end, observedAt: after.capturedAt },
        ...(capture.source.viewport ? { viewport: capture.source.viewport } : {}),
        width: capture.image.width, height: capture.image.height,
        sha256: digest(Buffer.from(capture.image.dataUrl.slice('data:image/png;base64,'.length), 'base64')) } }
    this.scenes.set(scene.reference.captureId, scene)
    try { await this.options.files.put('scene', scene.reference.captureId, this.sceneDocument(scene)); scene.diskDurability = 'confirmed' }
    catch (error) { if (error instanceof AgentMuxError) { this.scenes.delete(scene.reference.captureId); throw error } }
    return { scene: structuredClone(scene), capture }
  }

  /** The caller retains one intent ID and the same processed bytes across an unknown reply. */
  prepareSelection(input: BrowserInputSelectionPrepare): Promise<BrowserInputSelectionReceipt> {
    const original = structuredClone(input), id = identity(original.operationId)
    const previous = this.selectionPending.get(id) ?? Promise.resolve(undefined)
    const preparing = previous.catch(() => {}).then(() => this.prepareOriginalSelection(original))
    this.selectionPending.set(id, preparing)
    void preparing.finally(() => { if (this.selectionPending.get(id) === preparing) this.selectionPending.delete(id) }).catch(() => {})
    return preparing
  }

  readSelection(operationId: string, options?: { signal?: AbortSignal }): Promise<{ operationId: string; state: 'absent' | 'unconfirmed' | 'prepared'; receipt?: BrowserInputSelectionReceipt }> {
    options?.signal?.throwIfAborted()
    return observeRead(this.readOriginalSelection(operationId), options?.signal)
  }

  private async readOriginalSelection(operationId: string): Promise<{ operationId: string; state: 'absent' | 'unconfirmed' | 'prepared'; receipt?: BrowserInputSelectionReceipt }> {
    const id = identity(operationId), pending = this.selectionPending.get(id)
    if (pending) await pending.catch(() => {})
    const projection = () => {
      const live = this.scenes.get(selectionId(id))
      return live?.preparation ? { operationId: id, state: 'prepared' as const, receipt: this.selectionReceipt(live) } : null
    }
    const live = projection()
    if (live) return live
    let intent: SelectionIntent | null
    try { intent = await this.selectionIntent(id) }
    catch (error) { const published = projection(); if (published) return published; throw error }
    // Observation can begin before a prepare registers, then return after its write.
    const publishing = this.selectionPending.get(id)
    if (publishing) { await publishing.catch(() => {}); intent = await this.selectionIntent(id) }
    const published = projection()
    if (published) return published
    if (!intent) return { operationId: id, state: 'absent' }
    const reference = { hostId: this.options.hostId, captureId: selectionId(id) }
    let scene = await this.scene(reference, true)
    const completing = this.selectionPending.get(id)
    if (completing) { await completing.catch(() => {}); scene = await this.scene(reference, true) }
    const completed = projection()
    if (completed) return completed
    if (!scene) return { operationId: id, state: 'unconfirmed' }
    if (!scene.preparation || scene.preparation.operationId !== id || scene.preparation.intentDigest !== intent.intentDigest) throw unavailable()
    return { operationId: id, state: 'prepared', receipt: this.selectionReceipt(scene) }
  }

  private async prepareOriginalSelection(input: BrowserInputSelectionPrepare): Promise<BrowserInputSelectionReceipt> {
    const images = this.options.selectionImages
    if (!images) throw unavailable()
    // Geometry and decoded bytes are checked before persisting or saving anything.
    const original = await this.scene(input.scene), frame = await this.scene(input.frame)
    if (!frame?.frame || !original) throw unavailable()
    if (original.inputContext.browser.browserId !== frame.inputContext.browser.browserId) throw conflict()
    const decoded = images.decode(input.png), pixels = frame.frame
    const context = parseBrowserInputContext({ ...original.inputContext, selection: {
      kind: 'region', capturedAt: pixels.capturedAt, source: pixels.source, observationEnd: pixels.observationEnd,
      frameId: frame.reference.captureId, ...(pixels.viewport ? { viewport: pixels.viewport } : {}),
      region: input.region, ...(input.crop ? { crop: input.crop } : {}) } })
    const selection = context.selection!
    for (const rectangle of [selection.region!, ...(selection.crop ? [selection.crop] : [])]) {
      if (rectangle.x + rectangle.width > pixels.width || rectangle.y + rectangle.height > pixels.height) throw unavailable()
    }
    const intent: SelectionIntent = { schema: 'agentmux.browser-input-selection-intent.v1', operationId: input.operationId,
      intentDigest: digest(JSON.stringify({ scene: original.reference, frame: frame.reference,
        region: selection.region, crop: selection.crop ?? null, png: { width: decoded.width, height: decoded.height, sha256: decoded.sha256 } })),
      scene: original.reference, frame: frame.reference }
    // Same file owner, immutable publication before the artifact side effect. No PNG is journaled.
    // If this acknowledgement is unknown, retain the intent/bytes and explicitly retry it.
    try { await this.options.files.put('selection-intent', input.operationId, intent) }
    catch (error) { if (error instanceof AgentMuxError) throw error; throw unavailable() }
    const saved = await images.save(decoded.bytes)
    if (saved.diskDurability !== 'confirmed' || saved.sha256 !== decoded.sha256 || saved.byteLength !== decoded.bytes.length) throw unavailable()
    const artifact: BrowserInputSelectionArtifact = { ...saved, width: decoded.width, height: decoded.height }
    selection.attachment = { hostId: this.options.hostId, path: saved.path, mimeType: 'image/png', width: decoded.width, height: decoded.height, sha256: saved.sha256 }
    const retained = await this.scene({ hostId: this.options.hostId, captureId: selectionId(input.operationId) }, true)
    if (retained && (retained.preparation?.intentDigest !== intent.intentDigest || JSON.stringify(retained.preparation.artifact) !== JSON.stringify(artifact))) throw conflict()
    if (retained?.diskDurability === 'confirmed') return this.selectionReceipt(retained)
    const scene: RetainedScene = { reference: { hostId: this.options.hostId, captureId: selectionId(input.operationId) },
      inputContext: parseBrowserInputContext(context), diskDurability: 'unconfirmed', preparation: { operationId: input.operationId, intentDigest: intent.intentDigest, artifact } }
    try { await this.options.files.put('scene', scene.reference.captureId, this.sceneDocument(scene)); scene.diskDurability = 'confirmed' }
    catch (error) { if (error instanceof AgentMuxError) throw error }
    this.scenes.set(scene.reference.captureId, scene)
    return this.selectionReceipt(scene)
  }

  private selectionReceipt(scene: RetainedScene): BrowserInputSelectionReceipt {
    const { preparation, ...projection } = scene
    if (!preparation) throw unavailable()
    return structuredClone({ operationId: preparation.operationId, scene: projection, artifact: preparation.artifact })
  }

  private async selectionIntent(id: string): Promise<SelectionIntent | null> {
    let stored: unknown
    try { stored = await this.options.files.read('selection-intent', id) } catch { throw unavailable() }
    if (stored === null) return null
    const intent = stored as SelectionIntent
    if (!intent || intent.schema !== 'agentmux.browser-input-selection-intent.v1' || intent.operationId !== id ||
        !/^[a-f0-9]{64}$/u.test(intent.intentDigest) || intent.scene?.hostId !== this.options.hostId || intent.frame?.hostId !== this.options.hostId) throw unavailable()
    identity(intent.scene.captureId); identity(intent.frame.captureId)
    return intent
  }

  async capture(browserId: string): Promise<BrowserInputScene> {
    const inputContext = this.options.source(identity(browserId))
    if (!inputContext || inputContext.browser.hostId !== this.options.hostId || inputContext.browser.browserId !== browserId) throw unavailable()
    const scene: BrowserInputScene = { reference: { hostId: this.options.hostId, captureId: mintObjectId() },
      inputContext: parseBrowserInputContext(inputContext), diskDurability: 'unconfirmed' }
    this.scenes.set(scene.reference.captureId, scene)
    try { await this.options.files.put('scene', scene.reference.captureId, this.sceneDocument(scene)); scene.diskDurability = 'confirmed' }
    catch (error) {
      if (error instanceof AgentMuxError) { this.scenes.delete(scene.reference.captureId); throw error }
      // Retain the real live observation without claiming disk durability.
    }
    return structuredClone(scene)
  }

  freeze(input: BrowserInputContextFreeze): Promise<BrowserInputContextFreezeReceipt> {
    // Clone before any asynchronous work; no subsequent renderer mutation changes the intent.
    const original = structuredClone(input), id = identity(original.operationId)
    const previous = this.pending.get(id) ?? Promise.resolve(undefined)
    const saving = previous.catch(() => {}).then(() => this.freezeOriginal(original))
    this.pending.set(id, saving)
    void saving.finally(() => { if (this.pending.get(id) === saving) this.pending.delete(id) }).catch(() => {})
    return saving
  }

  private async freezeOriginal(input: BrowserInputContextFreeze): Promise<BrowserInputContextFreezeReceipt> {
    // This owner currently captures and submits only on the original local execution Host.
    // No inferred local route or new Run can be substituted for a retained remote/origin identity.
    if (input.control.kind !== 'agent' || input.control.hostId !== this.options.hostId) throw unavailable()
    const reference = { hostId: this.options.hostId, operationId: input.operationId }
    const retained = await this.retained(reference)
    if (retained && (input.scene?.hostId !== retained.scene.hostId || input.scene?.captureId !== retained.scene.captureId)) throw conflict()
    // Original retries need the retained producer fact, never a fresh page or even the old scene file.
    const inputContext = retained?.receipt.record.inputContext ?? (await this.scene(input.scene)).inputContext
    const record = createAgentInputContextCaptureRecord({ reference,
      binding: { executionHostId: input.control.hostId, agentSessionId: input.control.agentSessionId, originRun: input.control.run },
      prompt: input.prompt, ...(input.agentMuxNote === undefined ? {} : { agentMuxNote: input.agentMuxNote }), inputContext })
    if (retained && JSON.stringify(retained.receipt.record) !== JSON.stringify(record)) throw conflict()
    if (retained?.receipt.diskDurability === 'confirmed') return structuredClone(retained.receipt)
    const receipt: BrowserInputContextFreezeReceipt = { reference, record, diskDurability: retained?.receipt.diskDurability ?? 'unconfirmed' }
    const saved = { scene: { ...input.scene }, receipt }
    try { await this.options.files.put('input', reference.operationId, this.inputDocument(saved)); receipt.diskDurability = 'confirmed' }
    catch (error) {
      if (error instanceof AgentMuxError) throw error
      // Core can freeze a confirmed live producer fact; Main disk failure is reported separately.
      receipt.diskDurability = 'unconfirmed'
    }
    this.inputs.set(reference.operationId, saved)
    return structuredClone(receipt)
  }

  async read(value: AgentInputContextCaptureReference, options?: { signal?: AbortSignal }) {
    options?.signal?.throwIfAborted()
    const reference = parseAgentInputContextCaptureReference(value)
    if (reference.hostId !== this.options.hostId) throw unavailable()
    const pending = this.pending.get(reference.operationId)
    if (pending) await observeRead(pending.catch(() => {}), options?.signal)
    let retained = await observeRead(this.retained(reference), options?.signal)
    // A freeze may have begun while the exact file read was in flight. A newly linked
    // file is not its owner's completed publication receipt yet.
    const publishing = this.pending.get(reference.operationId)
    if (publishing) {
      await observeRead(publishing.catch(() => {}), options?.signal)
      retained = await observeRead(this.retained(reference), options?.signal)
    }
    retained = this.inputs.get(reference.operationId) ?? retained
    options?.signal?.throwIfAborted()
    return retained ? structuredClone(retained.receipt) : { reference, record: null, diskDurability: 'confirmed' as const }
  }

  private inputDocument(input: { scene: BrowserInputSceneReference; receipt: BrowserInputContextFreezeReceipt }) {
    return { schema: 'agentmux.browser-input-context-input.v1', scene: input.scene, record: input.receipt.record }
  }
  private async retained(reference: AgentInputContextCaptureReference) {
    const live = this.inputs.get(reference.operationId)
    if (live) return live
    let stored: unknown
    try { stored = await this.options.files.read('input', reference.operationId) }
    catch { const published = this.inputs.get(reference.operationId); if (published) return published; throw unavailable() }
    // An older read cannot replace a publication receipt completed while its IO was pending.
    const published = this.inputs.get(reference.operationId)
    if (published) return published
    if (stored === null) return null
    if (typeof stored !== 'object') throw unavailable()
    const document = stored as Record<string, unknown>, scene = document.scene as BrowserInputSceneReference | undefined
    if (document.schema !== 'agentmux.browser-input-context-input.v1' || scene?.hostId !== this.options.hostId) throw unavailable()
    const captureId = identity(scene.captureId), record = parseAgentInputContextCaptureRecord(document.record)
    if (record.reference.hostId !== reference.hostId || record.reference.operationId !== reference.operationId) throw unavailable()
    const receipt = { reference, record, diskDurability: 'confirmed' as const }
    const saved = { scene: { hostId: scene.hostId, captureId }, receipt }
    this.inputs.set(reference.operationId, saved)
    return saved
  }

  private sceneDocument(scene: RetainedScene) { return { schema: 'agentmux.browser-input-scene.v1', reference: scene.reference, inputContext: scene.inputContext,
    ...(scene.frame ? { frame: scene.frame } : {}), ...(scene.preparation ? { preparation: scene.preparation } : {}) } }
  private scene(reference: BrowserInputSceneReference): Promise<RetainedScene>
  private scene(reference: BrowserInputSceneReference, allowAbsent: true): Promise<RetainedScene | null>
  private async scene(reference: BrowserInputSceneReference, allowAbsent = false): Promise<RetainedScene | null> {
    if (!reference || reference.hostId !== this.options.hostId) throw unavailable()
    const captureId = identity(reference.captureId), live = this.scenes.get(captureId)
    if (live) return structuredClone(live)
    let stored: unknown
    try { stored = await this.options.files.read('scene', captureId) }
    catch { const published = this.scenes.get(captureId); if (published) return structuredClone(published); throw unavailable() }
    const published = this.scenes.get(captureId)
    if (published) return structuredClone(published)
    if (stored === null && allowAbsent) return null
    if (!stored || typeof stored !== 'object') throw unavailable()
    const document = stored as Record<string, unknown>, ref = document.reference as BrowserInputSceneReference | undefined
    if (document.schema !== 'agentmux.browser-input-scene.v1' || !ref || ref.hostId !== reference.hostId || ref.captureId !== captureId) throw unavailable()
    const scene: RetainedScene = { reference: { hostId: ref.hostId, captureId }, inputContext: parseBrowserInputContext(document.inputContext), diskDurability: 'confirmed' }
    if (scene.inputContext.browser.hostId !== this.options.hostId) throw unavailable()
    if (document.frame !== undefined) {
      const frame = document.frame as NonNullable<BrowserInputScene['frame']>
      if (!frame || !Number.isSafeInteger(frame.width) || frame.width < 1 || !Number.isSafeInteger(frame.height) || frame.height < 1 || !/^[a-f0-9]{64}$/u.test(frame.sha256)) throw unavailable()
      const selection = parseBrowserInputContext({ ...scene.inputContext, selection: { kind: 'region', capturedAt: frame.capturedAt,
        source: frame.source, ...(frame.observationEnd ? { observationEnd: frame.observationEnd } : {}), ...(frame.viewport ? { viewport: frame.viewport } : {}) } }).selection!
      if (selection.source.hostId !== this.options.hostId || selection.source.browserId !== scene.inputContext.browser.browserId || selection.source.association === 'exact-step') throw unavailable()
      scene.frame = { capturedAt: selection.capturedAt, source: selection.source,
        ...(selection.observationEnd ? { observationEnd: selection.observationEnd } : {}), ...(selection.viewport ? { viewport: selection.viewport } : {}),
        width: frame.width, height: frame.height, sha256: frame.sha256 }
    }
    if (document.preparation !== undefined) {
      const preparation = document.preparation as Preparation, attachment = scene.inputContext.selection?.attachment
      if (!preparation || !/^[a-f0-9]{64}$/u.test(preparation.intentDigest) || !attachment ||
          selectionId(identity(preparation.operationId)) !== captureId || preparation.artifact?.diskDurability !== 'confirmed' ||
          !Number.isSafeInteger(preparation.artifact.byteLength) || preparation.artifact.byteLength < 1 ||
          attachment.hostId !== this.options.hostId || attachment.path !== preparation.artifact.path || attachment.sha256 !== preparation.artifact.sha256 ||
          attachment.width !== preparation.artifact.width || attachment.height !== preparation.artifact.height) throw unavailable()
      scene.preparation = preparation
    }
    this.scenes.set(captureId, scene)
    return structuredClone(scene)
  }
}
