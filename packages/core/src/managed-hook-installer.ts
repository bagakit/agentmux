import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { AgentMuxError } from './errors.js'
import { inspectManagedHookContent, prepareMergedHookContent, type AgentHookMergeStrategy } from './hook-config-merge.js'
import type { AgentProviderId } from './types.js'

const MAX_HOOK_FILE_BYTES = 256 * 1024
const MAX_HOOK_MUTATIONS = 8
const MAX_PENDING_PREVIEWS = 4

export type AgentManagedHookMutation = {
  path: string
  /**
   * The AgentMux-owned content. With no `merge` it is the entire file (safe only for files AgentMux
   * exclusively owns). With `merge` it is the owned fragment combined into the file on disk so foreign
   * entries survive — required for shared configs like antigravity's `~/.gemini/config/hooks.json`.
   */
  content: string
  mode?: number
  merge?: AgentHookMergeStrategy
}

export type AgentManagedHookPlan = {
  providerId: AgentProviderId
  mutations: readonly AgentManagedHookMutation[]
}

export type AgentManagedHookInspection = {
  providerId: AgentProviderId
  checkedAt: number
  status: 'installed' | 'not_installed' | 'partial' | 'error' | 'skipped'
  code: string
  action: string | null
  targets: Array<{ path: string; status: 'current' | 'not_present' | 'partial' | 'error'; code?: string }>
}

export type AgentManagedHookPreview = {
  id: string
  providerId: AgentProviderId
  changes: Array<{
    path: string
    action: 'create' | 'replace' | 'unchanged'
    currentHash: string | null
    nextHash: string
  }>
}

export type AgentManagedHookInstallReceipt = {
  id: string
  providerId: AgentProviderId
  installedAt: number
  entries: Array<{
    path: string
    installedHash: string
    previousHash: string | null
    previousMode: number | null
    backupPath: string | null
  }>
}

type PreparedMutation = AgentManagedHookMutation & {
  currentHash: string | null
  currentMode: number | null
  /** Content actually written: merged with the file on disk when a strategy is set, else `content`. */
  effectiveContent: string
  nextHash: string
  registration?: PreparedRegistration
}

type HookScope = { providerId: AgentProviderId; path: string; merge: AgentHookMergeStrategy }
type HookOwner = { receiptId: string; content: string | null }
type HookRegistration = { version: 1; scope: HookScope; before: HookOwner | null; after: HookOwner;
  previousHash: string | null; nextHash: string; backupPath: string | null; committed: boolean }
type PreparedRegistration = { scope: HookScope; path: string; raw: string | null; owner: HookOwner | null; nextOwnedContent: string | null; changed: boolean }
type RegistrationBackup = { scope: HookScope; before: boolean }

type InstallMutation = PreparedMutation & {
  currentContent: Uint8Array | null
}

type PreparedPreview = {
  preview: AgentManagedHookPreview
  mutations: PreparedMutation[]
}

