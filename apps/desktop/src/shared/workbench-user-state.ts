export type WorkbenchUserStateFailure = {
  operation: 'read' | 'write'
  phase: 'request' | 'before-replace' | 'after-replace' | null
  code: string | null
  observedAt: number
}

export type WorkbenchUserStateConfirmation = {
  path: string
  contentDigest: string
  sizeBytes: number
  diskDurability: 'confirmed'
  confirmedAt: number
}

type WorkbenchInputArchiveReceipt = {
  /** Owners whose cold records changed in this commit. Null means an explicit full clear. */
  inputQueueArchiveOwners?: string[] | null
  /** Exact submitted entries the owner has durably removed from the hot projection. */
  inputQueueArchived?: { ownerKey: string; operationId: string }[]
}

export type WorkbenchUserStateReceipt = WorkbenchUserStateConfirmation & WorkbenchInputArchiveReceipt

/** Private Desktop IPC admission, scoped by Main to the original native document. */
export type WorkbenchUserStateWrite = { value: string; writeRevision: number }
export type WorkbenchUserStateWriteReceipt = WorkbenchUserStateReceipt & { writeRevision: number }

/** A private save names changed inputs. The envelope's state carries the drafts in the same transaction. */
export type WorkbenchInputQueueChange = {
  ownerKey: string
  order: readonly string[]
  upsert: readonly { operationId: string; entry: Record<string, unknown> }[]
  remove: readonly string[]
}
export type WorkbenchInputQueueDelta = { changes: readonly WorkbenchInputQueueChange[]; clear?: true }
export type WorkbenchInputArchiveQuery = { ownerKey?: string; operationId?: string; after?: string; limit?: number }
export type WorkbenchInputArchivePage = {
  entries: { ownerKey: string; entry: Record<string, unknown> }[]
  nextCursor: string | null
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function inputKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function uniqueInputKeys(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(inputKey) && new Set(value).size === value.length
}

export function parseWorkbenchInputQueueDelta(value: unknown): WorkbenchInputQueueDelta {
  const delta = record(value)
  const invalid = () => Object.assign(new Error('Desktop input changes must name their original queue and operation. The saved document is retained.'),
    { code: 'WORKBENCH_USER_STATE_INVALID' })
  if (!delta || !Array.isArray(delta.changes) || delta.clear !== undefined && delta.clear !== true) throw invalid()
  const owners = new Set<string>()
  for (const value of delta.changes) {
    const change = record(value)
    if (!change || !inputKey(change.ownerKey) || owners.has(change.ownerKey) || !uniqueInputKeys(change.order) ||
        !uniqueInputKeys(change.remove) || !Array.isArray(change.upsert)) throw invalid()
    owners.add(change.ownerKey)
    const order = new Set(change.order), changed = new Set<string>()
    if (change.remove.some(id => order.has(id))) throw invalid()
    for (const value of change.upsert) {
      const update = record(value)
      if (!update || !inputKey(update.operationId) || !order.has(update.operationId) || changed.has(update.operationId) ||
          record(update.entry)?.operationId !== update.operationId) throw invalid()
      changed.add(update.operationId)
    }
  }
  return delta as WorkbenchInputQueueDelta
}

export function parseWorkbenchInputArchiveQuery(value: unknown): WorkbenchInputArchiveQuery {
  const query = record(value)
  if (!query || (Object.hasOwn(query, 'ownerKey') && !inputKey(query.ownerKey)) ||
      (Object.hasOwn(query, 'operationId') && (!inputKey(query.operationId) || !inputKey(query.ownerKey) || query.after !== undefined)) ||
      (Object.hasOwn(query, 'after') && !inputKey(query.after)) ||
      (Object.hasOwn(query, 'limit') && (typeof query.limit !== 'number' || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100))) {
    throw Object.assign(new Error('Choose an original input archive or open one bounded page.'), { code: 'WORKBENCH_INPUT_ARCHIVE_QUERY_INVALID' })
  }
  return query as WorkbenchInputArchiveQuery
}

/** Archive is presentation. Only a confirmed original direct input can leave the hot workface. */
export function workbenchInputArchiveEligible(value: unknown): boolean {
  const entry = record(value)
  if (!entry || entry.archived !== true || !inputKey(entry.operationId) || typeof entry.text !== 'string' ||
      ['movedToDraft', 'originalMember', 'recoveredSourceInput', 'resumeInputIntent', 'inputStopIntent', 'inputStopReceipt', 'mainRollover', 'browserInput', 'browserRecipient',
        'goalDispatch', 'goalPmo', 'goalContinuation', 'agentMuxNote', 'moteMain', 'moteSource'].some(key => entry[key] !== undefined)) return false
  const control = record(entry.directInputControl), binding = record(entry.directInputBinding)
  const receipt = record(entry.inputReceipt), key = record(receipt?.key)
  const runId = record(control?.run)?.runId
  const ref = record(receipt?.ref), wait = record(receipt?.control), waitRef = record(wait?.ref)
  const matchesRoute = (value: unknown) => {
    const target = record(value)
    return target?.kind === 'prompt' && target.agentSessionId === control?.agentSessionId &&
      target.submissionId === entry.operationId && target.attemptId === key?.attemptId && record(target.expectedRun)?.runId === runId
  }
  return control?.kind === 'agent' && inputKey(control.hostId) && inputKey(control.agentSessionId) && inputKey(runId) &&
    record(binding?.expectedRun)?.runId === runId && matchesRoute(key) && matchesRoute(ref?.key) && matchesRoute(waitRef?.key) &&
    typeof ref?.waitGeneration === 'number' && Number.isSafeInteger(ref.waitGeneration) && ref.waitGeneration >= 1 &&
    ref.waitGeneration === waitRef?.waitGeneration &&
    (wait?.state === 'dispatch-authorized' || wait?.state === 'enabled' || wait?.state === 'stopped-before-dispatch') &&
    (receipt?.observation === 'closed' || receipt?.observation === 'owned' || receipt?.observation === 'rejoin-needed') &&
    receipt.persistence === 'confirmed' &&
    (receipt.status === 'admitted' || receipt.status === 'terminal-confirmed' || receipt.status === 'launch-carried')
}

export type WorkbenchUserStateObservation = {
  path: string
  availability: 'present' | 'missing' | 'unconfirmed'
  contentDigest: string | null
  sizeBytes: number | null
  diskDurability: 'confirmed' | 'unconfirmed'
  confirmedAt: number | null
  /** Metadata from the original write in this Main lifetime. A read never extends it to another file. */
  lastConfirmedWrite: (WorkbenchUserStateConfirmation & { [Key in keyof WorkbenchInputArchiveReceipt]?: never }) | null
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
