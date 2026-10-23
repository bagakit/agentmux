import { mintObjectId } from '@agentmux/identity'
import { createRequire } from 'node:module'
import { mkdir, open, readdir, rm, lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  parseCapsuleConfig,
  parseCapsuleInteraction,
  parseCapsuleOperation,
  parseCapsuleParams,
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
  CapsuleIssue,
  CapsuleMethod,
  CapsuleMutationResult,
  CapsuleOpenResult,
  CapsuleOperation,
  CapsuleParamsMap,
  CapsulePort,
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
  presentation?: {
    open(
      params: CapsuleParamsMap['capsule.open'],
      context: CapsuleCallContext | undefined,
      resolved: CapsuleResultMap['capsule.resolve'],
    ): Promise<CapsuleOpenResult>
  }
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
    | { kind: 'interaction'; capsuleId: string; interactionId: string }
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
  private queue: Promise<unknown> = Promise.resolve()
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
    await this.queue.catch(() => undefined)
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
    const pending = this.queue.then(work, work)
    this.queue = pending.catch(() => undefined)
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
    if (record.mode === 'injected' && !this.options.injection)
      issues.push(
        issue(
          'injection',
          'CAPSULE_INJECTION_UNAVAILABLE',
          'This Host has no trusted document injection adapter. The original page is served without App capabilities.',
          record.capsuleId,
        ),
      )
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
  private async reconcile(saved: SavedOperation): Promise<SavedOperation> {
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
      const observed = await this.reconcile(original)
      if (observed.operation.status === 'committed')
        return parseCapsuleResult(method, observed.operation.result, params)
      throw new CapsuleError(
        observed.operation.status === 'failed' ? 'CAPSULE_OPERATION_FAILED' : 'CAPSULE_OPERATION_UNKNOWN',
        'The original operation is retained. Inspect it; it has not been replayed.',
      )
    }
    const now = Date.now(),
      saved: SavedOperation = {
        schemaVersion: 1,
        operation: { operationId, method, status: 'pending', createdAt: now, updatedAt: now },
        params,
        ...(context?.caller ? { caller: context.caller } : {}),
        ...(context?.principal ? { principal: context.principal } : {}),
        ...(effect ? { effect } : {}),
      }
    await writeJson(this.operationPath(operationId), saved)
    try {
      const result = parseCapsuleResult(method, await work(), params)
      await writeJson(this.operationPath(operationId), {
        ...saved,
        operation: { ...saved.operation, status: 'committed', updatedAt: Date.now(), result },
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
    return { schemaVersion: 1, interaction, lastOperationId: r.lastOperationId, receipt: r.receipt }
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
        result = { operation: saved ? (await this.reconcile(saved)).operation : null }
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
        const { interaction } = await this.readInteraction(p.interactionId, p.capsuleId)
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
        throw new CapsuleError(
          'CAPSULE_TRUSTED_REPLY_UNAVAILABLE',
          'This Host has no trusted user input adapter. Page scripts and ordinary HTTP cannot authenticate a Human reply.',
        )
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
  private async present(
    params: CapsuleParamsMap['capsule.open'],
    context: CapsuleCallContext | undefined,
    resolved: CapsuleResultMap['capsule.resolve'],
  ): Promise<CapsuleOpenResult> {
    const signal = context?.signal
      ? AbortSignal.any([this.lifecycle.signal, context.signal])
      : this.lifecycle.signal
    if (signal.aborted)
      throw new CapsuleError(
        'CAPSULE_OPERATION_UNKNOWN',
        'Presentation observation was cancelled. The original operation is retained.',
      )
    return new Promise<CapsuleOpenResult>((accept, reject) => {
      const aborted = () =>
        reject(
          new CapsuleError(
            'CAPSULE_OPERATION_UNKNOWN',
            'Presentation observation ended without confirmation. The original operation must not be replayed.',
          ),
        )
      signal.addEventListener('abort', aborted, { once: true })
      void this.options
        .presentation!.open(params, { ...context, signal }, resolved)
        .then(accept, reject)
        .finally(() => signal.removeEventListener('abort', aborted))
    })
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
        if (record.mode === 'injected' && !this.options.injection)
          issues.push(
            issue(
              'injection',
              'CAPSULE_INJECTION_UNAVAILABLE',
              'This Host has no trusted document injection adapter. The original page is served without App capabilities.',
              record.capsuleId,
            ),
          )
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
