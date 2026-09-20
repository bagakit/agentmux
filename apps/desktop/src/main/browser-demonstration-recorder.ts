import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { durableWriteFile } from '@agentmux/core'
import type { BrowserReplayTarget } from '../shared/browser-operation.js'
import type { BrowserDemonstrationDocument, BrowserDemonstrationDraft, BrowserDemonstrationStep } from '../shared/browser-demonstration.js'

export const BROWSER_DEMONSTRATION_FILE = 'browser-demonstration-drafts.json'
const MAX_DRAFTS = 32
const MAX_STEPS = 128
const MAX_TEXT = 240
const MAX_URL = 2_048
const NATIVE_INPUT_WINDOW_MS = 2_000
const CLICK_INPUTS = new Set(['mouseDown', 'mouseUp', 'pointerDown', 'touchStart', 'keyDown', 'rawKeyDown', 'char'])
const FILL_INPUTS = new Set(['keyDown', 'rawKeyDown', 'char'])
const NATIVE_INPUTS = new Set([...CLICK_INPUTS, ...FILL_INPUTS])

export interface BrowserDemonstrationStore {
  load(): Promise<BrowserDemonstrationDocument | null>
  save(document: BrowserDemonstrationDocument): Promise<void>
}

/** Disk facts belong to Main; this store contains semantic drafts, never input values. */
export class BrowserDemonstrationFileStore implements BrowserDemonstrationStore {
  private saveTail: Promise<void> = Promise.resolve()
  constructor(private readonly path: string) {}

  async load(): Promise<BrowserDemonstrationDocument | null> {
    let content: string
    try { content = await readFile(this.path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    return normalizeDocument(JSON.parse(content))
  }

  async save(document: BrowserDemonstrationDocument): Promise<void> {
    const snapshot = copy(document)
    const operation = this.saveTail.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await durableWriteFile(this.path, `${JSON.stringify(snapshot, null, 2)}\n`)
    })
    this.saveTail = operation.then(() => {}, () => {})
    await operation
  }
}

type NativeInput = { browserId: string; navigationId: string; type: string; at?: number }
export type BrowserDemonstrationEvent = {
  browserId: string
  navigationId: string
  kind: 'click' | 'fill'
  isTrusted: boolean
  /** Main supplies an AX identity only after verifying the actual event target. */
  target?: BrowserReplayTarget | Promise<BrowserReplayTarget | undefined>
}
export type BrowserDemonstrationNavigation = {
  browserId: string
  fromNavigationId: string
  navigationId: string
  url: string
  origin?: 'page' | 'toolbar'
  isTrusted?: boolean
}

/**
 * Explicit recording only. Main owns native input provenance and isolated-world capture; page
 * payloads cannot create a gesture or supply an input value. A recording is an editable draft,
 * never permission to execute its clicks. This module does not drive pages or Agent processes.
 */
export class BrowserDemonstrationRecorder {
  private document: BrowserDemonstrationDocument = { version: 1, drafts: [] }
  private loaded: Promise<void> | undefined
  private tail: Promise<void> = Promise.resolve()
  private gestures = new Map<string, { navigationId: string; type: string; at: number }>()
  private warning: string | undefined
  private loadUnavailable = false
  private readonly now: () => number
  private readonly makeId: () => string

  constructor(private readonly store: BrowserDemonstrationStore, options: { now?: () => number; id?: () => string } = {}) {
    this.now = options.now ?? Date.now
    this.makeId = options.id ?? randomUUID
  }

  async ready(): Promise<void> {
    this.loaded ??= this.load()
    await this.loaded
  }

  getPersistenceWarning(): string | undefined { return this.warning }

  async start(input: { browserId: string; navigationId: string; url: string }): Promise<BrowserDemonstrationDraft> {
    return this.change(async () => {
      const browserId = identity(input.browserId)
      const existing = this.current(browserId)
      if (existing?.status === 'recording') return copy(existing)
      if (this.document.drafts.length >= MAX_DRAFTS) throw new Error('Recording draft budget reached; retain or remove existing drafts before recording again.')
      const at = this.now()
      const draft: BrowserDemonstrationDraft = {
        id: identity(this.makeId()), browserId, navigationId: identity(input.navigationId),
        url: safeUrl(input.url), revision: 1, status: 'recording', startedAt: at, updatedAt: at, steps: []
      }
      this.document.drafts.push(draft)
      this.gestures.delete(browserId)
      await this.persist()
      return copy(draft)
    })
  }

  /** Only call this from the Browser's native input listener while no Agent is driving it. */
  noteNativeInput(input: NativeInput): void {
    const draft = this.current(input.browserId)
    if (draft?.status !== 'recording' || !NATIVE_INPUTS.has(input.type)) return
    const at = input.at ?? this.now()
    if (!Number.isFinite(at)) return
    this.gestures.set(input.browserId, { navigationId: input.navigationId, type: input.type, at })
  }

