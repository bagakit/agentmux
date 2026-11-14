import { mintObjectId } from '@agentmux/core/object-id'
import { durableWriteFile } from '@agentmux/core'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type {
  BrowserSitePermission, BrowserSitePermissionAnswer, BrowserSitePermissionDecision,
  BrowserSitePermissionRequest, BrowserSitePermissionState
} from '../shared/browser-site-permissions.js'

const permission = z.enum(['camera', 'microphone', 'geolocation', 'notifications'])
export function browserPermissionOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.origin : null } catch { return null }
}
const origin = z.string().refine(value => browserPermissionOrigin(value) === value)
const policy = z.object({ profileId: z.string().min(1), origin, embeddingOrigin: origin, permission, allow: z.boolean() }).strict()
const document = z.object({ version: z.literal(1), policies: z.array(policy) }).strict()
type Policy = z.infer<typeof policy>
export type BrowserPermissionContext = {
  browserId: string; navigationId: string; profileId: string | null; origin: string; embeddingOrigin: string
  /** Exact native WebContents incarnation, never a public identifier. */
  owner: object
  current(): boolean
}
type Pending = { context: BrowserPermissionContext; request: BrowserSitePermissionRequest; callbacks: ((allow: boolean) => void)[] }
const key = (value: { origin: string; embeddingOrigin: string; permission: BrowserSitePermission }) => JSON.stringify([value.origin, value.embeddingOrigin, value.permission])
const policyKey = (profileId: string, value: Parameters<typeof key>[0]) => JSON.stringify([profileId, key(value)])
const sameDocument = (a: BrowserPermissionContext, b: BrowserPermissionContext) => a.browserId === b.browserId &&
  a.owner === b.owner && a.navigationId === b.navigationId && a.profileId === b.profileId && a.embeddingOrigin === b.embeddingOrigin
const sameContext = (a: BrowserPermissionContext, b: BrowserPermissionContext) => a.browserId === b.browserId &&
  a.owner === b.owner && a.navigationId === b.navigationId && a.profileId === b.profileId && a.origin === b.origin && a.embeddingOrigin === b.embeddingOrigin

/** The original native callbacks, document choices and confirmed Profile policies have separate scopes. */
export class BrowserSitePermissions {
  private policies: Policy[] = []
  private disposed = false
  private loadSettled = false
  private loadingReaders = new Set<string>()
  private issues = new WeakMap<object, string>()
  private ready: Promise<void> | undefined
  private readable = false
  private warning: string | undefined
  private writes: Promise<unknown> = Promise.resolve()
  private pending = new Map<string, Pending>()
  private choices = new Map<string, { context: BrowserPermissionContext; decisions: Map<string, BrowserSitePermissionDecision> }>()
  /** Pending or unconfirmed writes, not another saved policy source. A successful reread settles them. */
  private remembering = new Map<string, Promise<void>>()

  constructor(private readonly path: string, private readonly changed: (browserId: string) => void) {}

  unavailable(browserId: string, owner: object, reason: string): void { this.issues.set(owner, reason); this.notify(browserId) }
  unavailableState(owner: object): BrowserSitePermissionState {
    const warning = this.issues.get(owner) ?? this.warning
    return { requests: [], decisions: [], ...(warning ? { warning } : {}) }
  }

  private notify(browserId: string): void {
    try { this.changed(browserId) } catch { console.warn("Browser site permission projection was not delivered; the original decision is retained.") }
  }