function hash(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function scope(providerId: AgentProviderId, mutation: AgentManagedHookMutation): HookScope | undefined {
  const merge = mutation.merge
  // An exclusive key already carries deletion authority; shared declarations require receipts.
  return merge && merge.kind !== 'json-owned-key' ? { providerId, path: mutation.path, merge: { kind: merge.kind } } : undefined
}
function registrationPath(stateRoot: string, original: HookScope): string {
  return join(stateRoot, 'receipts', `${hash(JSON.stringify(original))}.ownership.json`)
}
function registrationError(): never {
  throw new AgentMuxError('Managed Hook registration is unconfirmed for this exact scope. The current callbacks are retained. Restore a reviewed before/after configuration from its original receipt, then inspect or repair again.', 'HOOK_REGISTRATION_UNCONFIRMED')
}
/** Same private receipt owner as target backups; no scan or native configuration writes. */
async function readRegistrationFile(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    // Before/after fragments are JSON encoded again; YAML's JSON projection can
    // exceed its native file size. This separate budget covers both format expansion and scope metadata.
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_HOOK_FILE_BYTES * 8) return registrationError()
    const bytes = await readFile(path)
    if (bytes.byteLength > MAX_HOOK_FILE_BYTES * 8) return registrationError()
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof AgentMuxError) throw error
    return registrationError()
  }
}
function owner(value: unknown): value is HookOwner {
  const candidate = value as HookOwner | null
  return Boolean(candidate && typeof candidate.receiptId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/u.test(candidate.receiptId) &&
    (candidate.content === null || typeof candidate.content === 'string'))
}
function registration(raw: string, original: HookScope, currentHash: string | null): { state: HookRegistration; owner: HookOwner | null } {
  let state: HookRegistration
  try { state = JSON.parse(raw) } catch { return registrationError() }
  if (!state || state.version !== 1 || JSON.stringify(state.scope) !== JSON.stringify(original) ||
      !(state.before === null || owner(state.before)) || !owner(state.after) || typeof state.committed !== 'boolean' ||
      !(state.previousHash === null || typeof state.previousHash === 'string' && /^[a-f0-9]{64}$/u.test(state.previousHash)) ||
      typeof state.nextHash !== 'string' || !/^[a-f0-9]{64}$/u.test(state.nextHash) ||
      !(state.backupPath === null || typeof state.backupPath === 'string')) return registrationError()
  // Pending writes are decided only by exact original bytes. A committed receipt also
  // survives unrelated user edits; its exact leaves still must match before retirement.
  if (currentHash === state.nextHash) return { state, owner: state.after }
  if (currentHash === state.previousHash) return { state, owner: state.before }
  if (state.committed) return { state, owner: state.after }
  return registrationError()
}
const serialize = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'

/** Cooperating writers share the native target's stable inode, across private receipt roots. */
async function withTargetLocks<T>(paths: readonly string[], work: () => Promise<T>): Promise<T> {
  const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
  const locks: Awaited<ReturnType<typeof open>>[] = []
  try {
    for (const path of [...new Set(paths)].sort()) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const lock = await open(`${path}.agentmux.lock`, 'a+', 0o600); locks.push(lock)
      if (!native.tryLock(lock.fd)) throw new AgentMuxError('Managed Hook target is being changed by another writer. The current callbacks are retained; retry the same operation after it completes.', 'HOOK_TARGET_BUSY')
    }
    return await work()
  } finally {
    // Never unlink this inode: the kernel releases ownership on close or process death.
    for (const lock of locks.reverse()) await lock.close()
  }
}

export async function readManagedHookTarget(path: string): Promise<{ content: Uint8Array; mode: number } | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new AgentMuxError('Managed Hook target must be a regular file.', 'UNSAFE_HOOK_TARGET')
    }
    if (info.size > MAX_HOOK_FILE_BYTES) {
      throw new AgentMuxError('Managed Hook target exceeds the file size limit.', 'HOOK_FILE_TOO_LARGE')
    }
    const content = await readFile(path)
    // A target may grow after lstat. The actual bytes, not the earlier metadata, own this bound.
    if (content.byteLength > MAX_HOOK_FILE_BYTES) {
      throw new AgentMuxError('Managed Hook target exceeds the file size limit.', 'HOOK_FILE_TOO_LARGE')
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(content)
    } catch {
      throw new AgentMuxError('Managed Hook target is not valid UTF-8.', 'HOOK_TARGET_UNPARSEABLE')
    }
    return { content, mode: info.mode }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function safeTarget(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path === '/') {
    throw new AgentMuxError('Managed Hook target must be an absolute normalized file path.', 'UNSAFE_HOOK_TARGET')
  }
  return path
}

