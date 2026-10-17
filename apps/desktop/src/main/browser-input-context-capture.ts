import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, link, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError, observeRead } from '@agentmux/core'
import { parseBrowserInputContext, type BrowserInputContext } from '@agentmux/core/browser-input-context'
import {
  createAgentInputContextCaptureRecord, parseAgentInputContextCaptureRecord, parseAgentInputContextCaptureReference,
  type AgentInputContextCaptureReader, type AgentInputContextCaptureRecord, type AgentInputContextCaptureReference
} from '@agentmux/core/agent-input-context-capture'
import type { BrowserInputContextFreeze, BrowserInputContextFreezeReceipt, BrowserInputScene, BrowserInputSceneReference } from '../shared/browser-input-context-capture.js'

const unavailable = () => new AgentMuxError('The original Browser scene cannot be confirmed. Keep its reference and message; retry that original capture after restoring its owner. Other inputs remain available.', 'CONTROL_UNAVAILABLE')
const conflict = () => new AgentMuxError('This original input already names another message, recipient or Browser scene. Its retained capture was not replaced.', 'CONTROL_REQUEST_CONFLICT')
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) throw unavailable()
  return value
}

/** Exact immutable files; no directory scan, pruning, overwrite or startup dependency. */
export class BrowserInputContextCaptureFiles {
  constructor(private readonly directory: string) {}
  private path(kind: 'scene' | 'input', id: string): string {
    return join(this.directory, `${kind}-${createHash('sha256').update(id).digest('hex')}.json`)
  }
  async read(kind: 'scene' | 'input', id: string): Promise<unknown | null> {
    try { return JSON.parse(await readFile(this.path(kind, id), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  async put(kind: 'scene' | 'input', id: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = this.path(kind, id), temporary = `${path}.${randomUUID()}.partial`
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
  private readonly scenes = new Map<string, BrowserInputScene>()
  private readonly inputs = new Map<string, { scene: BrowserInputSceneReference; receipt: BrowserInputContextFreezeReceipt }>()
  private readonly pending = new Map<string, Promise<BrowserInputContextFreezeReceipt>>()
  constructor(private readonly options: {
    hostId: string
    source(browserId: string): BrowserInputContext | null
    files: BrowserInputContextCaptureFiles
  }) {}

  async capture(browserId: string): Promise<BrowserInputScene> {
    const inputContext = this.options.source(identity(browserId))
    if (!inputContext || inputContext.browser.hostId !== this.options.hostId || inputContext.browser.browserId !== browserId) throw unavailable()
    const scene: BrowserInputScene = { reference: { hostId: this.options.hostId, captureId: randomUUID() },
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

  private sceneDocument(scene: BrowserInputScene) { return { schema: 'agentmux.browser-input-scene.v1', reference: scene.reference, inputContext: scene.inputContext } }
  private async scene(reference: BrowserInputSceneReference): Promise<BrowserInputScene> {
    if (!reference || reference.hostId !== this.options.hostId) throw unavailable()
    const captureId = identity(reference.captureId), live = this.scenes.get(captureId)
    if (live) return structuredClone(live)
    let stored: unknown
    try { stored = await this.options.files.read('scene', captureId) } catch { throw unavailable() }
    if (!stored || typeof stored !== 'object') throw unavailable()
    const document = stored as Record<string, unknown>, ref = document.reference as BrowserInputSceneReference | undefined
    if (document.schema !== 'agentmux.browser-input-scene.v1' || !ref || ref.hostId !== reference.hostId || ref.captureId !== captureId) throw unavailable()
    const scene: BrowserInputScene = { reference: { hostId: ref.hostId, captureId }, inputContext: parseBrowserInputContext(document.inputContext), diskDurability: 'confirmed' }
    if (scene.inputContext.browser.hostId !== this.options.hostId) throw unavailable()
    this.scenes.set(captureId, scene)
    return structuredClone(scene)
  }
}