  private load(): Promise<void> {
    return this.ready ??= (async () => {
      try {
        const stored = document.parse(JSON.parse(await readFile(this.path, 'utf8')))
        const ids = stored.policies.map(value => JSON.stringify([value.profileId, key(value)]))
        if (new Set(ids).size !== ids.length) throw new Error('Duplicate permission policy')
        this.policies = stored.policies
        this.readable = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.policies = []; this.readable = true }
        else this.warning = 'Saved site permissions could not be read. Existing bytes are kept. Allow once remains available; retry reading before remembering a decision.'
      } finally {
        this.loadSettled = true
        for (const id of this.loadingReaders) this.notify(id)
        this.loadingReaders.clear()
      }
    })()
  }

  async retryRead(): Promise<void> {
    const observed = new Map(this.remembering)
    const run = this.writes.then(async () => {
      await this.load()
      this.ready = undefined
      this.readable = false
      this.loadSettled = false
      this.warning = undefined
      await this.load()
      if (this.readable) for (const [id, write] of observed) if (this.remembering.get(id) === write) this.remembering.delete(id)
      for (const value of this.pending.values()) this.notify(value.context.browserId)
    })
    this.writes = run.catch(() => {})
    await run
  }

  /** Called only after the exact Profile's permanent removal; other Profile policies stay unchanged. */
  async forgetProfile(profileId: string): Promise<void> {
    const run = this.writes.then(async () => {
      await this.load()
      if (!this.readable) throw new Error('Remembered site permissions could not be read. Their original bytes are kept.')
      const policies = this.policies.filter(value => value.profileId !== profileId)
      if (policies.length === this.policies.length) return
      await mkdir(dirname(this.path), { recursive: true })
      await durableWriteFile(this.path, JSON.stringify({ version: 1, policies }, null, 2) + '\n')
      this.policies = policies
    })
    this.writes = run.catch(() => {})
    await run
  }

  private choice(context: BrowserPermissionContext, value: BrowserSitePermission): boolean | undefined {
    const local = this.choices.get(context.browserId)
    const localValue = local && sameDocument(local.context, context) ? local.decisions.get(key({ ...context, permission: value })) : undefined
    if (localValue) return localValue.allow
    return context.profileId ? this.policies.find(item => item.profileId === context.profileId &&
      item.origin === context.origin && item.embeddingOrigin === context.embeddingOrigin && item.permission === value)?.allow : undefined
  }

  /** Synchronous Chromium check. Loading is not an approval; a native request can still ask the person. */
  check(context: BrowserPermissionContext, permissions: BrowserSitePermission[]): boolean {
    void this.load()
    return !this.disposed && context.current() && permissions.length > 0 && permissions.every(value => this.choice(context, value) === true)
  }

  request(context: BrowserPermissionContext, permissions: BrowserSitePermission[], callback: (allow: boolean) => void): void {
    let answered = false
    const answer = (allow: boolean) => {
      if (answered) return
      answered = true
      try { callback(allow) } catch { console.warn('Original native permission callback did not confirm completion; it will not be replayed.') }
    }
    void this.begin(context, [...new Set(permissions)], answer).catch(() => answer(false))
  }

  private async begin(context: BrowserPermissionContext, permissions: BrowserSitePermission[], callback: (allow: boolean) => void): Promise<void> {
    const loading = this.load()
    if (this.disposed || !context.current() || permissions.length === 0) { callback(false); return }
    const decisions = permissions.map(value => this.choice(context, value))
    if (decisions.some(value => value === false)) { callback(false); return }
    if (decisions.every(value => value === true)) { callback(true); return }
    const previous = [...this.pending.values()].find(value => sameContext(value.context, context) &&
      value.request.permissions.length === permissions.length && value.request.permissions.every(item => permissions.includes(item)))
    if (previous) { previous.callbacks.push(callback); return }
    const request = { requestId: mintObjectId(), browserId: context.browserId, navigationId: context.navigationId,
      profileId: context.profileId, origin: context.origin, embeddingOrigin: context.embeddingOrigin, permissions }
    const original: Pending = { context, request, callbacks: [callback] }
    this.pending.set(request.requestId, original)
    this.notify(context.browserId)
    await loading
    if (this.pending.get(request.requestId) !== original || !original.context.current()) return
    const saved = permissions.map(value => this.choice(original.context, value))
    if (saved.some(value => value === false) || saved.every(value => value === true)) {
      this.pending.delete(request.requestId)
      for (const answer of original.callbacks) answer(saved.every(value => value === true))
      this.notify(context.browserId)
    }
  }

  state(context: BrowserPermissionContext): BrowserSitePermissionState {
    if (!this.loadSettled) this.loadingReaders.add(context.browserId)
    void this.load()
    const requests = [...this.pending.values()].filter(item => sameDocument(item.context, context) && item.context.current())
      .map(item => ({ ...item.request, permissions: [...item.request.permissions] }))
    const decisions = new Map<string, BrowserSitePermissionDecision>()
    for (const item of this.policies) if (item.profileId === context.profileId && item.embeddingOrigin === context.embeddingOrigin) {
      decisions.set(key(item), { origin: item.origin, embeddingOrigin: item.embeddingOrigin, permission: item.permission, allow: item.allow, scope: 'profile' })
    }
    const local = this.choices.get(context.browserId)
    if (local && sameDocument(local.context, context)) for (const [id, item] of local.decisions) decisions.set(id, { ...item })
    const warning = [this.warning, this.issues.get(context.owner)].filter(Boolean).join(' ')
    return { requests, decisions: [...decisions.values()], ...(warning ? { warning } : {}) }
  }

  /** Called only by the trusted App surface, never by Browser script or public Control. */
  async answer(browserId: string, answer: BrowserSitePermissionAnswer): Promise<void> {
    if (!answer || typeof answer.allow !== 'boolean' || typeof answer.remember !== 'boolean') throw new Error('A site permission decision needs an explicit choice.')
    const pending = this.pending.get(answer.requestId)
    if (!pending || pending.context.browserId !== browserId || pending.request.navigationId !== answer.navigationId || !pending.context.current()) {
      throw new Error('This site permission request no longer belongs to the original page. Inspect the same Browser before deciding again.')
    }
    const { context, request } = pending
    if (answer.remember && !context.profileId) throw new Error('Temporary Browsers cannot remember Profile site permissions. Choose a decision for this page only.')
    let local = this.choices.get(browserId)
    if (!local || !sameDocument(local.context, context)) {
      local = { context, decisions: new Map() }
      this.choices.set(browserId, local)
    }
    const applied = new Map<string, BrowserSitePermissionDecision>()
    for (const permission of request.permissions) {
      const decision: BrowserSitePermissionDecision = { origin: context.origin, embeddingOrigin: context.embeddingOrigin,
        permission, allow: answer.allow, scope: 'document' }
      local.decisions.set(key(decision), decision)
      applied.set(key(decision), decision)
    }
    // Reserve the optional write before callbacks/projection can re-enter with a later Forget.
    // It remains asynchronous: storage cannot delay the original native permission answer.
    const remembering = answer.remember ? this.save(context.profileId!, request.permissions.map(permission => ({ ...context, permission, allow: answer.allow }))) : undefined
    if (remembering) for (const permission of request.permissions) this.remembering.set(policyKey(context.profileId!, { ...context, permission }), remembering)
    this.pending.delete(request.requestId)
    for (const callback of pending.callbacks) callback(answer.allow)
    this.notify(browserId)
    // The original native choice is already answered. Optional storage cannot take it away.
    if (remembering) {
      try {
        await remembering
        const current = this.choices.get(browserId)
        if (current === local) for (const [id, decision] of applied) if (current.decisions.get(id) === decision) current.decisions.delete(id)
      } catch {
        this.readable = false
        this.warning = 'The site permission was answered for this page. Remembering the Profile decision is unconfirmed; saved bytes are kept. Retry reading before changing saved policies.'
      } finally {
        if (this.readable) for (const permission of request.permissions) {
          const id = policyKey(context.profileId!, { ...context, permission })
          if (this.remembering.get(id) === remembering) this.remembering.delete(id)
        }
      }
      this.notify(browserId)
    }
  }

  private async save(profileId: string, values: { origin: string; embeddingOrigin: string; permission: BrowserSitePermission; allow: boolean }[], remove = false): Promise<void> {
    const run = this.writes.then(async () => {
      await this.load()
      if (!this.readable) throw new Error(this.warning)
      const ids = new Set(values.map(key))
      const policies = this.policies.filter(item => item.profileId !== profileId || !ids.has(key(item)))
      if (!remove) policies.push(...values.map(value => ({ profileId, origin: value.origin, embeddingOrigin: value.embeddingOrigin, permission: value.permission, allow: value.allow })))
      await mkdir(dirname(this.path), { recursive: true })
      await durableWriteFile(this.path, JSON.stringify({ version: 1, policies }, null, 2) + '\n')
      this.policies = policies
    })
    this.writes = run.catch(() => {})
    await run
  }

  /** Forget affects future requests. Existing camera/microphone access ends when the person reloads/closes its page. */
  async forget(context: BrowserPermissionContext, decision: Pick<BrowserSitePermissionDecision, 'origin' | 'embeddingOrigin' | 'permission'>): Promise<void> {
    if (!context.current()) throw new Error('The original permission site changed. Inspect the same Browser before forgetting its decision.')
    const original = this.state(context).decisions.find(item => key(item) === key(decision))
    if (!original) throw new Error('This original site decision is no longer present. Refresh its permissions before choosing again.')
    const local = this.choices.get(context.browserId)
    const selected = local && sameDocument(local.context, context) ? local.decisions.get(key(decision)) : undefined
    const savedKey = context.profileId ? policyKey(context.profileId, decision) : undefined
    const remembering = savedKey ? this.remembering.get(savedKey) : undefined
    // A document choice may have an earlier Remember still writing. Queue removal behind it
    // even while the UI still projects document scope, so the later explicit Forget wins.
    if (context.profileId && (original.scope === 'profile' || remembering)) {
      await this.save(context.profileId, [{ ...decision, allow: false }], true)
      if (savedKey && this.remembering.get(savedKey) === remembering) this.remembering.delete(savedKey)
    }
    if (local && this.choices.get(context.browserId) === local && selected && local.decisions.get(key(decision)) === selected) local.decisions.delete(key(decision))
    this.notify(context.browserId)
  }

  /** A native same-document navigation keeps the original callbacks while updating their public navigation fence. */
  rebind(browserId: string, owner: object, current: (origin: string) => BrowserPermissionContext | null): void {
    for (const item of this.pending.values()) if (item.context.browserId === browserId && item.context.owner === owner) {
      const context = current(item.context.origin)
      if (context) { item.context = context; item.request.navigationId = context.navigationId }
    }
    const local = this.choices.get(browserId)
    if (local?.context.owner === owner) { const context = current(local.context.origin); if (context) local.context = context }
  }

  cancel(browserId: string, owner: object): void {
    if (this.choices.get(browserId)?.context.owner === owner) this.choices.delete(browserId)
    this.issues.delete(owner)
    for (const [id, item] of this.pending) if (item.context.browserId === browserId && item.context.owner === owner) {
      this.pending.delete(id)
      for (const callback of item.callbacks) callback(false)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const item of [...this.pending.values()]) this.cancel(item.context.browserId, item.context.owner)
    this.choices.clear(); this.loadingReaders.clear(); this.issues = new WeakMap(); this.remembering.clear()
  }
}
