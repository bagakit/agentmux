import { createHash } from 'node:crypto'
import { mkdir, open, opendir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AgentMuxError, durableWriteFile, mintObjectId, parseSpaceCloseParams, parseSpaceClosePlan, parseSpaceCloseProjection,
  parseSpaceCloseReceipt, parseSpaceCloseActor, parseSpaceCloseListParams, parseSpaceCloseCommitResult, parseTerminalControlResult, spaceCloseDecisions, spaceCloseDigest,
  type SpaceCloseApply, type SpaceCloseContext, type SpaceCloseMethod, type SpaceCloseParams, type SpaceClosePort,
  type SpaceClosePrepare, type SpaceCloseListParams, type SpaceCloseList, type SpaceCloseSummary, type SpaceCloseResults, type SpaceCloseProjection, type SpaceCloseReceipt, type SpaceCloseResource,
  type SpaceCloseResourceResult, type SpaceClosePlan, type SpaceCloseCommitResult } from '@agentmux/core'
import type { WorkbenchUserStateStore } from './workbench-user-state.js'

export type WorkbenchClosePorts = {
  authority(): SpaceClosePlan['authority']
  capture(input: SpaceClosePrepare): Promise<SpaceCloseProjection>
  prepareTerminal(resource: Extract<SpaceCloseResource, { kind: 'session' }>, operationId: string): Promise<NonNullable<SpaceClosePlan['children'][number]['terminal']>>
  reserve(record: SpaceCloseReceipt): Promise<void>
  validate(record: SpaceCloseReceipt, key: string): Promise<void>
  effect(resource: SpaceCloseResource, child: SpaceClosePlan['children'][number], context: SpaceCloseContext): Promise<SpaceCloseResourceResult>
  commit(record: SpaceCloseReceipt): Promise<SpaceCloseCommitResult>
  release(record: SpaceCloseReceipt): Promise<void>
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const same = (left: unknown, right: unknown) => spaceCloseDigest(left) === spaceCloseDigest(right)
const unavailable = (message: string) => new AgentMuxError(message + ' Keep the original operation and workface; no replacement close was authorized.', 'WORKBENCH_CLOSE_UNCONFIRMED')
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }

