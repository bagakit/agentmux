import { mintObjectId } from '@agentmux/identity'
import { createRequire } from 'node:module'
import { mkdir, open, readdir, rm, lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  parseCapsuleConfig,
  parseCapsuleInteraction,
  parseCapsuleInputObservation,
  parseCapsuleOperation,
  parseCapsuleParams,
  parseCapsulePreparedReply,
  parseCapsuleRecord,
  parseCapsuleResult,
} from './parsers.js'
import type {
  CapsuleCallContext,
  CapsuleConfig,
  CapsuleContent,
  CapsuleCreateParams,
  CapsuleInjectionPort,
  CapsuleInspection,
  CapsuleInteraction,
  CapsuleInputObservation,
  CapsuleIssue,
  CapsuleMethod,
  CapsuleMutationResult,
  CapsuleOpenResult,
  CapsuleOperation,
  CapsuleParamsMap,
  CapsulePort,
  CapsulePreparedReply,
  CapsulePresentationPort,
  CapsuleReplyPort,
  CapsuleReplyResult,
  CapsuleRecord,
  CapsuleResultMap,
} from './types.js'
import {
  CapsuleError,
  confirmDurable,
  copyTree,
  directory,
  durableMkdir,
  errorCode,
  hashKey,
  prepareImport,
  readJson,
  readOptional,
  safeFile,
  syncDirectory,
  writeJson,
} from './storage.js'
import { CapsuleHttp, endpointIssue } from './http.js'
export { CapsuleError } from './storage.js'
export interface NodeCapsuleOptions {
  stateDirectory: string
  contentRoot?: string
  injection?: CapsuleInjectionPort
  presentation?: CapsulePresentationPort
  replies?: CapsuleReplyPort
}
interface SavedRecord {
  schemaVersion: 1
  record: CapsuleRecord
  managedDirectory?: string
  removed?: true
  lastOperationId: string
  receipt: unknown
  deletion?: 'pending' | 'confirmed'
}
interface SavedOperation {
  schemaVersion: 1
  operation: CapsuleOperation
  params: unknown
  caller?: CapsuleCallContext['caller']
  principal?: CapsuleCallContext['principal']
  effect?:
    | { kind: 'record'; capsuleId: string }
    | { kind: 'config' }
    | { kind: 'interaction'; capsuleId: string; interactionId: string; inputOperationId?: string }
}
interface SavedConfig {
  schemaVersion: 1
  config: CapsuleConfig
  lastOperationId?: string
  receipt?: unknown
}
interface SavedInteraction {
  schemaVersion: 1
  interaction: CapsuleInteraction
  lastOperationId: string
  receipt: unknown
  preparedReply?: CapsulePreparedReply
}
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
function issue(
  stage: CapsuleIssue['stage'],
  code: string,
  message: string,
  capsuleId?: string,
): CapsuleIssue {
  return {
    stage,
    code,
    message,
    recovery:
      'Inspect the original object and operation, restore the exact file or permissions, then retry observation without replacing its identity.',
    ...(capsuleId ? { capsuleId } : {}),
  }
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.entries(v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`
  return JSON.stringify(v)
}
function envelope(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || (v as Record<string, unknown>).schemaVersion !== 1)
    throw new CapsuleError(
      'CAPSULE_REGISTRY_UNCONFIRMED',
      'The original saved Capsule envelope cannot be read. Its content and endpoint have been retained.',
    )
  return v as Record<string, unknown>
}
export class NodeCapsuleOwner implements CapsulePort {
  private readonly services = new Map<string, CapsuleHttp>()
  private readonly startupIssues: CapsuleIssue[] = []
  private readonly removed = new Set<string>()
  private readonly lifecycle = new AbortController()
  private readonly readers = new Set<Promise<unknown>>()
  private readonly activeMutations = new Set<string>()
  private readonly activeReconciliations = new Set<string>()
  private readonly mutationQueues = new Map<string, Promise<unknown>>()
  private readonly mutations = new Set<Promise<unknown>>()
  private closed = false
  private constructor(
    private readonly options: NodeCapsuleOptions,
    private readonly lock: Awaited<ReturnType<typeof open>>,
  ) {}
  static async open(options: NodeCapsuleOptions): Promise<NodeCapsuleOwner> {
    const stateDirectory = resolve(options.stateDirectory)
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    const lock = await open(join(stateDirectory, 'owner.lock'), 'a+', 0o600)
    if (!native.tryLock(lock.fd)) {
      await lock.close()
      throw new CapsuleError(
        'CAPSULE_OWNER_BUSY',
        'The original Capsule store already has a live owner. Connect to that owner; do not create another store.',
      )
    }
    const owner = new NodeCapsuleOwner({ ...options, stateDirectory }, lock)
    try {
      for (const dir of ['records', 'operations', 'interactions'])
        await durableMkdir(join(stateDirectory, dir)).catch((error) => {
          owner.startupIssues.push(
            issue(
              'registry',
              errorCode(error),
              'One Capsule storage area is unavailable. Other original page services remain available.',
            ),
          )
        })
      const initial = await readOptional(owner.configPath()).catch((error) => {
        owner.startupIssues.push(
          issue(
            'config',
            errorCode(error),
            'Capsule defaults cannot be read. Existing pages remain available.',
          ),
        )
        return undefined
      })
      if (initial === null) {
        const config: CapsuleConfig = {
          revision: 1,
          contentRoot: resolve(options.contentRoot ?? join(stateDirectory, 'content')),
          defaultStorageMode: 'managed',
          defaultMode: 'isolated',
          defaultTheme: 'follow',
        }
        await writeJson(owner.configPath(), { schemaVersion: 1, config }).catch((error) => {
          owner.startupIssues.push(
            issue(
              'config',
              errorCode(error),
              'Capsule defaults could not be saved. Existing registrations remain available.',
            ),
          )
        })
      } else if (initial !== undefined) {
        try {
          parseCapsuleConfig(envelope(initial).config)
        } catch (error) {
          owner.startupIssues.push(
            issue(
              'config',
              errorCode(error),
              'The original Capsule defaults are invalid. They have not been overwritten; existing registrations remain available.',
            ),
          )
        }
      }
      const entries = await owner.recordEntries().catch((error) => {
        owner.startupIssues.push(
          issue(
            'registry',
            errorCode(error),
            'The original Capsule directory cannot be enumerated. This does not confirm an empty registry or remove saved pages.',
          ),
        )
        return { records: [], issues: [] }
      })
      for (const saved of entries.records) await owner.ensureService(saved.record)
      await owner.reconcileOperations().catch((error) => {
        owner.startupIssues.push(
          issue(
            'operation',
            errorCode(error),
            'Original operation reconciliation is unavailable. Healthy page endpoints remain running and no operation has been replayed.',
          ),
        )
      })
      return owner
    } catch (error) {
      await owner.close()
      throw error
    }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifecycle.abort()
    await Promise.allSettled([...this.mutations])
    await Promise.allSettled([...this.readers])
    await Promise.allSettled([...this.services.values()].map((s) => s.close()))
    this.services.clear()
    await this.lock.close()
  }
  call<M extends CapsuleMethod>(
    method: M,
    value: CapsuleParamsMap[M],
    context?: CapsuleCallContext,
  ): Promise<CapsuleResultMap[M]> {
    const params = parseCapsuleParams(method, value)
    const originalContext: CapsuleCallContext | undefined = context
      ? {
          ...(context.caller ? { caller: structuredClone(context.caller) } : {}),
          ...(context.principal ? { principal: structuredClone(context.principal) } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        }
      : undefined
    const work = async () => {
      if (this.closed)
        throw new CapsuleError(
          'CAPSULE_OWNER_CLOSED',
          'This Capsule owner is closed. Connect to its original Host again.',
        )
      const result = await this.dispatch(method, params, originalContext)
      return parseCapsuleResult(method, result, params)
    }
    // Readers consume atomic snapshots and can observe an original pending operation
    // while a presentation adapter calls back into the owner. They must not wait
    // behind the external operation they are being asked to inspect.
    if (
      [
        'capsule.ls',
        'capsule.inspect',
        'capsule.resolve',
        'capsule.operation.inspect',
        'capsule.config.inspect',
        'capsule.interaction.ls',
        'capsule.interaction.inspect',
      ].includes(method)
    ) {
      const reading = work()
      this.readers.add(reading)
      void reading.then(
        () => this.readers.delete(reading),
        () => this.readers.delete(reading),
      )
      return reading
    }
    const input = params as { operationId: string; capsuleId?: string; interactionId?: string }
    // The original operation is unique across resource kinds. CAS replacement
    // also serializes its exact resource, never unrelated pages or observations.
    const resource = input.interactionId
      ? `interaction:${input.interactionId}`
      : method === 'capsule.update' || method === 'capsule.remove'
        ? `capsule:${input.capsuleId}`
        : method === 'capsule.config.update'
          ? 'config'
          : undefined
    const pending = this.serial(`operation:${input.operationId}`, () =>
      resource ? this.serial(resource, work) : work(),
    )
    this.mutations.add(pending)
    void pending.then(
      () => this.mutations.delete(pending),
      () => this.mutations.delete(pending),
    )
    return pending
  }
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(key) ?? Promise.resolve()
    const pending = previous.then(work, work)
    const settled = pending.then(
      () => undefined,
      () => undefined,
    )
    this.mutationQueues.set(key, settled)
    void settled.then(() => {
      if (this.mutationQueues.get(key) === settled) this.mutationQueues.delete(key)
    })
    return pending
  }
  private configPath() {
    return join(this.options.stateDirectory, 'config.json')
  }
  private recordPath(id: string) {
    return join(this.options.stateDirectory, 'records', `${id}.json`)
  }
  private operationPath(id: string) {
    return join(this.options.stateDirectory, 'operations', `${hashKey(id)}.json`)
  }
  private interactionPath(id: string, capsuleId: string) {
    return join(this.options.stateDirectory, 'interactions', capsuleId, `${id}.json`)
  }
  private async readConfig(): Promise<SavedConfig> {
    const r = envelope(await readJson(this.configPath()))
    return {
      schemaVersion: 1,
      config: parseCapsuleConfig(r.config),
      ...(typeof r.lastOperationId === 'string'
        ? { lastOperationId: r.lastOperationId, receipt: r.receipt }
        : {}),
    }
  }
  private async readRecord(id: string, allowRemoved = false): Promise<SavedRecord> {
    const raw = await readOptional(this.recordPath(id))
    if (!raw) throw new CapsuleError('CAPSULE_NOT_FOUND', 'The exact Capsule registration was not found.')
    const r = envelope(raw),
      record = parseCapsuleRecord(r.record)
    if (record.capsuleId !== id || typeof r.lastOperationId !== 'string')
      throw new CapsuleError(
        'CAPSULE_REGISTRY_UNCONFIRMED',
        'The saved registration identity is inconsistent.',
      )
    if (
      record.storageMode === 'managed' &&
      (typeof r.managedDirectory !== 'string' ||
        basename(r.managedDirectory) !== record.capsuleId ||
        dirname(record.contentRoot) !== join(r.managedDirectory, 'versions'))
    )
      throw new CapsuleError(
        'CAPSULE_REGISTRY_UNCONFIRMED',
        'The managed content boundary cannot be confirmed.',
      )
    if (r.removed && !allowRemoved)
      throw new CapsuleError('CAPSULE_REMOVED', 'The exact Capsule registration was explicitly removed.')
    return {
      schemaVersion: 1,
      record,
      lastOperationId: r.lastOperationId,
      receipt: r.receipt,
      ...(r.deletion === 'pending' || r.deletion === 'confirmed' ? { deletion: r.deletion } : {}),
      ...(r.removed === true ? { removed: true } : {}),
      ...(typeof r.managedDirectory === 'string' ? { managedDirectory: r.managedDirectory } : {}),
    }
  }
  private async recordEntries(): Promise<{ records: SavedRecord[]; issues: CapsuleIssue[] }> {
    const records: SavedRecord[] = [],
      issues: CapsuleIssue[] = []
    for (const file of await readdir(join(this.options.stateDirectory, 'records'))) {
      if (!file.endsWith('.json')) continue
      try {
        const saved = await this.readRecord(file.slice(0, -5), true)
        if (!saved.removed) records.push(saved)
      } catch (error) {
        issues.push(
          issue(
            'registry',
            errorCode(error),
            'One Capsule registration cannot be read. Its original files and running service have not been removed.',
          ),
        )
      }
    }
    return { records, issues }
  }
  private async content(record: CapsuleRecord): Promise<CapsuleContent> {
    try {
      const file = await safeFile(record.contentRoot, record.entry)
      await file.close()
      return { status: 'available', observedAt: Date.now() }
    } catch (error) {
      return {
        status: 'unavailable',
        observedAt: Date.now(),
        issue: issue(
          'content',
          errorCode(error),
          'The pinned Capsule entry is unavailable. The original registration and port are retained.',
          record.capsuleId,
        ),
      }
    }
  }
  private async ensureService(record: CapsuleRecord): Promise<CapsuleHttp> {
    if (this.closed || this.removed.has(record.capsuleId))
      return new CapsuleHttp(record, this.options.injection)
    let service = this.services.get(record.capsuleId)
    if (!service) {
      service = new CapsuleHttp(record, this.options.injection)
      this.services.set(record.capsuleId, service)
    } else if (record.revision >= service.record.revision) service.record = record
    if (!service.server.listening) await service.listen().catch(() => undefined)
    return service
  }
  private async inspect(record: CapsuleRecord, retry = false): Promise<CapsuleInspection> {
    const service = retry ? await this.ensureService(record) : this.services.get(record.capsuleId)
    const endpoint = service?.observation() ?? {
        status: 'unavailable' as const,
        port: record.port,
        observedAt: Date.now(),
        issue: endpointIssue(
          record.capsuleId,
          'CAPSULE_ENDPOINT_UNAVAILABLE',
          'The original service is not currently listening.',
        ),
      },
      content = await this.content(record)
    const issues: CapsuleIssue[] = service?.issues() ?? []
    if (content.status === 'unavailable') issues.push(content.issue)
    if (endpoint.status === 'unavailable') issues.push(endpoint.issue)
    return { record, content, endpoint, issues }
  }
  private async readOperation(operationId: string): Promise<SavedOperation | null> {
    const raw = await readOptional(this.operationPath(operationId))
    if (!raw) return null
    const r = envelope(raw),
      operation = parseCapsuleOperation(r.operation)
    if (operation.operationId !== operationId)
      throw new CapsuleError(
        'CAPSULE_OPERATION_UNCONFIRMED',
        'The original operation identity is inconsistent.',
      )
    const params = parseCapsuleParams(operation.method, r.params)
    if (operation.status === 'committed') parseCapsuleResult(operation.method, operation.result, params)
    if (operation.status === 'committed') await confirmDurable(this.operationPath(operationId))
    return r as unknown as SavedOperation
  }
  private operationProjection(saved: SavedOperation): CapsuleOperation {
    // The effect is the single durable reservation. The public projection never
    // adds a second persisted field or accepts a copied field as authority.
    const { inputOperationId: _copiedInputId, ...operation } = saved.operation
    if (saved.operation.method !== 'capsule.interaction.reply' || saved.effect?.kind !== 'interaction')
      return operation
    const params = parseCapsuleParams('capsule.interaction.reply', saved.params)
    if (
      saved.effect.capsuleId !== params.capsuleId ||
      saved.effect.interactionId !== params.interactionId ||
      saved.operation.capsuleId !== params.capsuleId
    )
      throw new CapsuleError(
        'CAPSULE_OPERATION_UNCONFIRMED',
        'The original reply reservation target is inconsistent.',
      )
    return parseCapsuleOperation({ ...operation, inputOperationId: saved.effect.inputOperationId })
  }
  private async reconcile(
    saved: SavedOperation,
    context?: CapsuleCallContext,
    external = false,
    resume = false,
  ): Promise<SavedOperation> {
    if (!external) return this.reconcileState(saved, context)
    const operationId = saved.operation.operationId
    if (this.activeMutations.has(operationId) || this.activeReconciliations.has(operationId)) return saved
    this.activeReconciliations.add(operationId)
    try {
      return await this.reconcileState(saved, context, true, resume)
    } finally {
      this.activeReconciliations.delete(operationId)
    }
  }
  private async reconcileState(
    saved: SavedOperation,
    context?: CapsuleCallContext,
    external = false,
    resume = false,
  ): Promise<SavedOperation> {
    if (saved.operation.method === 'capsule.interaction.reply')
      return this.reconcileReply(saved, context, external, resume)
    if (
      saved.operation.method === 'capsule.open' &&
      saved.operation.status === 'pending' &&
      external &&
      this.options.presentation?.inspect
    ) {
      try {
        const params = parseCapsuleParams('capsule.open', saved.params)
        const observed = await this.observeExternal(
          (ctx) => this.options.presentation!.inspect!(params, ctx),
          context,
        )
        if (observed) {
          const result = parseCapsuleResult('capsule.open', observed, params)
          const complete: SavedOperation = {
            ...saved,
            operation: { ...saved.operation, status: 'committed', updatedAt: Date.now(), result },
          }
          await writeJson(this.operationPath(saved.operation.operationId), complete)
          return complete
        }
      } catch {
        // Reading a missing presentation receipt never opens a replacement Browser.
      }
      return saved
    }
    if (saved.operation.status !== 'pending' || !saved.effect) return saved
    let committed: unknown, last: string | undefined, effectPath: string
    try {
      if (saved.effect.kind === 'record') {
        let r = await this.readRecord(saved.effect.capsuleId, true)
        effectPath = this.recordPath(saved.effect.capsuleId)
        if (r.lastOperationId === saved.operation.operationId && r.deletion === 'pending') {
          // Observation may confirm already completed removal, but must never replay rm.
          if (!r.managedDirectory) return saved
          try {
            await lstat(r.managedDirectory)
            return saved
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') return saved
          }
          await syncDirectory(dirname(r.managedDirectory))
          const receipt = { ...(r.receipt as Record<string, unknown>), deletedContent: true }
          r = { ...r, deletion: 'confirmed', receipt }
          await writeJson(effectPath, r)
        }
        last = r.lastOperationId
        committed = r.receipt
      } else if (saved.effect.kind === 'config') {
        effectPath = this.configPath()
        const c = await this.readConfig()
        last = c.lastOperationId
        committed = c.receipt
      } else {
        effectPath = this.interactionPath(saved.effect.interactionId, saved.effect.capsuleId)
        const i = await this.readInteraction(saved.effect.interactionId, saved.effect.capsuleId)
        last = i.lastOperationId
        committed = i.receipt
      }
    } catch {
      return saved
    }
    if (last !== saved.operation.operationId) return saved
    // A visible rename is not enough: confirm file and directory durability first.
    try {
      await confirmDurable(effectPath)
    } catch (error) {
      return {
        ...saved,
        operation: {
          ...saved.operation,
          issue: issue(
            'operation',
            errorCode(error),
            'The original effect is visible, but storage durability is still unconfirmed. It has not been replayed.',
          ),
        },
      }
    }
    if (saved.effect.kind === 'record') {
      const confirmed = await this.readRecord(saved.effect.capsuleId, true)
      if (confirmed.removed) {
        this.removed.add(confirmed.record.capsuleId)
        await this.services.get(confirmed.record.capsuleId)?.close()
        this.services.delete(confirmed.record.capsuleId)
      } else {
        await this.ensureService(confirmed.record)
      }
    }
    parseCapsuleResult(saved.operation.method, committed)
    const complete: SavedOperation = {
      ...saved,
      operation: { ...saved.operation, status: 'committed', updatedAt: Date.now(), result: committed },
    }
    await writeJson(this.operationPath(saved.operation.operationId), complete)
    return complete
  }
  private async reconcileOperations(): Promise<void> {
    for (const file of await readdir(join(this.options.stateDirectory, 'operations'))) {
      if (!file.endsWith('.json')) continue
      try {
        const r = envelope(await readJson(join(this.options.stateDirectory, 'operations', file)))
        const operation = parseCapsuleOperation(r.operation)
        await this.reconcile((await this.readOperation(operation.operationId))!)
      } catch (error) {
        this.startupIssues.push(
          issue(
            'operation',
            errorCode(error),
            'One original Capsule operation could not be reconciled. It has not been replayed.',
          ),
        )
      }
    }
  }
  private async mutation<M extends CapsuleMethod>(
    method: M,
    params: CapsuleParamsMap[M],
    context: CapsuleCallContext | undefined,
    effect: SavedOperation['effect'],
    work: () => Promise<CapsuleResultMap[M]>,
  ): Promise<CapsuleResultMap[M]> {
    const operationId = (params as { operationId: string }).operationId,
      original = await this.readOperation(operationId)
    if (original) {
      if (
        original.operation.method !== method ||
        canonical(original.params) !== canonical(params) ||
        canonical(original.caller ?? null) !== canonical(context?.caller ?? null) ||
        canonical(original.principal ?? null) !== canonical(context?.principal ?? null)
      )
        throw new CapsuleError(
          'CAPSULE_OPERATION_CONFLICT',
          'This operation ID belongs to a different original request or caller.',
        )
      const observed = await this.reconcile(original, context, true, method === 'capsule.interaction.reply')
      if (observed.operation.status === 'committed')
        return parseCapsuleResult(method, observed.operation.result, params)
      throw new CapsuleError(
        observed.operation.status === 'failed' ? 'CAPSULE_OPERATION_FAILED' : 'CAPSULE_OPERATION_UNKNOWN',
        'The original operation is retained. Inspect it; it has not been replayed.',
      )
    }
    const now = Date.now(),
      capsuleId =
        effect?.kind === 'record' || effect?.kind === 'interaction'
          ? effect.capsuleId
          : (params as { capsuleId?: string }).capsuleId,
      saved: SavedOperation = {
        schemaVersion: 1,
        operation: {
          operationId,
          ...(capsuleId ? { capsuleId } : {}),
          method,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        },
        params,
        ...(context?.caller ? { caller: context.caller } : {}),
        ...(context?.principal ? { principal: context.principal } : {}),
        ...(effect ? { effect } : {}),
      }
    await writeJson(this.operationPath(operationId), saved)
    this.activeMutations.add(operationId)
    try {
      const result = parseCapsuleResult(method, await work(), params)
      const status =
        method === 'capsule.interaction.reply' &&
        (result as CapsuleReplyResult).delivery.status !== 'submitted'
          ? 'pending'
          : 'committed'
      await writeJson(this.operationPath(operationId), {
        ...saved,
        operation: { ...saved.operation, status, updatedAt: Date.now(), result },
      })
      return result
    } catch (error) {
      const reconciled = await this.reconcile(saved).catch(() => saved)
      if (reconciled.operation.status === 'committed') {
        if (saved.effect?.kind === 'record') {
          const confirmed = await this.readRecord(saved.effect.capsuleId, true)
          if (!confirmed.removed) await this.ensureService(confirmed.record)
        }
        return parseCapsuleResult(method, reconciled.operation.result, params)
      }
      const knownUnapplied =
        error instanceof CapsuleError &&
        [
          'CAPSULE_REVISION_CONFLICT',
          'CAPSULE_CONTENT_UNAVAILABLE',
          'CAPSULE_SOURCE_UNSAFE',
          'CAPSULE_SOURCE_CHANGED',
          'CAPSULE_SOURCE_CONTAINS_DESTINATION',
          'CAPSULE_NOT_FOUND',
          'CAPSULE_REMOVED',
          'CAPSULE_TARGET_MISMATCH',
          'CAPSULE_INTERACTION_ANSWERED',
          'CAPSULE_TARGET_UNAVAILABLE',
          'CAPSULE_INPUT_TARGET_MISMATCH',
          'CAPSULE_TRUSTED_REPLY_REQUIRED',
          'CAPSULE_REPLY_PREPARATION_UNAVAILABLE',
        ].includes(error.code)
      if (!knownUnapplied || method === 'capsule.open') {
        try {
          const current = envelope(await readJson(this.operationPath(operationId)))
          const observed = parseCapsuleOperation(current.operation)
          // A lost directory-sync receipt can follow a visible committed journal.
          // Preserve that original result for later durability confirmation.
          if (observed.status === 'pending') {
            await writeJson(this.operationPath(operationId), {
              ...saved,
              operation: {
                ...saved.operation,
                updatedAt: Date.now(),
                issue: issue(
                  'operation',
                  errorCode(error),
                  'The original effect or its durability remains unconfirmed. It has not been replayed.',
                ),
              },
            })
          }
        } catch {
          // An unavailable journal is not permission to replace the original bytes.
        }
        throw new CapsuleError(
          'CAPSULE_OPERATION_UNKNOWN',
          'The original operation may have been applied. Inspect it to confirm the original effect; it has not been replayed.',
        )
      }
      await writeJson(this.operationPath(operationId), {
        ...saved,
        operation: {
          ...saved.operation,
          status: 'failed',
          updatedAt: Date.now(),
          issue: issue(
            'operation',
            errorCode(error),
            'The original Capsule operation did not confirm its requested mutation. Previous published content is retained.',
          ),
        },
      }).catch(() => undefined)
      throw error
    } finally {
      this.activeMutations.delete(operationId)
    }
  }
  private async readInteraction(id: string, capsuleId: string): Promise<SavedInteraction> {
    const r = envelope(await readJson(this.interactionPath(id, capsuleId))),
      interaction = parseCapsuleInteraction(r.interaction)
    if (interaction.interactionId !== id || typeof r.lastOperationId !== 'string')
      throw new CapsuleError(
        'CAPSULE_INTERACTION_UNCONFIRMED',
        'The original interaction identity cannot be confirmed.',
      )
    const preparedReply =
      r.preparedReply === undefined ? undefined : parseCapsulePreparedReply(r.preparedReply)
    if (
      preparedReply &&
      (preparedReply.capsuleId !== capsuleId ||
        preparedReply.interactionId !== id ||
        preparedReply.operationId !== interaction.reply?.operationId ||
        preparedReply.inputOperationId !== interaction.reply.delivery.inputOperationId ||
        preparedReply.expectedRun.runId !== interaction.reply.delivery.expectedRun.runId ||
        canonical(preparedReply.target) !== canonical(interaction.target))
    ) {
      throw new CapsuleError(
        'CAPSULE_INTERACTION_UNCONFIRMED',
        'The original reply envelope does not match this exact interaction.',
      )
    }
    return {
      schemaVersion: 1,
      interaction,
      lastOperationId: r.lastOperationId,
      receipt: r.receipt,
      ...(preparedReply ? { preparedReply } : {}),
    }
  }
  private async dispatch<M extends CapsuleMethod>(
    method: M,
    params: CapsuleParamsMap[M],
    context?: CapsuleCallContext,
  ): Promise<CapsuleResultMap[M]> {
    // Each case returns a value checked again against the same portable wire result parser.
    const p = params as unknown as Record<string, any>
    let result: unknown
    switch (method) {
      case 'capsule.ls': {
        const entries = await this.recordEntries()
        result = {
          capsules: await Promise.all(entries.records.map((x) => this.inspect(x.record))),
          issues: [...this.startupIssues, ...entries.issues],
        }
        break
      }
      case 'capsule.inspect':
        result = await this.inspect((await this.readRecord(p.capsuleId)).record, true)
        break
      case 'capsule.resolve': {
        const inspection = await this.inspect((await this.readRecord(p.capsuleId)).record, true)
        result = { capsuleId: p.capsuleId, endpoint: inspection.endpoint }
        break
      }
      case 'capsule.operation.inspect': {
        const saved = await this.readOperation(p.operationId)
        result = {
          operation: saved ? this.operationProjection(await this.reconcile(saved, context, true)) : null,
        }
        break
      }
      case 'capsule.config.inspect':
        result = { config: (await this.readConfig()).config }
        break
      case 'capsule.config.update':
        return this.mutation(method, params, context, { kind: 'config' }, async () => {
          const current = await this.readConfig()
          if (current.config.revision !== p.expectedRevision)
            throw new CapsuleError(
              'CAPSULE_REVISION_CONFLICT',
              'Capsule defaults changed. Read the original config and retain your edits before saving.',
            )
          if (current.lastOperationId) {
            await this.completePreviousOperation(current.lastOperationId)
          }
          const config = parseCapsuleConfig({
              ...current.config,
              ...p.changes,
              revision: current.config.revision + 1,
            }),
            receipt = { operationId: p.operationId, status: 'committed', config }
          await writeJson(this.configPath(), {
            schemaVersion: 1,
            config,
            lastOperationId: p.operationId,
            receipt,
          })
          return receipt as CapsuleResultMap[M]
        })
      case 'capsule.create':
        return this.create(params as CapsuleCreateParams, context) as Promise<CapsuleResultMap[M]>
      case 'capsule.update':
        return this.mutation(
          method,
          params,
          context,
          { kind: 'record', capsuleId: p.capsuleId },
          async () => {
            const current = await this.readRecord(p.capsuleId)
            await this.reconcileRecord(current)
            if (current.record.revision !== p.expectedRevision)
              throw new CapsuleError(
                'CAPSULE_REVISION_CONFLICT',
                'This Capsule changed. Inspect its current revision before publishing your retained changes.',
              )
            let record: CapsuleRecord = {
              ...current.record,
              ...p.changes,
              revision: current.record.revision + 1,
              updatedAt: Date.now(),
            }
            if (p.changes.sourcePath) {
              const source = await directory(p.changes.sourcePath)
              if (record.storageMode === 'managed') {
                if (!current.managedDirectory)
                  throw new CapsuleError(
                    'CAPSULE_REGISTRY_UNCONFIRMED',
                    'The managed content boundary cannot be confirmed.',
                  )
                const destination = await prepareImport(
                  source,
                  join(current.managedDirectory, 'versions', hashKey(p.operationId)),
                )
                await durableMkdir(dirname(destination))
                await copyTree(source, destination)
                record.contentRoot = destination
              } else record.contentRoot = source
            }
            record = parseCapsuleRecord(record)
            const available = await this.content(record)
            if (available.status !== 'available')
              throw new CapsuleError(
                'CAPSULE_CONTENT_UNAVAILABLE',
                'The prepared content entry cannot be read. The previous revision remains published.',
              )
            const service = this.services.get(record.capsuleId),
              inspection = await this.inspect(record)
            const receipt = { ...inspection, operationId: p.operationId, status: 'committed' as const }
            await writeJson(this.recordPath(record.capsuleId), {
              ...current,
              record,
              lastOperationId: p.operationId,
              receipt,
            })
            if (service) service.record = record
            else await this.ensureService(record)
            return receipt as CapsuleResultMap[M]
          },
        )
      case 'capsule.remove':
        return this.mutation(
          method,
          params,
          context,
          { kind: 'record', capsuleId: p.capsuleId },
          async () => {
            const current = await this.readRecord(p.capsuleId)
            await this.reconcileRecord(current)
            if (current.record.revision !== p.expectedRevision)
              throw new CapsuleError(
                'CAPSULE_REVISION_CONFLICT',
                'This Capsule changed before removal. Inspect its exact current revision.',
              )
            let receipt = {
              operationId: p.operationId,
              status: 'committed' as const,
              capsuleId: p.capsuleId as string,
              deletedContent: false,
            }
            const deleteManaged = p.deleteContent === true && current.record.storageMode === 'managed'
            if (deleteManaged && current.managedDirectory) {
              try {
                const canonical = await directory(current.managedDirectory)
                if (canonical !== current.managedDirectory) {
                  throw new CapsuleError(
                    'CAPSULE_SOURCE_UNSAFE',
                    'The pinned managed boundary changed. Content deletion was not authorized for another path.',
                  )
                }
              } catch (error) {
                if (errorCode(error) !== 'ENOENT') throw error
              }
            }
            await writeJson(this.recordPath(p.capsuleId), {
              ...current,
              removed: true,
              lastOperationId: p.operationId,
              receipt,
              ...(deleteManaged ? { deletion: 'pending' } : {}),
            })
            this.removed.add(p.capsuleId)
            await this.services.get(p.capsuleId)?.close()
            this.services.delete(p.capsuleId)
            if (deleteManaged && current.managedDirectory) {
              await rm(current.managedDirectory, { recursive: true, force: true })
              await syncDirectory(dirname(current.managedDirectory))
              receipt = { ...receipt, deletedContent: true }
              await writeJson(this.recordPath(p.capsuleId), {
                ...current,
                removed: true,
                lastOperationId: p.operationId,
                receipt,
                deletion: 'confirmed',
              })
            }
            return receipt as CapsuleResultMap[M]
          },
        )
      case 'capsule.open':
        return this.mutation(method, params, context, undefined, async () => {
          const inspection = await this.inspect((await this.readRecord(p.capsuleId)).record, true),
            resolved = { capsuleId: p.capsuleId as string, endpoint: inspection.endpoint }
          return (
            this.options.presentation
              ? await this.present(params as CapsuleParamsMap['capsule.open'], context, resolved)
              : {
                  operationId: p.operationId,
                  capsuleId: p.capsuleId,
                  endpoint: inspection.endpoint,
                  rendering: {
                    status: 'unavailable',
                    reason:
                      'This Host has no Browser presentation adapter. The Capsule HTTP endpoint remains independently available.',
                  },
                }
          ) as CapsuleResultMap[M]
        })
      case 'capsule.interaction.request': {
        const id = mintObjectId()
        return this.mutation(
          method,
          params,
          context,
          { kind: 'interaction', capsuleId: p.capsuleId, interactionId: id },
          async () => {
            const record = (await this.readRecord(p.capsuleId)).record,
              now = Date.now(),
              interaction: CapsuleInteraction = {
                interactionId: id,
                capsuleId: record.capsuleId,
                operationId: p.operationId,
                revision: 1,
                question: p.question,
                draft: p.draft ?? '',
                createdAt: now,
                updatedAt: now,
                status: 'pending',
                ...(record.target ? { target: record.target } : {}),
              },
              receipt = { operationId: p.operationId, interaction }
            await writeJson(this.interactionPath(id, p.capsuleId), {
              schemaVersion: 1,
              interaction,
              lastOperationId: p.operationId,
              receipt,
            })
            return receipt as CapsuleResultMap[M]
          },
        )
      }
      case 'capsule.interaction.ls': {
        await this.readRecord(p.capsuleId)
        const interactions: CapsuleInteraction[] = [],
          issues: CapsuleIssue[] = []
        for (const file of await readdir(
          join(this.options.stateDirectory, 'interactions', p.capsuleId),
        ).catch((error) => {
          if (errorCode(error) === 'ENOENT') return []
          throw error
        })) {
          if (!file.endsWith('.json')) continue
          try {
            const { interaction } = await this.readInteraction(file.slice(0, -5), p.capsuleId)
            if (interaction.capsuleId === p.capsuleId) interactions.push(interaction)
          } catch (error) {
            issues.push(
              issue(
                'interaction',
                errorCode(error),
                'One original interaction cannot be read. Its data has been retained.',
                p.capsuleId,
              ),
            )
          }
        }
        result = { interactions, issues }
        break
      }
      case 'capsule.interaction.inspect': {
        let current = await this.readInteraction(p.interactionId, p.capsuleId)
        if (current.preparedReply && current.interaction.reply) {
          const operation = await this.readOperation(current.interaction.reply.operationId)
          if (operation) await this.reconcile(operation, context, true)
          current = await this.readInteraction(p.interactionId, p.capsuleId)
        }
        const { interaction } = current
        if (interaction.capsuleId !== p.capsuleId)
          throw new CapsuleError('CAPSULE_TARGET_MISMATCH', 'This interaction belongs to another Capsule.')
        result = { interaction }
        break
      }
      case 'capsule.interaction.draft':
        return this.mutation(
          method,
          params,
          context,
          { kind: 'interaction', capsuleId: p.capsuleId, interactionId: p.interactionId },
          async () => {
            const current = await this.readInteraction(p.interactionId, p.capsuleId)
            await this.completePreviousOperation(current.lastOperationId)
            if (current.interaction.capsuleId !== p.capsuleId)
              throw new CapsuleError(
                'CAPSULE_TARGET_MISMATCH',
                'This interaction belongs to another Capsule.',
              )
            if (current.interaction.revision !== p.expectedRevision)
              throw new CapsuleError(
                'CAPSULE_REVISION_CONFLICT',
                'The original draft changed. Read its current revision before saving your retained edits.',
              )
            if (current.interaction.status !== 'pending')
              throw new CapsuleError(
                'CAPSULE_INTERACTION_ANSWERED',
                'This original interaction already has a saved answer.',
              )
            const interaction = {
                ...current.interaction,
                draft: p.draft as string,
                revision: current.interaction.revision + 1,
                updatedAt: Date.now(),
              },
              receipt = { operationId: p.operationId, interaction }
            await writeJson(this.interactionPath(p.interactionId, p.capsuleId), {
              schemaVersion: 1,
              interaction,
              lastOperationId: p.operationId,
              receipt,
            })
            return receipt as CapsuleResultMap[M]
          },
        )
      case 'capsule.interaction.reply':
        return this.reply(params as CapsuleParamsMap['capsule.interaction.reply'], context) as Promise<
          CapsuleResultMap[M]
        >
    }
    return result as CapsuleResultMap[M]
  }
  private async reconcileRecord(record: SavedRecord): Promise<void> {
    await this.completePreviousOperation(record.lastOperationId)
  }
  private async completePreviousOperation(operationId: string): Promise<void> {
    const original = await this.readOperation(operationId)
    if (!original || (await this.reconcile(original)).operation.status !== 'committed') {
      throw new CapsuleError(
        'CAPSULE_OPERATION_UNKNOWN',
        'The previous mutation on this exact object has not confirmed durability. Inspect its original operation before replacing its recovery marker.',
      )
    }
  }
  private requireReplyContext(context: CapsuleCallContext | undefined): CapsuleCallContext {
    if (!context?.principal || context.caller) {
      throw new CapsuleError(
        'CAPSULE_TRUSTED_REPLY_REQUIRED',
        'A managed Agent or page declaration cannot authenticate a Human reply. Use the original trusted App confirmation.',
      )
    }
    return context
  }
  private unknownInput(prepared: CapsulePreparedReply, reason: string): CapsuleInputObservation {
    return {
      status: 'unknown',
      inputOperationId: prepared.inputOperationId,
      expectedRun: prepared.expectedRun,
      reason,
    }
  }
  private checkedInput(value: unknown, prepared: CapsulePreparedReply): CapsuleInputObservation {
    const observation = parseCapsuleInputObservation(value)
    if (
      observation.inputOperationId !== prepared.inputOperationId ||
      observation.expectedRun.runId !== prepared.expectedRun.runId
    ) {
      throw new CapsuleError(
        'CAPSULE_INPUT_TARGET_MISMATCH',
        'The input observation belongs to another original input or Run. The saved reply has not been retargeted.',
      )
    }
    return observation
  }
  private async saveReply(
    current: SavedInteraction,
    phase: NonNullable<CapsuleInteraction['reply']>['phase'],
    delivery: CapsuleInputObservation,
  ): Promise<SavedInteraction> {
    const prepared = current.preparedReply!
    const interaction: CapsuleInteraction = {
      ...current.interaction,
      reply: { operationId: prepared.operationId, phase, delivery },
    }
    const receipt: CapsuleReplyResult = { operationId: prepared.operationId, interaction, delivery }
    const saved: SavedInteraction = { ...current, interaction, receipt }
    await writeJson(this.interactionPath(interaction.interactionId, interaction.capsuleId), saved)
    return saved
  }
  private async submitSavedReply(
    current: SavedInteraction,
    context: CapsuleCallContext,
  ): Promise<SavedInteraction> {
    const prepared = current.preparedReply!
    if (current.interaction.reply?.phase !== 'prepared') return current
    this.requireReplyContext(context)
    if (canonical(context.principal) !== canonical(prepared.principal)) {
      throw new CapsuleError(
        'CAPSULE_OPERATION_CONFLICT',
        'The original saved reply belongs to a different trusted principal.',
      )
    }
    // This durable boundary is written before the possibly executing call. Once
    // crossed, every path observes the original Core input rather than submitting.
    current = await this.saveReply(
      current,
      'dispatch-started',
      this.unknownInput(
        prepared,
        'The original answer is saved. Its Core input submission is not yet confirmed.',
      ),
    )
    let delivery: CapsuleInputObservation
    try {
      delivery = this.checkedInput(
        await this.observeExternal(
          (ctx) => this.options.replies!.submit(structuredClone(prepared), ctx),
          context,
        ),
        prepared,
      )
    } catch {
      delivery = this.unknownInput(
        prepared,
        'The original Core input submission could not be confirmed. Inspect its original input key; the reply has not been resent.',
      )
    }
    return this.saveReply(
      current,
      delivery.status === 'submitted' ? 'observed' : 'dispatch-started',
      delivery,
    )
  }
  private async reply(
    params: CapsuleParamsMap['capsule.interaction.reply'],
    context?: CapsuleCallContext,
  ): Promise<CapsuleReplyResult> {
    if (!this.options.replies) {
      throw new CapsuleError(
        'CAPSULE_TRUSTED_REPLY_UNAVAILABLE',
        'This Host has no trusted user input adapter. Page scripts and ordinary HTTP cannot authenticate a Human reply.',
      )
    }
    const trustedContext = this.requireReplyContext(context)
    const inputOperationId = mintObjectId()
    return this.mutation(
      'capsule.interaction.reply',
      params,
      trustedContext,
      {
        kind: 'interaction',
        capsuleId: params.capsuleId,
        interactionId: params.interactionId,
        inputOperationId,
      },
      async () => {
        let current = await this.readInteraction(params.interactionId, params.capsuleId)
        if (current.interaction.capsuleId !== params.capsuleId)
          throw new CapsuleError(
            'CAPSULE_TARGET_MISMATCH',
            'This original interaction belongs to another Capsule.',
          )
        await this.completePreviousOperation(current.lastOperationId)
        if (current.interaction.revision !== params.expectedRevision)
          throw new CapsuleError(
            'CAPSULE_REVISION_CONFLICT',
            'The original interaction changed. Retain the answer and inspect the current revision before confirming.',
          )
        if (current.interaction.status !== 'pending')
          throw new CapsuleError(
            'CAPSULE_INTERACTION_ANSWERED',
            'This original interaction already has a saved answer.',
          )
        if (!current.interaction.target)
          throw new CapsuleError(
            'CAPSULE_TARGET_UNAVAILABLE',
            'This original request has no exact Agent target. The answer has not been sent to a selected or replacement Agent.',
          )
        let prepared: CapsulePreparedReply
        try {
          prepared = parseCapsulePreparedReply(
            await this.observeExternal(
              (ctx) =>
                this.options.replies!.prepare(
                  {
                    interaction: structuredClone(current.interaction),
                    answer: params.answer,
                    inputOperationId,
                    operationId: params.operationId,
                  },
                  ctx,
                ),
              trustedContext,
            ),
          )
        } catch (error) {
          const denied =
            errorCode(error) === 'CONTROL_PERMISSION_DENIED' ||
            errorCode(error) === 'CAPSULE_TRUSTED_REPLY_REQUIRED'
          throw new CapsuleError(
            denied ? 'CAPSULE_TRUSTED_REPLY_REQUIRED' : 'CAPSULE_REPLY_PREPARATION_UNAVAILABLE',
            'Trusted preparation did not confirm this exact reply. No Core input was submitted; the original answer intent is retained.',
          )
        }
        if (
          prepared.operationId !== params.operationId ||
          prepared.capsuleId !== params.capsuleId ||
          prepared.interactionId !== params.interactionId ||
          prepared.inputOperationId !== inputOperationId ||
          canonical(prepared.target) !== canonical(current.interaction.target) ||
          canonical(prepared.principal) !== canonical(trustedContext.principal)
        ) {
          throw new CapsuleError(
            'CAPSULE_INPUT_TARGET_MISMATCH',
            'The trusted preparation did not confirm the exact original request, recipient, input or principal. No reply was submitted.',
          )
        }
        const delivery = this.unknownInput(
          prepared,
          'The original answer and exact input are saved. Submission has not started.',
        )
        const interaction: CapsuleInteraction = {
          ...current.interaction,
          status: 'answered',
          answer: params.answer,
          revision: current.interaction.revision + 1,
          updatedAt: Date.now(),
          reply: { operationId: params.operationId, phase: 'prepared', delivery },
        }
        const receipt: CapsuleReplyResult = { operationId: params.operationId, interaction, delivery }
        current = {
          schemaVersion: 1,
          interaction,
          preparedReply: prepared,
          lastOperationId: params.operationId,
          receipt,
        }
        await writeJson(this.interactionPath(params.interactionId, params.capsuleId), current)
        current = await this.submitSavedReply(current, trustedContext)
        return parseCapsuleResult('capsule.interaction.reply', current.receipt, params)
      },
    )
  }
  private async reconcileReply(
    saved: SavedOperation,
    context?: CapsuleCallContext,
    external = false,
    resume = false,
  ): Promise<SavedOperation> {
    if (saved.operation.status === 'failed' || saved.effect?.kind !== 'interaction') return saved
    let current: SavedInteraction
    try {
      current = await this.readInteraction(saved.effect.interactionId, saved.effect.capsuleId)
      if (
        current.lastOperationId !== saved.operation.operationId ||
        !current.preparedReply ||
        !current.interaction.reply
      )
        return saved
      await confirmDurable(this.interactionPath(saved.effect.interactionId, saved.effect.capsuleId))
    } catch {
      return saved
    }
    const prepared = current.preparedReply!
    if (
      prepared.operationId !== saved.operation.operationId ||
      prepared.capsuleId !== saved.operation.capsuleId ||
      saved.effect.inputOperationId !== prepared.inputOperationId ||
      canonical(saved.principal) !== canonical(prepared.principal)
    ) {
      return {
        ...saved,
        operation: {
          ...saved.operation,
          issue: issue(
            'interaction',
            'CAPSULE_INPUT_TARGET_MISMATCH',
            'The original reply recovery envelope could not be correlated. No input was submitted or retargeted.',
            prepared.capsuleId,
          ),
        },
      }
    }
    if (external && this.options.replies) {
      if (resume && current.interaction.reply!.phase === 'prepared' && context) {
        current = await this.submitSavedReply(current, this.requireReplyContext(context))
      } else if (current.interaction.reply!.phase !== 'prepared') {
        let next: CapsuleInputObservation
        try {
          const original = await this.observeExternal(
            (ctx) => this.options.replies!.inspect(structuredClone(prepared), ctx),
            context,
          )
          next = original
            ? this.checkedInput(original, prepared)
            : this.unknownInput(
                prepared,
                'The original Core input was not found by this observation. Absence does not authorize resubmission.',
              )
        } catch {
          next = this.unknownInput(
            prepared,
            'Current Core input observation is unavailable. The original saved answer, Run and input identity are retained.',
          )
        }
        const previous = current.interaction.reply!.delivery
        if (previous.status === 'submitted' && next.status !== 'submitted') {
          next = {
            ...previous,
            reason:
              next.reason ?? 'The original Core receipt is retained; its current observation is unavailable.',
          }
        }
        current = await this.saveReply(
          current,
          next.status === 'submitted' ? 'observed' : 'dispatch-started',
          next,
        )
      }
    }
    const result = parseCapsuleResult(
      'capsule.interaction.reply',
      current.receipt,
      parseCapsuleParams('capsule.interaction.reply', saved.params),
    )
    const status = result.delivery.status === 'submitted' ? 'committed' : 'pending'
    const operation: CapsuleOperation = {
      ...saved.operation,
      status,
      updatedAt: Date.now(),
      result,
      ...(status === 'pending'
        ? {
            issue: issue(
              'interaction',
              'CAPSULE_INPUT_UNCONFIRMED',
              result.delivery.reason ?? 'The original Core input is not yet confirmed.',
              prepared.capsuleId,
            ),
          }
        : {}),
    }
    if (status === 'committed') delete operation.issue
    const observed: SavedOperation = { ...saved, operation }
    await writeJson(this.operationPath(saved.operation.operationId), observed)
    return observed
  }
  private async observeExternal<T>(
    work: (context: CapsuleCallContext) => Promise<T>,
    context?: CapsuleCallContext,
  ): Promise<T> {
    const signal = context?.signal
      ? AbortSignal.any([this.lifecycle.signal, context.signal])
      : this.lifecycle.signal
    if (signal.aborted)
      throw new CapsuleError(
        'CAPSULE_OPERATION_UNKNOWN',
        'Observation was cancelled. The original operation is retained.',
      )
    return new Promise<T>((accept, reject) => {
      const aborted = () =>
        reject(
          new CapsuleError(
            'CAPSULE_OPERATION_UNKNOWN',
            'Observation ended without confirmation. The original operation must not be replayed.',
          ),
        )
      signal.addEventListener('abort', aborted, { once: true })
      void Promise.resolve()
        .then(() => work({ ...context, signal }))
        .then(accept, reject)
        .finally(() => signal.removeEventListener('abort', aborted))
    })
  }
  private async present(
    params: CapsuleParamsMap['capsule.open'],
    context: CapsuleCallContext | undefined,
    resolved: CapsuleResultMap['capsule.resolve'],
  ): Promise<CapsuleOpenResult> {
    return this.observeExternal((ctx) => this.options.presentation!.open(params, ctx, resolved), context)
  }
  private async create(
    params: CapsuleCreateParams,
    context?: CapsuleCallContext,
  ): Promise<CapsuleMutationResult> {
    const capsuleId = mintObjectId()
    return this.mutation('capsule.create', params, context, { kind: 'record', capsuleId }, async () => {
      const config = (await this.readConfig()).config,
        storageMode = params.storageMode ?? config.defaultStorageMode,
        source = await directory(params.sourcePath),
        now = Date.now(),
        initialManagedDirectory = storageMode === 'managed' ? join(config.contentRoot, capsuleId) : undefined
      let managedDirectory = initialManagedDirectory
      let contentRoot = source
      if (managedDirectory) {
        contentRoot = await prepareImport(
          source,
          join(managedDirectory, 'versions', hashKey(params.operationId)),
        )
        managedDirectory = dirname(dirname(contentRoot))
        await durableMkdir(dirname(contentRoot))
        await copyTree(source, contentRoot)
      }
      let record: CapsuleRecord = {
        capsuleId,
        title: params.title ?? basename(source),
        revision: 1,
        storageMode,
        contentRoot,
        sourcePath: resolve(params.sourcePath),
        entry: params.entry ?? 'index.html',
        routing: params.routing ?? 'file',
        mode: params.mode ?? config.defaultMode,
        theme: params.theme ?? config.defaultTheme,
        port: 0,
        createdAt: now,
        updatedAt: now,
        ...(params.source ? { source: params.source } : {}),
        ...(params.target ? { target: params.target } : {}),
        ...(context?.caller ? { caller: context.caller } : {}),
      }
      const content = await this.content(record)
      if (content.status !== 'available')
        throw new CapsuleError(
          'CAPSULE_CONTENT_UNAVAILABLE',
          'The exact source entry cannot be read. No page has been published.',
        )
      const service = new CapsuleHttp(record, this.options.injection)
      await service.listen()
      record = parseCapsuleRecord(service.record)
      try {
        const endpoint = service.observation(),
          issues: CapsuleIssue[] = []
        const receipt: CapsuleMutationResult = {
          record,
          content,
          endpoint,
          issues,
          operationId: params.operationId,
          status: 'committed',
        }
        await writeJson(this.recordPath(capsuleId), {
          schemaVersion: 1,
          record,
          ...(managedDirectory ? { managedDirectory } : {}),
          lastOperationId: params.operationId,
          receipt,
        })
        this.services.set(capsuleId, service)
        return receipt
      } catch (error) {
        await service.close()
        throw error
      }
    })
  }
}
export type { CapsulePort, CapsuleCallContext } from './types.js'
