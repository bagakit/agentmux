export type DemandStoreErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_SNAPSHOT'
  | 'NOT_FOUND'
  | 'LOCK_TIMEOUT'
  | 'WRITE_FAILED'
  | 'READ_FAILED'

export type DemandStoreErrorPhase = 'validate' | 'read' | 'lock' | 'write'

export class DemandStoreError extends Error {
  readonly name = 'DemandStoreError'
  readonly code: DemandStoreErrorCode
  readonly phase: DemandStoreErrorPhase
  readonly path: string
  readonly cause?: unknown

  constructor(
    code: DemandStoreErrorCode,
    phase: DemandStoreErrorPhase,
    path: string,
    message: string,
    cause?: unknown,
  ) {
    super(message)
    this.code = code
    this.phase = phase
    this.path = path
    this.cause = cause
  }
}

export function isDemandStoreError(error: unknown): error is DemandStoreError {
  return error instanceof DemandStoreError
}