  async recordBrowserDemonstration(input: BrowserDemonstrationEvent): Promise<BrowserDemonstrationDraft | null> {
    // Attest at ingress; a slow durable write must not expire an already captured human event.
    const recordedAt = this.now()
    const gesture = this.recentGesture(input.browserId, input.navigationId)
    return this.change(async () => {
      const draft = this.current(input.browserId)
      if (draft?.status !== 'recording' || draft.navigationId !== input.navigationId || input.isTrusted !== true || (input.kind !== 'click' && input.kind !== 'fill')) return null
      if (!gesture || !(input.kind === 'fill' ? FILL_INPUTS : CLICK_INPUTS).has(gesture.type)) return null
      // Capture attestation before AX work; resolving the actual target can take longer than a gesture.
      const target = safeTarget(await input.target)
      const previous = draft.steps.at(-1)
      // No values are captured, so typing another character into this field adds no semantic fact.
      if (input.kind === 'fill' && previous?.method === 'fillInput' && previous.navigationId === input.navigationId &&
          target && JSON.stringify(previous.target) === JSON.stringify(target)) return copy(draft)
      if (draft.steps.length >= MAX_STEPS) return this.limit(draft)
      const sequence = draft.steps.length + 1
      draft.steps.push({
        id: identity(this.makeId()), sequence, recordedAt, navigationId: draft.navigationId,
        source: 'native-human', method: input.kind === 'fill' ? 'fillInput' : 'click', url: draft.url,
        args: [], ...(target ? { target } : {}),
        ...(input.kind === 'fill' ? { inputKey: `input-${sequence}` } : {}),
        blockedReason: !target ? 'The demonstrated target could not be verified; locate it before replay.'
          : input.kind === 'fill' ? 'Supply a fresh parameter before replay; input values were not recorded.'
          : 'Review this demonstrated click before replay; its side effects are not inferred.'
      })
      await this.updated(draft)
      return copy(draft)
    })
  }

  async navigated(input: BrowserDemonstrationNavigation): Promise<BrowserDemonstrationDraft | null> {
    const recordedAt = this.now()
    const gesture = this.recentGesture(input.browserId, input.fromNavigationId)
    return this.change(async () => {
      const draft = this.current(input.browserId)
      if (draft?.status !== 'recording' || draft.navigationId !== input.fromNavigationId) return null
      const human = input.origin === 'toolbar' && input.isTrusted === true
      const url = safeUrl(input.url)
      draft.navigationId = identity(input.navigationId)
      this.gestures.delete(input.browserId)
      if (draft.steps.length >= MAX_STEPS) return this.limit(draft)
      draft.steps.push({
        id: identity(this.makeId()), sequence: draft.steps.length + 1, recordedAt,
        navigationId: draft.navigationId, source: human ? 'native-human' : 'navigation',
        method: 'gotoUrl', url, args: url ? [url] : [],
        blockedReason: !human && !gesture ? 'Navigation provenance is unknown; inspect the destination before replay.'
          : !human ? 'Navigation followed a native gesture; inspect its effects before replay.'
          : url !== input.url ? 'URL details were not retained; supply the reviewed destination before replay.'
          : 'Review the demonstrated destination before replay.'
      })
      // Subsequent human steps belong to the new page, even when the navigation cause is unknown.
      draft.url = url
      await this.updated(draft)
      return copy(draft)
    })
  }

  async stop(browserId: string): Promise<BrowserDemonstrationDraft | null> {
    return this.change(async () => {
      const draft = this.current(browserId)
      this.gestures.delete(browserId)
      if (!draft) return null
      if (draft.status === 'recording') { draft.status = 'stopped'; await this.updated(draft) }
      return copy(draft)
    })
  }

  async get(browserId: string): Promise<BrowserDemonstrationDraft | null> {
    await this.ready()
    const draft = this.current(browserId)
    return draft ? copy(draft) : null
  }
  async list(): Promise<BrowserDemonstrationDraft[]> { await this.ready(); return copy(this.document.drafts) }

