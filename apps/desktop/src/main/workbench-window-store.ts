import { mintObjectId } from '@agentmux/core/object-id'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { durableWriteFile } from '@agentmux/core'
import { parseAppWindowOperation, parseAppWindowTarget, type AppWindowOperation, type AppWindowTarget } from '@agentmux/core/control'
import type { WindowGeometry } from './window-geometry.js'

export type StoredWorkbenchWindow = { windowId: string; target: AppWindowTarget; geometry: WindowGeometry }
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
    return { windowId: identity(item.windowId), target: parseAppWindowTarget(item.target), geometry: {
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
  constructor(private readonly path: string) {}

  async load(): Promise<WorkbenchWindowLoad> {
    try { return { state: parseStoredWorkbenchWindows(JSON.parse(await readFile(this.path, 'utf8'))), issue: null, writable: true } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: { mainWindowId: mintObjectId(), windows: [] }, issue: null, writable: true }
      // Keep the original corrupt/unreadable bytes. This presentation failure must
      // neither replace the original workbench nor block its healthy Agents.
      return { state: { mainWindowId: mintObjectId(), windows: [] }, writable: false,
        issue: `Original window arrangement could not be read. Original workfaces and Agents remain. ${String(error)}` }
    }
  }

  async save(state: StoredWorkbenchWindows): Promise<void> {
    const validated = parseStoredWorkbenchWindows({ schema: 'agentmux.workbench-windows.v1', ...state })
    await this.enqueue(this.path, { schema: 'agentmux.workbench-windows.v1', ...validated })
  }

  async operation(operationId: string): Promise<AppWindowOperation | null> {
    try {
      const operation = parseAppWindowOperation(JSON.parse(await readFile(this.operationPath(operationId), 'utf8')))
      if (operation.input.operationId !== operationId) throw new Error('Stored receipt does not match the original operation.')
      return operation
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      // Unknown journal bytes cannot authorize repeating a native side effect.
      throw new Error(`Original window operation could not be read; reconcile the same operation. ${String(error)}`)
    }
  }

  async saveOperation(operation: AppWindowOperation): Promise<void> {
    const validated = parseAppWindowOperation(operation)
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
      await mkdir(dirname(path), { recursive: true })
      await durableWriteFile(path, JSON.stringify(value) + '\n')
    })
    this.tail = operation
    await operation
  }
}