async function writeAtomically(path: string, content: Uint8Array | string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.agentmux-${process.pid}-${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, { mode })
    await chmod(temporaryPath, mode)
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

export class AgentManagedHookInstaller {
  private readonly previews = new Map<string, PreparedPreview>()
  private readonly stateRoot: string

  constructor(stateDirectory: string) {
    this.stateRoot = resolve(stateDirectory)
    if (dirname(this.stateRoot) === this.stateRoot) {
      throw new AgentMuxError('Managed Hook state directory cannot be a filesystem root.', 'UNSAFE_HOOK_TARGET')
    }
  }

  /** Fresh disk observation only: no preview admission, receipt, mkdir or native process. */
  async inspect(plan: AgentManagedHookPlan): Promise<AgentManagedHookInspection> {
    const targets: AgentManagedHookInspection['targets'] = []
    try {
      validatePlan(plan)
      for (const mutation of plan.mutations) {
        try {
          const target = await readManagedHookTarget(mutation.path)
          const content = target ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(target.content) : undefined
          const original = scope(plan.providerId, mutation)
          const raw = original ? await readRegistrationFile(registrationPath(this.stateRoot, original)) : null
          const previous = raw && original ? registration(raw, original, target ? hash(target.content) : null).owner : null
          const facts = content === undefined ? { present: false, current: false }
            : mutation.merge ? inspectManagedHookContent(content, mutation.content, mutation.merge)
              : { present: true, current: content === mutation.content }
          if (facts.current && mutation.merge && previous?.content &&
              prepareMergedHookContent(content ?? null, mutation.content, mutation.merge, previous.content).content !== content) facts.current = false
          targets.push({ path: mutation.path, status: facts.current ? 'current' : facts.present ? 'partial' : 'not_present' })
        } catch (error) {
          targets.push({ path: mutation.path, status: 'error', code: inspectionErrorCode(error) })
        }
      }
    } catch (error) {
      return { providerId: plan.providerId, checkedAt: Date.now(), status: 'error', targets,
        code: inspectionErrorCode(error), action: 'Fix the scoped Hook plan or target, then inspect again.' }
    }
    const status = targets.some(target => target.status === 'error') ? 'error'
      : targets.every(target => target.status === 'current') ? 'installed'
        : targets.every(target => target.status === 'not_present') ? 'not_installed' : 'partial'
    return { providerId: plan.providerId, checkedAt: Date.now(), status, targets,
      code: status === 'installed' ? 'MANAGED_HOOK_CURRENT' : status === 'not_installed' ? 'MANAGED_HOOK_ABSENT'
        : status === 'error' ? 'MANAGED_HOOK_CHECK_FAILED' : 'MANAGED_HOOK_INCOMPLETE',
      action: status === 'installed' ? null : status === 'error' ? 'Fix the unreadable or invalid scoped Hook target, then inspect again.'
        : 'Install or repair the managed Hook configuration for this scope, then inspect again.' }
  }

  async preview(plan: AgentManagedHookPlan): Promise<AgentManagedHookPreview> {
    validatePlan(plan)
    if (this.previews.size >= MAX_PENDING_PREVIEWS) {
      throw new AgentMuxError('Managed Hook preview limit reached.', 'HOOK_PREVIEW_LIMIT')
    }
    const mutations: PreparedMutation[] = []
    for (const mutation of plan.mutations) {
      const path = mutation.path
      const current = await readManagedHookTarget(path)
      const currentContent = current ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(current.content) : null
      const original = scope(plan.providerId, mutation)
      const ownedPath = original ? registrationPath(this.stateRoot, original) : undefined
      const raw = ownedPath ? await readRegistrationFile(ownedPath) : null
      const prior = raw && original ? registration(raw, original, current ? hash(current.content) : null) : undefined
      const merged = mutation.merge ? prepareMergedHookContent(currentContent, mutation.content, mutation.merge, prior?.owner?.content) : undefined
      const effectiveContent = merged?.content ?? mutation.content
      if (Buffer.byteLength(effectiveContent) > MAX_HOOK_FILE_BYTES) {
        throw new AgentMuxError('Managed Hook merged content exceeds the file size limit.', 'HOOK_FILE_TOO_LARGE')
      }
      mutations.push({
        path,
        content: mutation.content,
        ...(mutation.mode === undefined ? {} : { mode: mutation.mode }),
        ...(mutation.merge === undefined ? {} : { merge: mutation.merge }),
        currentHash: current ? hash(current.content) : null,
        currentMode: current?.mode ?? null,
        effectiveContent,
        nextHash: hash(effectiveContent),
        ...(original && ownedPath && merged ? { registration: { scope: original, path: ownedPath, raw,
          owner: prior?.owner ?? null, nextOwnedContent: merged.ownedContent,
          changed: merged.ownedContent !== (prior?.owner?.content ?? null) || prior?.state.committed === false } } : {})
      })
    }
    const preview: AgentManagedHookPreview = {
      id: randomUUID(),
      providerId: plan.providerId,
      changes: mutations.map((mutation) => ({
        path: mutation.path,
        action: mutation.currentHash === mutation.nextHash
          ? 'unchanged'
          : mutation.currentHash === null
            ? 'create'
            : 'replace',
        currentHash: mutation.currentHash,
        nextHash: mutation.nextHash
      }))
    }
    this.previews.set(preview.id, { preview, mutations })
    return structuredClone(preview)
  }

  /**
   * Install a plan idempotently. Previews first and, when every target is already current, discards
   * the preview and returns `null` without touching disk — so re-running it on every agent launch is
   * cheap and safe (install-and-leave). Returns a receipt only when a write actually happened.
   */
  async ensure(plan: AgentManagedHookPlan): Promise<AgentManagedHookInstallReceipt | null> {
    const preview = await this.preview(plan)
    if (preview.changes.every((change) => change.action === 'unchanged') &&
        this.previews.get(preview.id)!.mutations.every(mutation => !mutation.registration?.changed)) {
      this.previews.delete(preview.id)
      return null
    }
    return await this.install(preview.id)
  }

  async install(previewId: string): Promise<AgentManagedHookInstallReceipt> {
    const prepared = this.previews.get(previewId)
    if (!prepared) throw new AgentMuxError('Managed Hook preview is unknown or already used.', 'UNKNOWN_HOOK_PREVIEW')
    this.previews.delete(previewId)
    return await withTargetLocks(prepared.mutations.map(mutation => mutation.path), () => this.installPrepared(previewId, prepared))
  }

  private async installPrepared(previewId: string, prepared: PreparedPreview): Promise<AgentManagedHookInstallReceipt> {
    const installMutations: InstallMutation[] = []
    for (const mutation of prepared.mutations) {
      const current = await readManagedHookTarget(mutation.path)
      const currentHash = current ? hash(current.content) : null
      if (currentHash !== mutation.currentHash) {
        throw new AgentMuxError('Managed Hook target changed after preview.', 'HOOK_TARGET_CHANGED')
      }
      if (mutation.registration && await readRegistrationFile(mutation.registration.path) !== mutation.registration.raw) {
        throw new AgentMuxError('Managed Hook ownership changed after preview; the current callbacks are retained.', 'HOOK_TARGET_CHANGED')
      }
      installMutations.push({ ...mutation, currentContent: current?.content ?? null })
    }

    const receiptDirectory = join(this.stateRoot, 'receipts', previewId)
    await mkdir(receiptDirectory, { recursive: true, mode: 0o700 })
    const entries: AgentManagedHookInstallReceipt['entries'] = []
    const applied: InstallMutation[] = []
    const backupPaths: string[] = []
    const registrations: Array<{ mutation: InstallMutation; state: HookRegistration }> = []
    try {
      for (const [index, mutation] of installMutations.entries()) {
        let backupPath: string | null = null
        if (mutation.currentContent) {
          backupPath = join(receiptDirectory, `${index}.backup`)
          await writeAtomically(backupPath, mutation.currentContent, 0o600)
          backupPaths.push(backupPath)
        }
        const owned = mutation.registration
        if (owned?.changed) {
          const metadataPath = join(receiptDirectory, `${index}.ownership.json`)
          await writeAtomically(metadataPath, serialize({ scope: owned.scope, before: owned.raw !== null } satisfies RegistrationBackup), 0o600)
          backupPaths.push(metadataPath)
          if (owned.raw !== null) {
            const original = join(receiptDirectory, `${index}.ownership.backup`)
            await writeAtomically(original, owned.raw, 0o600); backupPaths.push(original)
          }
          const state: HookRegistration = { version: 1, scope: owned.scope, before: owned.owner,
            after: { receiptId: previewId, content: owned.nextOwnedContent }, previousHash: mutation.currentHash,
            nextHash: mutation.nextHash, backupPath, committed: false }
          // Write-ahead at this exact scope: a fresh process can identify either
          // byte generation even if this process stops before its final commit.
          await writeAtomically(owned.path, serialize(state), 0o600)
          registrations.push({ mutation, state })
        }
        if (mutation.currentHash !== mutation.nextHash) {
          await writeAtomically(
            mutation.path,
            mutation.effectiveContent,
            mutation.mode ?? mutation.currentMode ?? 0o600
          )
          applied.push(mutation)
        }
        entries.push({
          path: mutation.path,
          installedHash: mutation.nextHash,
          previousHash: mutation.currentHash,
          previousMode: mutation.currentMode,
          backupPath
        })
      }
      for (const { mutation, state } of registrations) {
        await writeAtomically(mutation.registration!.path, serialize({ ...state, committed: true }), 0o600)
      }
    } catch (error) {
      const rollback = await Promise.allSettled(applied.reverse().map(async (mutation) => {
        if (mutation.currentContent) {
          await writeAtomically(mutation.path, mutation.currentContent, mutation.currentMode ?? 0o600)
        } else {
          await unlink(mutation.path).catch((unlinkError: NodeJS.ErrnoException) => {
            if (unlinkError.code !== 'ENOENT') throw unlinkError
          })
        }
      }))
      const rollbackErrors = rollback.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      const registrationRollback = await Promise.allSettled(registrations.map(async ({ mutation }) => {
        const original = mutation.registration!
        const target = await readManagedHookTarget(mutation.path)
        if ((target ? hash(target.content) : null) !== mutation.currentHash) {
          // Keep the write-ahead receipt when the target rollback is unknown.
          throw new AgentMuxError('Managed Hook rollback is unconfirmed; its pending receipt and callbacks are retained.', 'HOOK_REGISTRATION_UNCONFIRMED')
        }
        if (original.raw === null) await unlink(original.path)
        else await writeAtomically(original.path, original.raw, 0o600)
      }))
      const registrationErrors = registrationRollback.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      // Unknown rollback keeps the original receipt/backups available for review.
      const cleanup = await Promise.allSettled(rollbackErrors.length || registrationErrors.length ? [] : backupPaths.map(async (path) => await unlink(path)))
      const cleanupErrors = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (rollbackErrors.length > 0 || registrationErrors.length > 0 || cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors, ...registrationErrors, ...cleanupErrors],
          'Managed Hook install, rollback, or backup cleanup failed.'
        )
      }
      throw error
    }
    return {
      id: previewId,
      providerId: prepared.preview.providerId,
      installedAt: Date.now(),
      entries
    }
  }

  async uninstall(receipt: AgentManagedHookInstallReceipt): Promise<void> {
    if (receipt.entries.length === 0 || receipt.entries.length > MAX_HOOK_MUTATIONS) {
      throw new AgentMuxError('Managed Hook receipt has an invalid mutation count.', 'INVALID_HOOK_RECEIPT')
    }
    return await withTargetLocks(receipt.entries.map(entry => safeTarget(entry.path)), () => this.uninstallPrepared(receipt))
  }

  private async uninstallPrepared(receipt: AgentManagedHookInstallReceipt): Promise<void> {
    const restorations: Array<{ entry: AgentManagedHookInstallReceipt['entries'][number]; backup: Buffer | null }> = []
    const registrations: Array<{ path: string; raw: string | null; files: string[] }> = []
    for (const [index, entry] of receipt.entries.entries()) {
      const path = safeTarget(entry.path)
      const current = await readManagedHookTarget(path)
      if (!current || hash(current.content) !== entry.installedHash) {
        throw new AgentMuxError('Managed Hook target changed after installation.', 'HOOK_TARGET_CHANGED')
      }
      if ((entry.previousHash === null) !== (entry.backupPath === null)) {
        throw new AgentMuxError('Managed Hook receipt backup metadata is invalid.', 'INVALID_HOOK_RECEIPT')
      }
      const backup = entry.backupPath
        ? await readFile(await this.safeBackupPath(entry.backupPath))
        : null
      if (backup && hash(backup) !== entry.previousHash) {
        throw new AgentMuxError('Managed Hook recovery backup is invalid.', 'INVALID_HOOK_RECEIPT')
      }
      if (!/^[a-zA-Z0-9_-]{1,160}$/u.test(receipt.id)) throw new AgentMuxError('Managed Hook receipt identity is invalid.', 'INVALID_HOOK_RECEIPT')
      const metadataPath = join(this.stateRoot, 'receipts', receipt.id, `${index}.ownership.json`)
      const metadata = await readRegistrationFile(metadataPath)
      if (metadata !== null) {
        let saved: RegistrationBackup
        try { saved = JSON.parse(metadata) } catch { return registrationError() }
        if (!saved || typeof saved.before !== 'boolean' || saved.scope?.providerId !== receipt.providerId || saved.scope.path !== path ||
            !['json-managed-events', 'json-root-managed-events', 'yaml-managed-events', 'json-managed-approvals'].includes(saved.scope.merge?.kind)) return registrationError()
        const ownedPath = registrationPath(this.stateRoot, saved.scope), currentOwned = await readRegistrationFile(ownedPath)
        if (!currentOwned || registration(currentOwned, saved.scope, entry.installedHash).owner?.receiptId !== receipt.id) {
          throw new AgentMuxError('Managed Hook ownership changed after installation.', 'HOOK_TARGET_CHANGED')
        }
        const previousPath = join(this.stateRoot, 'receipts', receipt.id, `${index}.ownership.backup`)
        const raw = saved.before ? await readRegistrationFile(previousPath) : null
        if (saved.before && raw === null) return registrationError()
        if (raw !== null) registration(raw, saved.scope, entry.previousHash)
        registrations.push({ path: ownedPath, raw, files: [metadataPath, ...(saved.before ? [previousPath] : [])] })
      }
      restorations.push({ entry: { ...entry, path }, backup })
    }
    for (const { entry, backup } of restorations.reverse()) {
      if (backup) {
        await writeAtomically(entry.path, backup, entry.previousMode ?? 0o600)
      } else {
        await unlink(entry.path)
      }
    }
    for (const original of registrations) {
      if (original.raw === null) await unlink(original.path)
      else await writeAtomically(original.path, original.raw, 0o600)
    }
    for (const entry of receipt.entries) {
      if (entry.backupPath) {
        const backupPath = await this.safeBackupPath(entry.backupPath)
        await unlink(backupPath).catch(() => {})
      }
    }
    for (const original of registrations) for (const path of original.files) await unlink(path).catch(() => {})
  }

  private async safeBackupPath(path: string): Promise<string> {
    const normalized = safeTarget(path)
    if (!normalized.startsWith(`${this.stateRoot}${sep}`)) {
      throw new AgentMuxError('Managed Hook receipt backup is outside the state directory.', 'INVALID_HOOK_RECEIPT')
    }
    let stateRoot: string
    let backup: string
    try {
      [stateRoot, backup] = await Promise.all([realpath(this.stateRoot), realpath(normalized)])
    } catch {
      throw new AgentMuxError('Managed Hook recovery backup is unavailable.', 'INVALID_HOOK_RECEIPT')
    }
    if (!backup.startsWith(`${stateRoot}${sep}`)) {
      throw new AgentMuxError('Managed Hook receipt backup is outside the state directory.', 'INVALID_HOOK_RECEIPT')
    }
    const info = await lstat(normalized)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new AgentMuxError('Managed Hook recovery backup must be a regular file.', 'INVALID_HOOK_RECEIPT')
    }
    return normalized
  }
}

function validatePlan(plan: AgentManagedHookPlan): void {
  if (plan.mutations.length === 0 || plan.mutations.length > MAX_HOOK_MUTATIONS) {
    throw new AgentMuxError('Managed Hook plan has an invalid mutation count.', 'INVALID_HOOK_PLAN')
  }
  const paths = new Set<string>()
  for (const mutation of plan.mutations) {
    safeTarget(mutation.path)
    if (paths.has(mutation.path)) throw new AgentMuxError('Managed Hook plan repeats a target.', 'INVALID_HOOK_PLAN')
    paths.add(mutation.path)
    if (Buffer.byteLength(mutation.content) > MAX_HOOK_FILE_BYTES) throw new AgentMuxError('Managed Hook content exceeds the file size limit.', 'HOOK_FILE_TOO_LARGE')
  }
}

function inspectionErrorCode(error: unknown): string {
  return error instanceof AgentMuxError ? error.code : 'HOOK_TARGET_READ_FAILED'
}
