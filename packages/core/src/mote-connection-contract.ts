import type {
  MotePreferencesTarget,
  MoteConnectionRef,
  MoteConnectionPreferencesSaveParams,
  MoteConnectionPreferencesSaveResult
} from './mote-preferences.js'
import type { ConnectionEnrollmentOperation, ConnectionEnrollmentCallContext, ConnectionEnrollmentAdvanceInput } from './connection-enrollment-contract.js'
import type { DesiredConnectionProfile, ConnectionProfileOperation } from './connection-profile-contract.js'
import type { ConnectionSetupInitialPublication, ConnectionSetupOperation, ConnectionSetupAdvance } from './connection-setup-contract.js'

/** Public client preparation provenance; it grants no authority over current appearance. */
export type MoteConnectionSource = {
  target: MotePreferencesTarget
  preparedFrom: { topicRevision: string; avatarRevision: string | null } | null
}
/** Original admission prerequisites retained only on historical operation receipts. */
export type MoteConnectionRecordedSource = MoteConnectionSource | {
  target: MotePreferencesTarget
  expectedTopicRevision: string
  expectedAvatarRevision: string | null
}
export type MoteConnectionDesired = DesiredConnectionProfile & { name: string; description: string }
export type MoteConnectionCreate = {
  operationId: string
  source: MoteConnectionSource
  desired: MoteConnectionDesired & { avatar: { pngDataUrl: string } }
  adapterId: string
  domain: string
  /** Explicit authority to configure and publish this new identity for its creator. */
  initialPublication?: ConnectionSetupInitialPublication
}
export type MoteConnectionSync = {
  operationId: string
  source: MoteConnectionSource
  desired: MoteConnectionDesired
  connection: MoteConnectionRef
  expectedConnectionRevision: number
}
export type MoteConnectionOperation = {
  operationId: string
  action: 'create' | 'sync'
  source: MoteConnectionRecordedSource
  snapshot: { name: string; description: string | null; avatarSha256: string | null }
  connection: MoteConnectionRef | null
  enrollmentOperationId: string | null
  profileOperationId: string | null
  /** New profile management belongs to the original Console Setup owner. */
  setupOperationId?: string | null
  setup?: ConnectionSetupOperation | null
  defaultSave: { params: MoteConnectionPreferencesSaveParams; observedReceipt: MoteConnectionPreferencesSaveResult | null } | null
  enrollment: ConnectionEnrollmentOperation | null
  profile: ConnectionProfileOperation | null
  defaultLink: {
    state: 'not-requested' | 'pending' | 'saved' | 'conflict' | 'unknown'
    current: { connection: MoteConnectionRef | null; fileRevision: string | null } | null
  }
  issue:
    | 'source-unconfirmed'
    | 'storage-unconfirmed'
    | 'child-unconfirmed'
    | 'default-unconfirmed'
    | 'default-conflict'
    | 'connection-revised'
    | null
}
export type MoteConnectionOperationInput = { operationId: string }
export type MoteConnectionAdvanceInput = MoteConnectionOperationInput & { enrollment?: ConnectionEnrollmentAdvanceInput; setup?: ConnectionSetupAdvance }
export type MoteConnectionListInput = { target: MotePreferencesTarget; cursor?: string; limit?: number }
export type MoteConnectionParamsMap = {
  'space.mote.connection.create': MoteConnectionCreate
  'space.mote.connection.sync': MoteConnectionSync
  'space.mote.connection.advance': MoteConnectionAdvanceInput
  'space.mote.connection.inspect': MoteConnectionOperationInput
  'space.mote.connection.ls': MoteConnectionListInput
}
export type MoteConnectionResultMap = {
  'space.mote.connection.create': MoteConnectionOperation
  'space.mote.connection.sync': MoteConnectionOperation
  'space.mote.connection.advance': MoteConnectionOperation
  'space.mote.connection.inspect': { operation: MoteConnectionOperation | null }
  'space.mote.connection.ls': { operations: MoteConnectionOperation[]; next: string | null }
}
export type MoteConnectionMethod = keyof MoteConnectionParamsMap
/** Original executing Host composition; neither the Renderer nor JSON supplies authority. */
export interface MoteConnectionPort {
  create(input: MoteConnectionCreate, context: ConnectionEnrollmentCallContext): Promise<MoteConnectionOperation>
  sync(input: MoteConnectionSync, context: ConnectionEnrollmentCallContext): Promise<MoteConnectionOperation>
  advance(input: MoteConnectionAdvanceInput, context: ConnectionEnrollmentCallContext): Promise<MoteConnectionOperation>
  inspect(input: MoteConnectionOperationInput, context?: ConnectionEnrollmentCallContext): Promise<{ operation: MoteConnectionOperation | null }>
  list(input: MoteConnectionListInput, context?: ConnectionEnrollmentCallContext): Promise<{ operations: MoteConnectionOperation[]; next: string | null }>
}