  private current(browserId: string): BrowserDemonstrationDraft | undefined {
    for (let index = this.document.drafts.length - 1; index >= 0; index -= 1) {
      const draft = this.document.drafts[index]
      if (draft?.browserId === browserId) return draft
    }
    return undefined
  }
  private recentGesture(browserId: string, navigationId: string) {
    const gesture = this.gestures.get(browserId)
    const elapsed = gesture ? this.now() - gesture.at : -1
    return gesture?.navigationId === navigationId && elapsed >= 0 && elapsed <= NATIVE_INPUT_WINDOW_MS ? gesture : undefined
  }
  private async change<T>(action: () => Promise<T>): Promise<T> {
    await this.ready()
    const operation = this.tail.then(action)
    this.tail = operation.then(() => {}, () => {})
    return operation
  }
  private async updated(draft: BrowserDemonstrationDraft): Promise<void> {
    draft.updatedAt = this.now()
    draft.revision += 1
    await this.persist()
  }
  private async limit(draft: BrowserDemonstrationDraft): Promise<BrowserDemonstrationDraft> {
    draft.status = 'stopped'
    draft.warning = 'Recording reached its step budget. Review the draft before starting another recording.'
    this.gestures.delete(draft.browserId)
    await this.updated(draft)
    return copy(draft)
  }
  private async persist(): Promise<void> {
    if (this.loadUnavailable) return
    try { await this.store.save(copy(this.document)); this.warning = undefined }
    catch { this.warning = 'Recording could not be saved. The live draft is available; restore storage to save it.' }
  }
  private async load(): Promise<void> {
    try {
      this.document = normalizeDocument(await this.store.load() ?? { version: 1, drafts: [] })
      let recovered = false
      for (const draft of this.document.drafts) {
        if (draft.status !== 'recording') continue
        draft.status = 'interrupted'
        draft.warning = 'Recording was interrupted by restart. Review the draft and explicitly start a new recording.'
        draft.revision += 1
        draft.updatedAt = this.now()
        recovered = true
      }
      if (recovered) await this.persist()
    } catch {
      this.loadUnavailable = true
      this.warning = 'Recording history could not be loaded. Live drafts remain available without persistence; restore the recording file and restart to retry.'
    }
  }
}

function copy<T>(value: T): T { return structuredClone(value) }
function identity(value: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_TEXT || /\p{White_Space}|\p{Cc}/u.test(value)) throw new Error('Invalid recording identity')
  return value
}
function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}\p{White_Space}]+/gu, ' ').trim().slice(0, MAX_TEXT) : ''
}
function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && value !== 'about:blank') return ''
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    const result = url.toString()
    return result.length <= MAX_URL ? result : ''
  } catch { return '' }
}
function safeTarget(value: BrowserReplayTarget | undefined): BrowserReplayTarget | undefined {
  if (!value || !Number.isSafeInteger(value.ordinal) || !Number.isSafeInteger(value.count) || value.ordinal < 1 || value.count < value.ordinal) return undefined
  const role = text(value.role); const name = text(value.name)
  if (!role || !name) return undefined
  return { role, name, ordinal: value.ordinal, count: value.count }
}
function normalizeDocument(value: unknown): BrowserDemonstrationDocument {
  if (!value || typeof value !== 'object' || (value as BrowserDemonstrationDocument).version !== 1 || !Array.isArray((value as BrowserDemonstrationDocument).drafts)) throw new Error('Invalid recording document')
  const raw = value as BrowserDemonstrationDocument
  if (raw.drafts.length > MAX_DRAFTS) throw new Error('Recording document exceeds budget')
  const drafts = raw.drafts.map(draft => {
    if (!draft || !['recording', 'stopped', 'interrupted'].includes(draft.status) || !Number.isSafeInteger(draft.revision) || draft.revision < 1 ||
        !Number.isFinite(draft.startedAt) || !Number.isFinite(draft.updatedAt) || !Array.isArray(draft.steps) || draft.steps.length > MAX_STEPS) throw new Error('Invalid recording draft')
    return {
      id: identity(draft.id), browserId: identity(draft.browserId), navigationId: identity(draft.navigationId), url: safeUrl(draft.url),
      revision: draft.revision, status: draft.status, startedAt: draft.startedAt, updatedAt: draft.updatedAt,
      ...(draft.warning ? { warning: text(draft.warning) } : {}),
      steps: draft.steps.map((step, index) => {
        if (!step || step.sequence !== index + 1 || !Number.isFinite(step.recordedAt) || !['click', 'fillInput', 'gotoUrl'].includes(step.method) ||
            !['native-human', 'navigation'].includes(step.source)) throw new Error('Invalid recording step')
        const target = safeTarget(step.target)
        const url = safeUrl(step.url)
        return {
          id: identity(step.id), sequence: step.sequence, navigationId: identity(step.navigationId), recordedAt: step.recordedAt,
          source: step.source, method: step.method, url, args: step.method === 'gotoUrl' && url ? [url] : [],
          ...(target ? { target } : {}), ...(step.method === 'fillInput' ? { inputKey: `input-${step.sequence}` } : {}),
          blockedReason: text(step.blockedReason) || 'Review this recorded step before replay.'
        } satisfies BrowserDemonstrationStep
      })
    } satisfies BrowserDemonstrationDraft
  })
  if (new Set(drafts.map(draft => draft.id)).size !== drafts.length) throw new Error('Duplicate recording identity')
  return { version: 1, drafts }
}
