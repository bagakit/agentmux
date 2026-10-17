import type {
  MotePreferencesTarget,
  MoteConnectionRef,
  MoteConnectionPreferencesSaveParams,
  MoteConnectionPreferencesSaveResult
} from './mote-preferences.js'
import type { ConnectionEnrollmentOperation, ConnectionEnrollmentCallContext, ConnectionEnrollmentAdvanceInput } from './connection-enrollment-contract.js'
import type { ConnectionProfileOperation } from './connection-profile-contract.js'

/** Exact saved sources. An appearance revision is required only for include-saved. */
export type MoteConnectionSource = { target: MotePreferencesTarget; expectedTopicRevision: string; expectedAvatarRevision: string | null }
export type MoteConnectionCreate = {
  operationId: string
  source: MoteConnectionSource
  adapterId: string
  domain: string
  avatar: 'include-saved' | 'omit'
  /** Omit to use the exact saved Mote name; an explicit name is frozen for this creation. */
  name?: string
}
export type MoteConnectionSync = {
  operationId: string
  source: MoteConnectionSource
  connection: MoteConnectionRef
  expectedConnectionRevision: number
  avatar: 'include-saved' | 'omit'
}
export type MoteConnectionOperation = {
  operationId: string
  action: 'create' | 'sync'
  source: MoteConnectionSource
  snapshot: { name: string; description: string | null; avatarSha256: string | null }
  connection: MoteConnectionRef | null
  enrollmentOperationId: string | null
  profileOperationId: string
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
export type MoteConnectionAdvanceInput = MoteConnectionOperationInput & { enrollment?: ConnectionEnrollmentAdvanceInput }
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
