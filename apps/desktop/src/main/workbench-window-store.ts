import { mintObjectId } from '@agentmux/core/object-id'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { durableWriteFile, restoreMissingRecoveryFile } from '@agentmux/core'
import type { RecoverySource, RecoveryRestoreMember } from '@agentmux/core'
import { captureWorkbenchRecoveryFiles, inspectWorkbenchRecoveryFiles } from './workbench-recovery-source.js'
import { confirmExistingWorkbenchRecoveryMember, prepareWorkbenchRecoveryMembers, readWorkbenchRecoveryMember, recoveryUnavailable } from './workbench-recovery-restore.js'
import { parseAppWindowOperation, parseAppWindowTarget, type AppWindowOperation, type AppWindowTarget } from '@agentmux/core/control'
import type { WindowGeometry } from './window-geometry.js'

export type StoredWorkbenchWindow = { windowId: string; target: AppWindowTarget; geometry: WindowGeometry; returnContext?: unknown }
export type StoredWorkbenchWindows = { mainWindowId: string; windows: StoredWorkbenchWindow[] }
export type WorkbenchWindowLoad = { state: StoredWorkbenchWindows; issue: string | null; writable: boolean }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Window presentation record is invalid.')
  return value as Record<string, unknown>
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value === 'self' || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Window presentation identity is missing.')
  return value
}
export function parseStoredWorkbenchWindows(value: unknown): StoredWorkbenchWindows {
  const raw = record(value)
  if (raw.schema !== 'agentmux.workbench-windows.v1' || !Array.isArray(raw.windows)) throw new Error('Window presentation storage is unconfirmed.')
  const mainWindowId = identity(raw.mainWindowId)
  const windows = raw.windows.map(value => {
    const item = record(value), geometry = record(item.geometry)
    if (!['x', 'y', 'width', 'height'].every(key => typeof geometry[key] === 'number' && Number.isFinite(geometry[key])) ||
        Number(geometry.width) <= 0 || Number(geometry.height) <= 0 || typeof geometry.maximized !== 'boolean') {
      throw new Error('Stored native window geometry is unconfirmed.')
    }
    return { windowId: identity(item.windowId), target: parseAppWindowTarget(item.target),
      ...(Object.hasOwn(item, 'returnContext') ? { returnContext: item.returnContext } : {}), geometry: {
      x: geometry.x as number, y: geometry.y as number, width: geometry.width as number, height: geometry.height as number,
      maximized: geometry.maximized
    } }
  })
  if (new Set([mainWindowId, ...windows.map(window => window.windowId)]).size !== windows.length + 1 ||
      new Set(windows.map(window => JSON.stringify(window.target))).size !== windows.length) {
    throw new Error('Stored original workface windows are ambiguous.')
  }
  return { mainWindowId, windows }
}

/** Only native presentation intent/geometry and original operation receipts live here. */
export class WorkbenchWindowStore {
  private tail: Promise<void> = Promise.resolve()
  private documentOpened = false
  private readonly openedOperations = new Set<string>()
  private readonly recoveryGaps = new Set<string>()
  constructor(readonly path: string) {}

  retainRecoveryGaps(memberIds: readonly string[]): void { for (const id of memberIds) if (id === 'document' || /^operations\/[a-f0-9]{64}\.json$/u.test(id)) this.recoveryGaps.add(id) }

  recoverySource(): RecoverySource & { inspect(): Promise<string> } {
    const id = 'desktop.windows'
    const files = [{ id: 'document', target: this.path }], namespaces = [{ id: 'operations', directory: join(dirname(this.path), 'workbench-window-operations'),
      accepts: (name: string) => /^[a-f0-9]{64}\.json$/u.test(name) }]
    return { id, ownedPaths: [this.path, namespaces[0]!.directory], inspect: () => inspectWorkbenchRecoveryFiles(files, namespaces), capture: async directory => {
      await this.tail.catch(() => {})
      // Observe the original frontier; export IO cannot enter or ACK its tail.
      return await captureWorkbenchRecoveryFiles(id, directory, files, namespaces)
    }, prepareRestore: (members, directory) => prepareWorkbenchRecoveryMembers(members, directory, member => this.prepareRecoveryMember(member)),
    restoreMissing: member => {
      const operation = this.tail.catch(() => {}).then(async () => {
        await this.prepareRecoveryMember(member, false)
        const existing = await confirmExistingWorkbenchRecoveryMember(member, this.recoveryTarget(member))
        if (existing) return existing
        if (member.id === 'document' ? this.documentOpened : this.openedOperations.has(member.id)) throw recoveryUnavailable('DESKTOP_DOCUMENT_ALREADY_OPEN')
        return await restoreMissingRecoveryFile(member.file, this.recoveryTarget(member), member.sha256)
      })
      this.tail = operation.then(() => {})
      void this.tail.catch(() => {})
      return operation
    } }
  }

