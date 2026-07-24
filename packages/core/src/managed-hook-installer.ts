import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { AgentMuxError } from './errors.js'
import type { AgentId } from './types.js'

const MAX_HOOK_FILE_BYTES = 256 * 1024
const MAX_HOOK_MUTATIONS = 8
const MAX_PENDING_PREVIEWS = 4

export type AgentManagedHookMutation = {
  path: string
  content: string
  mode?: number
}

export type AgentManagedHookPlan = {
  agentId: AgentId
  mutations: readonly AgentManagedHookMutation[]
}

export type AgentManagedHookPreview = {
  id: string
  agentId: AgentId
  changes: Array<{
    path: string
    action: 'create' | 'replace' | 'unchanged'
    currentHash: string | null
    nextHash: string
  }>
}

export type AgentManagedHookInstallReceipt = {
  id: string
  agentId: AgentId
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
  nextHash: string
}

type InstallMutation = PreparedMutation & {
  currentContent: Buffer | null
}

type PreparedPreview = {
  preview: AgentManagedHookPreview
  mutations: PreparedMutation[]
}

function hash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function readCurrent(path: string): Promise<{ content: Buffer; mode: number } | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new AgentMuxError('Managed Hook target must be a regular file.', 'UNSAFE_HOOK_TARGET')
    }
    if (info.size > MAX_HOOK_FILE_BYTES) {
      throw new AgentMuxError('Managed Hook target exceeds the file size limit.', 'HOOK_FILE_TOO_LARGE')
    }
    return { content: await readFile(path), mode: info.mode }
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

async function writeAtomically(path: string, content: Buffer | string, mode: number): Promise<void> {
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

  async preview(plan: AgentManagedHookPlan): Promise<AgentManagedHookPreview> {
    if (plan.mutations.length === 0 || plan.mutations.length > MAX_HOOK_MUTATIONS) {
      throw new AgentMuxError('Managed Hook plan has an invalid mutation count.', 'INVALID_HOOK_PLAN')
    }
    if (this.previews.size >= MAX_PENDING_PREVIEWS) {
      throw new AgentMuxError('Managed Hook preview limit reached.', 'HOOK_PREVIEW_LIMIT')
    }
    const paths = new Set<string>()
    const mutations: PreparedMutation[] = []
    for (const mutation of plan.mutations) {
      const path = safeTarget(mutation.path)
      if (paths.has(path)) throw new AgentMuxError('Managed Hook plan repeats a target.', 'INVALID_HOOK_PLAN')
      paths.add(path)
      if (Buffer.byteLength(mutation.content) > MAX_HOOK_FILE_BYTES) {
        throw new AgentMuxError('Managed Hook content exceeds the file size limit.', 'HOOK_FILE_TOO_LARGE')
      }
      const current = await readCurrent(path)
      mutations.push({
        path,
        content: mutation.content,
        ...(mutation.mode === undefined ? {} : { mode: mutation.mode }),
        currentHash: current ? hash(current.content) : null,
        currentMode: current?.mode ?? null,
        nextHash: hash(mutation.content)
      })
    }
    const preview: AgentManagedHookPreview = {
      id: randomUUID(),
      agentId: plan.agentId,
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

  async install(previewId: string): Promise<AgentManagedHookInstallReceipt> {
    const prepared = this.previews.get(previewId)
    if (!prepared) throw new AgentMuxError('Managed Hook preview is unknown or already used.', 'UNKNOWN_HOOK_PREVIEW')
    this.previews.delete(previewId)
    const installMutations: InstallMutation[] = []
    for (const mutation of prepared.mutations) {
      const current = await readCurrent(mutation.path)
      const currentHash = current ? hash(current.content) : null
      if (currentHash !== mutation.currentHash) {
        throw new AgentMuxError('Managed Hook target changed after preview.', 'HOOK_TARGET_CHANGED')
      }
      installMutations.push({ ...mutation, currentContent: current?.content ?? null })
    }

    const receiptDirectory = join(this.stateRoot, 'receipts', previewId)
    await mkdir(receiptDirectory, { recursive: true, mode: 0o700 })
    const entries: AgentManagedHookInstallReceipt['entries'] = []
    const applied: InstallMutation[] = []
    const backupPaths: string[] = []
    try {
      for (const [index, mutation] of installMutations.entries()) {
        let backupPath: string | null = null
        if (mutation.currentContent) {
          backupPath = join(receiptDirectory, `${index}.backup`)
          await writeAtomically(backupPath, mutation.currentContent, 0o600)
          backupPaths.push(backupPath)
        }
        if (mutation.currentHash !== mutation.nextHash) {
          await writeAtomically(
            mutation.path,
            mutation.content,
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
      const cleanup = await Promise.allSettled(backupPaths.map(async (path) => await unlink(path)))
      const cleanupErrors = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (rollbackErrors.length > 0 || cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors, ...cleanupErrors],
          'Managed Hook install, rollback, or backup cleanup failed.'
        )
      }
      throw error
    }
    return {
      id: previewId,
      agentId: prepared.preview.agentId,
      installedAt: Date.now(),
      entries
    }
  }

  async uninstall(receipt: AgentManagedHookInstallReceipt): Promise<void> {
    if (receipt.entries.length === 0 || receipt.entries.length > MAX_HOOK_MUTATIONS) {
      throw new AgentMuxError('Managed Hook receipt has an invalid mutation count.', 'INVALID_HOOK_RECEIPT')
    }
    const restorations: Array<{ entry: AgentManagedHookInstallReceipt['entries'][number]; backup: Buffer | null }> = []
    for (const entry of receipt.entries) {
      const path = safeTarget(entry.path)
      const current = await readCurrent(path)
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
      restorations.push({ entry: { ...entry, path }, backup })
    }
    for (const { entry, backup } of restorations.reverse()) {
      if (backup) {
        await writeAtomically(entry.path, backup, entry.previousMode ?? 0o600)
      } else {
        await unlink(entry.path)
      }
    }
    for (const entry of receipt.entries) {
      if (entry.backupPath) {
        const backupPath = await this.safeBackupPath(entry.backupPath)
        await unlink(backupPath).catch(() => {})
      }
    }
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
