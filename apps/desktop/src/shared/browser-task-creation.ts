import { mintObjectId } from '@agentmux/core/object-id'
import { AgentMuxError } from '@agentmux/core/control'

/** Pending user input. Only Main can bind it to an actual stopped recording and create an asset. */
export type BrowserTaskCreateInput = {
  createOperationId: string
  assetId: string
  browserId: string
  sourceRecordingId: string
  sourceRevision: number
  name: string
}
export type BrowserTaskCreateStatus = {
  createOperationId: string; assetId: string; browserId: string; status: 'created' | 'not-found' | 'unknown'; warning?: string
}
export function parseBrowserTaskCreateInput(value: unknown): BrowserTaskCreateInput {
  const fields = ['createOperationId', 'assetId', 'browserId', 'sourceRecordingId', 'sourceRevision', 'name']
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key) || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) throw new AgentMuxError('Task creation input is invalid.', 'INVALID_CONTROL_REQUEST')
  const row = value as Record<string, unknown>
  for (const key of fields.filter(key => key !== 'sourceRevision' && key !== 'name')) {
    const item = row[key]
    if (typeof item !== 'string' || !item.trim() || item.length > 128 || /[\u0000-\u001f\u007f]/.test(item)) throw new AgentMuxError('Task creation identity is invalid.', 'INVALID_CONTROL_REQUEST')
  }
  if (!Number.isSafeInteger(row.sourceRevision) || (row.sourceRevision as number) < 1 || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 240 || /[\u0000-\u001f\u007f]/.test(row.name)) throw new AgentMuxError('Task creation source revision or name is invalid.', 'INVALID_CONTROL_REQUEST')
  return { createOperationId: row.createOperationId as string, assetId: row.assetId as string, browserId: row.browserId as string,
    sourceRecordingId: row.sourceRecordingId as string, sourceRevision: row.sourceRevision as number, name: row.name }
}
export function browserTaskCreateInput(source: { id: string; browserId: string; revision: number }, name = 'Demonstrated task'): BrowserTaskCreateInput {
  return parseBrowserTaskCreateInput({ createOperationId: mintObjectId(), assetId: mintObjectId(), browserId: source.browserId,
    sourceRecordingId: source.id, sourceRevision: source.revision, name })
}