/** Thin independent members under the original Main user-state owner. No layout/draft copy or hot-write history. */
export class WorkbenchCloseOwner implements SpaceClosePort {
  private readonly observed = new Map<string, SpaceCloseReceipt>()
  private readonly acknowledgedImages = new Map<string, string>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly observationVersions = new Map<string, number>()
  private readonly directory: string
  private readonly ownerId: string
  constructor(store: Pick<WorkbenchUserStateStore, 'path'>, private readonly ports: WorkbenchClosePorts) { this.directory = store.path + '.close-operations'; this.ownerId = spaceCloseDigest(store.path) }
  private path(id: string): string { return join(this.directory, hash(id) + '.json') }
  private async marker(path: string, value: unknown): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await syncDirectory(dirname(this.directory))
    const handle = await open(path, 'wx', 0o600).catch(error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error })
    if (!handle) return false
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync() } finally { await handle.close() }
    await syncDirectory(this.directory)
    return true
  }
  private async exists(path: string): Promise<boolean> {
    try { const handle = await open(path, 'r'); await handle.close(); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  private async read(id: string, diskOnly = false): Promise<SpaceCloseReceipt | null> {
    if (!diskOnly && this.observed.has(id)) return structuredClone(this.observed.get(id)!)
    let image: string
    try { image = await readFile(this.path(id), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (await this.exists(this.path(id) + '.prepare') || await this.exists(this.path(id) + '.apply')) throw unavailable('The admitted close record is missing.')
      return null
    }
    let record: SpaceCloseReceipt
    try { record = parseSpaceCloseReceipt(JSON.parse(image)) } catch (error) { throw unavailable('Reading original close ' + id + ' is unconfirmed: ' + String(error)) }
    if (record.operationId !== id) throw unavailable('The original close record answers another operation.')
    record.diskDurability = this.acknowledgedImages.get(id) === hash(image) ? 'confirmed' : 'unconfirmed'
    // A readable prepared image cannot refute an original apply claim whose later write was lost.
    if (record.phase === 'prepared' && await this.exists(this.path(id) + '.apply')) {
      record.outcome = 'unknown'; record.issue = 'An original apply claim exists; its dispatch or result is unconfirmed. Inspect this operation, without applying again.'
    }
    return record
  }
  private save(record: SpaceCloseReceipt, initial = false): Promise<void> {
    const id = record.operationId, version = (this.observationVersions.get(id) ?? 0) + 1
    this.observationVersions.set(id, version); record.updatedAt = Math.max(record.updatedAt, Date.now()); record.diskDurability = 'unconfirmed'; this.observed.set(id, structuredClone(record))
    const writing = (this.writes.get(id) ?? Promise.resolve()).then(() => this.saveCurrent(record, initial, version))
    const tail = writing.finally(() => { if (this.writes.get(id) === tail) this.writes.delete(id) })
    this.writes.set(id, tail); return writing
  }
  private async saveCurrent(record: SpaceCloseReceipt, initial: boolean, version: number): Promise<void> {
    const id = record.operationId
    this.acknowledgedImages.delete(id)
    try {
      if (!initial) {
        const previous = await this.read(id, true)
        if (!previous || previous.planDigest !== record.planDigest || !same(previous.request, record.request) || !same(previous.preparedBy, record.preparedBy)) throw unavailable('The original close member changed or disappeared.')
      }
      const image = JSON.stringify({ ...record, diskDurability: 'confirmed' }) + '\n'
      await durableWriteFile(this.path(id), image, { mode: 0o600, requireDirectorySync: true })
      this.acknowledgedImages.set(id, hash(image))
      if (this.observationVersions.get(id) === version) { record.diskDurability = 'confirmed'; this.observed.delete(id) }
    } catch (error) {
      record.issue = 'Original close facts are retained in this owner; receipt persistence is unconfirmed. ' + String(error)
      this.observed.set(id, structuredClone(record))
    }
  }
  private authorizeRead(record: SpaceCloseReceipt, context: SpaceCloseContext): void {
    if (context.actor.kind === 'agent' && !same(context.actor, record.preparedBy)) throw new AgentMuxError('A managed Agent can read only its own redacted close plan.', 'CONTROL_PERMISSION_DENIED')
  }
  private samePrepare(record: SpaceCloseReceipt, request: SpaceClosePrepare, context: SpaceCloseContext): void {
    this.authorizeRead(record, context)
    if (!same(record.request, request) || !same(record.preparedBy, context.actor)) throw new AgentMuxError('This original close operation belongs to another preparation. Inspect it; do not replace its plan.', 'WORKBENCH_CLOSE_CONFLICT')
  }
  private async prepare(input: SpaceClosePrepare, context: SpaceCloseContext): Promise<SpaceCloseReceipt> {
    const prior = await this.read(input.operationId)
    if (prior) { this.samePrepare(prior, input, context); return prior }
    await context.assertCurrent?.(); context.signal?.throwIfAborted()
    const authority = this.ports.authority(), projection = parseSpaceCloseProjection(await this.ports.capture(input))
    const children: SpaceClosePlan['children'] = []
    for (const resource of projection.resources) {
      const operationId = mintObjectId()
      let terminal: SpaceClosePlan['children'][number]['terminal'] = null, issue: SpaceClosePlan['children'][number]['issue'] = null
      if (resource.kind === 'session' && resource.control.kind === 'terminal') {
        try { terminal = await this.ports.prepareTerminal(resource, operationId) }
        catch { issue = 'native-unconfirmed' }
      }
      children.push({ key: resource.key, operationId, terminal, issue })
    }
    if (!same(authority, this.ports.authority())) throw unavailable('The original workface document changed while preparing.')
    const plan = parseSpaceClosePlan({ authority, target: input.target, keepAgentSessions: input.keepAgentSessions, projection, children })
    const preparedAt = Date.now()
    const record: SpaceCloseReceipt = { operationId: input.operationId, request: input, plan, planDigest: spaceCloseDigest(plan), preparedBy: context.actor,
      approvedBy: null, decisions: [], preparedAt, updatedAt: preparedAt, phase: 'prepared', outcome: 'prepared',
      resources: children.map(c => ({ key: c.key, operationId: c.operationId, outcome: 'pending', receipt: null })),
      clientProjection: { applied: false, removedRegions: [], retainedRegions: projection.surfaces.map(s => s.owner.regionId), save: null }, spatialContribution: { save: null }, diskDurability: 'unconfirmed' }
    await context.assertCurrent?.(); context.signal?.throwIfAborted()
    // Permanent atomic admission; an absent result after this marker is unknown, never new.
    if (!await this.marker(this.path(input.operationId) + '.prepare', { planDigest: record.planDigest, request: input, preparedBy: context.actor, preparedAt: record.preparedAt })) {
      const original = await this.read(input.operationId)
      if (!original) throw unavailable('The original close preparation is still unconfirmed.')
      this.samePrepare(original, input, context); return original
    }
    await this.save(record, true)
    return structuredClone(record)
  }
  private async observeEffect(record: SpaceCloseReceipt, index: number, resource: SpaceCloseResource, child: SpaceClosePlan['children'][number], context: SpaceCloseContext): Promise<SpaceCloseResourceResult> {
    const pending = this.ports.effect(resource, child, context)
    let timer: NodeJS.Timeout | undefined, expired = false
    try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(unavailable('This child result is unconfirmed after five seconds; its original effect was not cancelled.')) }, 5_000)
    })]) }
    finally {
      if (timer) clearTimeout(timer)
      if (expired) void pending.then(async result => {
        // A late original ACK updates only its retained facts, never the projection a second time.
        const resources = [...record.resources]; resources[index] = result
        parseSpaceCloseReceipt({ ...record, resources }); record.resources = resources
        await this.save(record)
      }).catch(error => { record.issue = [record.issue, 'The original late child result remains unconfirmed: ' + String(error)].filter(Boolean).join('\n') })
    }
  }
  private async apply(input: SpaceCloseApply, context: SpaceCloseContext): Promise<SpaceCloseReceipt> {
    if (context.actor.kind === 'agent') throw new AgentMuxError('A managed Agent cannot approve discard, Stop or Browser close.', 'CONTROL_PERMISSION_DENIED')
    const record = await this.read(input.operationId)
    if (!record || record.planDigest !== input.expectedPlanDigest) throw unavailable('The exact original prepared plan is unavailable or has another digest.')
    const sorted = (values: unknown[]) => values.map(spaceCloseDigest).sort()
    if (!same(sorted(input.decisions), sorted(spaceCloseDecisions(record.plan)))) throw new AgentMuxError('Confirm every exact original draft and resource decision, without duplicates or substitutions.', 'WORKBENCH_CLOSE_DECISIONS_REQUIRED')
    if (record.phase !== 'prepared' || record.outcome !== 'prepared') {
      if (record.approvedBy && (!same(record.approvedBy, context.actor) || !same(sorted(record.decisions), sorted(input.decisions)))) throw new AgentMuxError('The original apply belongs to another actor or decision. Read its original receipt.', 'WORKBENCH_CLOSE_CONFLICT')
      return record
    }
    await context.assertCurrent?.(); context.signal?.throwIfAborted()
    if (!same(record.plan.authority, this.ports.authority())) throw unavailable('The original workface document was replaced. Its prepared plan remains readable.')
    // wx is the exact durable at-most-once apply claim, never an expiring lease.
    if (!await this.marker(this.path(input.operationId) + '.apply', { planDigest: record.planDigest, approvedBy: context.actor, decisions: input.decisions })) {
      const original = await this.read(input.operationId)
      if (!original) throw unavailable('The original apply result is unavailable.')
      return original
    }
    record.approvedBy = context.actor; record.decisions = input.decisions; record.phase = 'applying'; record.outcome = 'unknown'
    await this.save(record)
    if (record.diskDurability !== 'confirmed') return structuredClone(record)
    try {
      await this.ports.reserve(record)
      await Promise.all(record.plan.children.map(async child => {
        const index = record.resources.findIndex(r => r.key === child.key), resource = record.plan.projection.resources.find(r => r.key === child.key)!
        try {
          await context.assertCurrent?.(); context.signal?.throwIfAborted()
          if (!same(record.plan.authority, this.ports.authority())) throw unavailable('The original workface document changed before this child effect.')
          await this.ports.validate(record, child.key)
          if (child.issue) throw unavailable('The original raw Native fence was unconfirmed at preparation.')
          record.resources[index] = await this.observeEffect(record, index, resource, child, context)
          // Validate the real child receipt against its frozen original before consuming it.
          parseSpaceCloseReceipt(record)
        } catch (error) {
          record.resources[index] = { key: child.key, operationId: child.operationId, outcome: 'unknown', receipt: null, issue: String(error) }
        }
        await this.save(record)
      }))
      while (this.writes.has(record.operationId)) await this.writes.get(record.operationId)
      if (record.diskDurability !== 'confirmed') return structuredClone(record)
      const committed = parseSpaceCloseCommitResult(await this.ports.commit(record))
      record.clientProjection = committed.clientProjection; record.spatialContribution = committed.spatialContribution
      record.phase = 'settled'
      record.outcome = record.clientProjection.retainedRegions.length || record.resources.some(r => r.outcome !== 'acknowledged') ? 'partial'
        : record.clientProjection.save?.diskDurability === 'confirmed' && record.spatialContribution.save?.diskDurability === 'confirmed' ? 'applied' : 'unknown'
    } catch (error) {
      record.phase = 'settled'; record.outcome = 'unknown'; record.issue = String(error)
    } finally { await this.ports.release(record).catch(error => { record.issue = [record.issue, 'Releasing original close reservation is unconfirmed: ' + String(error)].filter(Boolean).join('\n') }) }
    await this.save(record)
    return structuredClone(record)
  }
  private async list(value: SpaceCloseListParams, context: SpaceCloseContext): Promise<SpaceCloseList> {
    const input = parseSpaceCloseListParams(value), actorScope = spaceCloseDigest(context.actor), cursor = input.cursor
    if (cursor && (cursor.ownerId !== this.ownerId || cursor.actorScope !== actorScope)) throw new AgentMuxError('This close cursor belongs to another owner or actor. Begin a new live-page read.', 'WORKBENCH_CLOSE_CURSOR_EXPIRED')
    const limit = input.limit ?? 25, selected: string[] = []
    const choose = (member: string) => {
      if (cursor && member <= cursor.afterMember || selected.includes(member)) return
      selected.push(member); selected.sort(); if (selected.length > limit + 1) selected.pop()
    }
    let namespaceMissing = false
    try {
      const directory = await opendir(this.directory)
      for await (const entry of directory) {
        const match = /^([a-f0-9]{64})\.json(?:\.(?:prepare|apply))?$/u.exec(entry.name)
        if (match) choose(match[1]!)
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') namespaceMissing = true; else throw unavailable('Reading the original close namespace failed: ' + String(error)) }
    // Exceptional live ACK custody remains discoverable even when its disk member vanished.
    for (const id of this.observed.keys()) choose(hash(id))
    const more = selected.length > limit, members = selected.slice(0, limit), items: SpaceCloseSummary[] = [], issues: SpaceCloseList['issues'] = []
    const belongs = (actor: SpaceCloseReceipt['preparedBy']) => context.actor.kind !== 'agent' || same(actor, context.actor)
    for (const member of members) {
      await context.assertCurrent?.(); context.signal?.throwIfAborted()
      try {
        const held = [...this.observed.values()].find(r => hash(r.operationId) === member)
        const raw = held ?? parseSpaceCloseReceipt(JSON.parse(await readFile(join(this.directory, member + '.json'), 'utf8')))
        if (hash(raw.operationId) !== member) throw unavailable('The original close member answers another operation.')
        if (!belongs(raw.preparedBy)) continue
        const record = held ?? await this.read(raw.operationId)
        if (!record) throw unavailable('The original close record disappeared during this read.')
        this.authorizeRead(record, context)
        items.push({ operationId: record.operationId, target: record.request.target, preparedBy: record.preparedBy, phase: record.phase, outcome: record.outcome,
          preparedAt: record.preparedAt, updatedAt: record.updatedAt, planDigest: record.planDigest, diskDurability: record.diskDurability })
        if (held && namespaceMissing) issues.push({ code: 'member-unconfirmed', member: context.actor.kind === 'agent' ? null : member })
      } catch {
        // A confirmed admission marker can name an unknown result; it never grants another apply.
        try {
          const marker = JSON.parse(await readFile(join(this.directory, member + '.json.prepare'), 'utf8')) as Record<string, unknown>
          const request = parseSpaceCloseParams('space.close.prepare', marker.request), preparedBy = parseSpaceCloseActor(marker.preparedBy)
          if (hash(request.operationId) !== member || typeof marker.planDigest !== 'string' || !Number.isSafeInteger(marker.preparedAt) || Number(marker.preparedAt) < 0) throw unavailable('The original close admission marker is malformed.')
          if (!belongs(preparedBy)) continue
          items.push({ operationId: request.operationId, target: request.target, preparedBy, phase: 'unconfirmed', outcome: 'unknown', preparedAt: marker.preparedAt as number,
            updatedAt: marker.preparedAt as number, planDigest: marker.planDigest, diskDurability: 'unconfirmed' })
        } catch { /* Source membership is unknown, not an empty successful page. */ }
        issues.push({ code: 'member-unconfirmed', member: context.actor.kind === 'agent' ? null : member })
      }
    }
    return { ownerId: this.ownerId, observedAt: Date.now(), coverage: 'live-page', availability: issues.length ? 'partial' : 'complete', items,
      nextCursor: more ? { ownerId: this.ownerId, actorScope, afterMember: members.at(-1)! } : null, issues }
  }
  async call<M extends SpaceCloseMethod>(method: M, value: SpaceCloseParams[M], context: SpaceCloseContext): Promise<SpaceCloseResults[M]> {
    const input = parseSpaceCloseParams(method, value)
    if (method === 'space.close.ls') return await this.list(input as SpaceCloseListParams, context) as SpaceCloseResults[M]
    if (method === 'space.close.prepare') return { operation: await this.prepare(input as SpaceClosePrepare, context) } as SpaceCloseResults[M]
    if (method === 'space.close.apply') return { operation: await this.apply(input as SpaceCloseApply, context) } as SpaceCloseResults[M]
    const operation = await this.read((input as { operationId: string }).operationId)
    if (operation) this.authorizeRead(operation, context)
    return { operation } as SpaceCloseResults[M]
  }
}

/** Production composition: the Renderer owns topology/drafts, each original resource owns its effect. */
export function createDesktopWorkbenchCloseOwner(input: {
  store: Pick<WorkbenchUserStateStore, 'path'>
  bridge: import('./control-ipc-bridge.js').DesktopControlIpcBridge
  authority(): SpaceClosePlan['authority']
  runtime: Pick<import('./runtime-controller.js').RuntimeController, 'prepareWorkbenchCloseTerminal' | 'callOriginalCore'>
  closeBrowser(browserId: string): Promise<void>
}): WorkbenchCloseOwner {
  const renderer = async (request: import('../shared/workbench-close-control.js').WorkbenchCloseRendererRequest) => {
    const result = await input.bridge.execute(request)
    if (result.operation !== request.operation || result.requestId !== request.requestId) throw unavailable('The original workface returned another close reply.')
    return result
  }
  return new WorkbenchCloseOwner(input.store, {
    authority: input.authority,
    capture: async request => {
      const result = await renderer({ operation: 'workbench.close.capture', requestId: mintObjectId(), input: request })
      if (result.operation !== 'workbench.close.capture') throw unavailable('The original close plan was not returned.')
      return parseSpaceCloseProjection(result.projection)
    },
    prepareTerminal: async (resource, operationId) => {
      if (resource.control.kind !== 'terminal') throw unavailable('The original resource is not a raw Terminal.')
      return await input.runtime.prepareWorkbenchCloseTerminal(resource.control, operationId)
    },
    reserve: async record => { await renderer({ operation: 'workbench.close.reserve', requestId: mintObjectId(), record }) },
    validate: async (record, key) => { await renderer({ operation: 'workbench.close.validate', requestId: mintObjectId(), record, key }) },
    release: async record => { await renderer({ operation: 'workbench.close.release', requestId: mintObjectId(), record }) },
    commit: async record => {
      const result = await renderer({ operation: 'workbench.close.commit', requestId: mintObjectId(), record })
      if (result.operation !== 'workbench.close.commit') throw unavailable('The original projection commit result was not returned.')
      return parseSpaceCloseCommitResult(result.result)
    },
    effect: async (resource, child, context) => {
      let receipt: SpaceCloseResourceResult['receipt']
      if (resource.kind === 'browser') {
        await input.closeBrowser(resource.browserId)
        receipt = { kind: 'browser-closed', browserId: resource.browserId }
      } else if (resource.control.kind === 'terminal') {
        if (!child.terminal) throw unavailable('The original raw Native target was unconfirmed at preparation.')
        const original = { ...child.terminal, target: { ...child.terminal.target, hostId: 'local' } }, { action: _action, ...wire } = original
        const ack = await input.runtime.callOriginalCore(resource.control.hostId, 'terminal.stop', wire, context.originalContext)
        const parsed = parseTerminalControlResult(ack, original)
        if (context.actor.kind === 'device' && !same(parsed.actor, context.actor)) throw unavailable('The original device was not preserved by the raw child transport.')
        receipt = { ...parsed, target: { ...parsed.target, hostId: resource.control.hostId } }
      } else {
        const result = await input.runtime.callOriginalCore(resource.control.hostId, 'agent.stop', {
          target: { kind: 'agent-run', agentSessionId: resource.control.agentSessionId }, expectedRun: resource.control.run, operationId: child.operationId
        }, context.originalContext)
        if (!result.receipt) throw unavailable('The original exact-Run Agent Stop receipt was not returned.')
        receipt = result.receipt
        if (receipt.expectedRun.runId !== resource.control.run.runId) throw unavailable('The original Agent Stop returned another Run.')
      }
      return { key: child.key, operationId: child.operationId, outcome: 'action' in receipt && !['applied', 'no-op'].includes(receipt.outcome) ? 'unknown' : 'acknowledged', receipt }
    }
  })
}