  private recoveryTarget(member: RecoveryRestoreMember): string {
    if (member.id === 'document') return this.path
    if (!/^operations\/[a-f0-9]{64}\.json$/u.test(member.id)) throw recoveryUnavailable('DESKTOP_RECOVERY_MEMBER_MISMATCH')
    return join(dirname(this.path), 'workbench-window-operations', member.id.slice('operations/'.length))
  }
  private async prepareRecoveryMember(member: RecoveryRestoreMember, protectCurrent = true): Promise<string> {
    const opened = () => member.id === 'document' ? this.documentOpened : this.openedOperations.has(member.id)
    if (protectCurrent && opened()) throw recoveryUnavailable('DESKTOP_DOCUMENT_ALREADY_OPEN')
    const raw = await readWorkbenchRecoveryMember(member, this.recoveryTarget(member))
    if (member.id === 'document') parseStoredWorkbenchWindows(JSON.parse(raw))
    else {
      const operation = parseAppWindowOperation(JSON.parse(raw))
      if (this.operationPath(operation.input.operationId) !== member.target) throw recoveryUnavailable('DESKTOP_RECOVERY_MEMBER_MISMATCH')
    }
    if (protectCurrent && opened()) throw recoveryUnavailable('DESKTOP_DOCUMENT_ALREADY_OPEN')
    return raw
  }

  async load(): Promise<WorkbenchWindowLoad> {
    this.documentOpened = true
    try { return { state: parseStoredWorkbenchWindows(JSON.parse(await readFile(this.path, 'utf8'))), issue: null, writable: true } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.recoveryGaps.has('document')) return { state: { mainWindowId: mintObjectId(), windows: [] }, issue: null, writable: true }
      // Keep the original corrupt/unreadable bytes. This presentation failure must
      // neither replace the original workbench nor block its healthy Agents.
      return { state: { mainWindowId: mintObjectId(), windows: [] }, writable: false,
        issue: `Original window arrangement could not be read. Original workfaces and Agents remain. ${String(error)}` }
    }
  }

  async save(state: StoredWorkbenchWindows): Promise<void> {
    this.documentOpened = true
    if (this.recoveryGaps.has('document') && !(await this.load()).writable) throw recoveryUnavailable('DESKTOP_RECOVERY_SOURCE_UNCONFIRMED')
    const validated = parseStoredWorkbenchWindows({ schema: 'agentmux.workbench-windows.v1', ...state })
    await this.enqueue(this.path, { schema: 'agentmux.workbench-windows.v1', ...validated })
  }

  async operation(operationId: string): Promise<AppWindowOperation | null> {
    this.openedOperations.add('operations/' + createHash('sha256').update(operationId).digest('hex') + '.json')
    try {
      const operation = parseAppWindowOperation(JSON.parse(await readFile(this.operationPath(operationId), 'utf8')))
      if (operation.input.operationId !== operationId) throw new Error('Stored receipt does not match the original operation.')
      return operation
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.recoveryGaps.has('operations/' + createHash('sha256').update(operationId).digest('hex') + '.json')) return null
      // Unknown journal bytes cannot authorize repeating a native side effect.
      throw new Error(`Original window operation could not be read; reconcile the same operation. ${String(error)}`)
    }
  }

  async saveOperation(operation: AppWindowOperation): Promise<void> {
    const validated = parseAppWindowOperation(operation)
    this.openedOperations.add('operations/' + createHash('sha256').update(validated.input.operationId).digest('hex') + '.json')
    if (this.recoveryGaps.has('operations/' + createHash('sha256').update(validated.input.operationId).digest('hex') + '.json')) await this.operation(validated.input.operationId)
    await this.enqueue(this.operationPath(validated.input.operationId), validated)
  }

  flush(): Promise<void> { return this.tail }

  private operationPath(operationId: string): string {
    // One exact receipt read/write is independent of unrelated Sessions and past
    // window operations. Original IDs stay inside the validated receipt.
    return join(dirname(this.path), 'workbench-window-operations', createHash('sha256').update(operationId).digest('hex') + '.json')
  }

  private async enqueue(path: string, value: unknown): Promise<void> {
    const operation = this.tail.catch(() => {}).then(async () => {
      const created = await mkdir(dirname(path), { recursive: true })
      // The operation namespace entry belongs to the original window directory.
      // Confirm it on retries too: mkdir returning undefined is not a prior ACK.
      const directories = new Set([dirname(path), dirname(this.path)])
      if (created) for (let directory = dirname(path);; directory = dirname(directory)) {
        directories.add(directory)
        if (directory === dirname(created)) break
      }
      for (const directory of directories) {
        const handle = await open(directory, 'r')
        try { await handle.sync() } finally { await handle.close() }
      }
      await durableWriteFile(path, JSON.stringify(value) + '\n', { requireDirectorySync: true })
    })
    this.tail = operation
    await operation
  }
}
