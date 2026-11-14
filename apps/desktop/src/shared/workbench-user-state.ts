export type WorkbenchUserStateFailure = {
  operation: 'read' | 'write'
  phase: 'request' | 'before-replace' | 'after-replace' | null
  code: string | null
  observedAt: number
}

export type WorkbenchUserStateReceipt = {
  path: string
  contentDigest: string
  sizeBytes: number
  diskDurability: 'confirmed'
  confirmedAt: number
}

/** Private Desktop IPC admission, scoped by Main to the original native document. */
export type WorkbenchUserStateWrite = { value: string; writeRevision: number }
export type WorkbenchUserStateWriteReceipt = WorkbenchUserStateReceipt & { writeRevision: number }

export type WorkbenchUserStateObservation = {
  path: string
  availability: 'present' | 'missing' | 'unconfirmed'
  contentDigest: string | null
  sizeBytes: number | null
  diskDurability: 'confirmed' | 'unconfirmed'
  confirmedAt: number | null
  /** Original producer receipt in this Main lifetime; a read never extends it to another file. */
  lastConfirmedWrite: WorkbenchUserStateReceipt | null
  /** Historical metadata only; a later successful write retains the latest diagnosis. */
  lastFailure: WorkbenchUserStateFailure | null
}

/** A Desktop reading preference belongs to one exact original File binding. */
export type FileViewReadingOwner = {
  regionId: string
  workspaceId: string
  hostId: string
  workspacePath: string
  path: string
}
export type FileViewReadingPosition = import('@agentmux/editor-extensions/book-reader/protocol').BookReadingPosition
export type FileViewReadingRecord = { owner: FileViewReadingOwner; position: FileViewReadingPosition }
export type FileViewReadingReceipt = WorkbenchUserStateReceipt & { owner: FileViewReadingOwner }

export function fileViewReadingOwnerKey(owner: FileViewReadingOwner): string {
  const values = [owner?.regionId, owner?.workspaceId, owner?.hostId, owner?.workspacePath, owner?.path]
  if (!values.every(value => typeof value === 'string' && value.length > 0 && !value.includes('\0'))) {
    throw Object.assign(new Error('The original File reading preference needs its exact Region and Workspace resource.'), { code: 'FILE_VIEW_READING_OWNER_INVALID' })
  }
  return JSON.stringify(values)
}
export function isFileViewReadingPosition(value: unknown): value is FileViewReadingPosition {
  if (!value || typeof value !== 'object') return false
  const position = value as FileViewReadingPosition
  return Number.isSafeInteger(position.section) && position.section >= 0 && typeof position.sectionId === 'string' && position.sectionId.length > 0 &&
    Number.isFinite(position.progress) && position.progress >= 0 && position.progress <= 1
}
export function captureFileViewReadingOwner(owner: FileViewReadingOwner): FileViewReadingOwner {
  fileViewReadingOwnerKey(owner)
  return { regionId: owner.regionId, workspaceId: owner.workspaceId, hostId: owner.hostId, workspacePath: owner.workspacePath, path: owner.path }
}
export function encodeFileViewReading(record: FileViewReadingRecord): string {
  const owner = captureFileViewReadingOwner(record?.owner)
  if (!isFileViewReadingPosition(record?.position)) throw Object.assign(new Error('The reading position is invalid. The previous position is retained.'), { code: 'FILE_VIEW_READING_POSITION_INVALID' })
  const { section, sectionId, progress } = record.position
  return JSON.stringify({ schema: 'agentmux.file-view-reading.v1', owner, position: { section, sectionId, progress } }) + '\n'
}
