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

