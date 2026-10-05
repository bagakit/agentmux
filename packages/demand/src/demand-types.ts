import type { DemandDispatch } from './dispatch.js'
import type { DemandCreationOrigin, DemandParticipation, DemandParticipationSource } from './collaboration.js'
import type { DemandContentReference } from './content-references.js'
import type { DemandAlignment, DemandAlignmentProposal, DemandGrounding, DemandGroundingProposal } from './goals.js'

export const DEMAND_STORE_SCHEMA = 'agentmux.demand-store.v1' as const
export const DEMAND_RECEIPT_SCHEMA = 'agentmux.demand-receipt.v1' as const
export const DEMAND_CLI_SCHEMA = 'agentmux.demand-cli.v1' as const

export const DEMAND_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
] as const
export type DemandStatus = (typeof DEMAND_STATUSES)[number]

export const DEMAND_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type DemandPriority = (typeof DEMAND_PRIORITIES)[number]

/** Established by the calling host, never by a Demand business payload. */
export type DemandNameContext = {
  actor: { kind: 'agent' | 'user' | 'device' | 'unknown'; id: string | null; verified: boolean }
  source: string
  entryPoint: string
  transport: string | null
  location: Record<string, string | null>
}

export type DemandNameChangeRecord = {
  id: string
  operationId: string
  target: { kind: 'demand'; id: string }
  before: string
  requested: string | null
  actual: string
  context: DemandNameContext
  ownerRevision: number | null
  status: 'applied' | 'failed' | 'unknown'
  startedAt: number
  settledAt: number
  reason: string | null
}

export type DemandTitleMutationOptions = {
  context?: DemandNameContext
  operationId?: string
  /** CAS against this owner snapshot; callers may omit it for an unconditional update. */
  expectedRevision?: number
  /** Compare this exact record before a content update. */
  expectedUpdatedAt?: number
  /** Established by the trusted calling host, never a business patch. */
  participation?: DemandParticipationSource
}

export type DemandActivity = {
  id: string
  kind: string
  message: string
  createdAt: number
  actorId: string | null
  /** Original business operation, separate from the transport request ID. */
  operationId?: string
  nameChangeId?: string
  /** Read projection of the snapshot's history owner; never a second persisted record. */
  nameChange?: DemandNameChangeRecord
}

export type DemandDecision = {
  id: string
  question: string
  decision: string
  rationale: string
  createdAt: number
  actorId: string | null
}

export type Demand = {
  id: string
  title: string
  description: string
  status: DemandStatus
  priority: DemandPriority
  projectId: string | null
  projectName: string | null
  executorId: string | null
  tags: string[]
  plannedStartAt: number | null
  targetAt: number | null
  parentDemandId: string | null
  phaseIndex: number | null
  sessionIds: string[]
  assigneeSessionIds: string[]
  supervisorSessionId: string | null
  participations: DemandParticipation[]
  creationOrigin?: DemandCreationOrigin
  /** Append-only original content provenance, not execution or display ownership. */
  contentRefs?: DemandContentReference[]
  /** Explicit Start provenance. Historical relations and activity never author this fact. */
  dispatches?: DemandDispatch[]
  activities: DemandActivity[]
  decisions: DemandDecision[]
  alignment?: DemandAlignment
  grounding?: DemandGrounding
  createdAt: number
  updatedAt: number
}

export type DemandStoreSnapshot = {
  schema: typeof DEMAND_STORE_SCHEMA
  revision: number
  updatedAt: number
  demands: Demand[]
  /** Survives deletion of the named object; title and history share this snapshot commit. */
  nameHistory: DemandNameChangeRecord[]
}

export type CreateDemandInput = {
  id?: string
  title: string
  description?: string
  status?: DemandStatus
  priority?: DemandPriority
  projectId?: string | null
  projectName?: string | null
  tags?: readonly string[]
  plannedStartAt?: number | null
  targetAt?: number | null
  parentDemandId?: string | null
  phaseIndex?: number | null
  sessionIds?: readonly string[]
  assigneeSessionIds?: readonly string[]
  supervisorSessionId?: string | null
  contentRefs?: readonly DemandContentReference[]
}

export type UpdateDemandInput = Partial<Pick<
  Demand,
  'title' | 'description' | 'status' | 'priority' | 'projectId' | 'projectName' | 'assigneeSessionIds' | 'supervisorSessionId' | 'sessionIds' | 'tags' | 'plannedStartAt' | 'targetAt' | 'parentDemandId' | 'phaseIndex' | 'contentRefs'
>> & { alignment?: DemandAlignmentProposal; grounding?: DemandGroundingProposal }

export type DemandCreateOptions = {
  operationId?: string
  context?: DemandNameContext
  participation?: DemandParticipationSource
  /** Creation policy snapshot admitted by the original host. */
  creationOrigin?: { requesterAsSupervisor: boolean }
}

export type DemandReceipt = {
  schema: typeof DEMAND_RECEIPT_SCHEMA
  operation: string
  operationId: string
  revision: number
  demand: Demand
  nameChange?: DemandNameChangeRecord
  /** The existing operation was observed again; no update was reapplied. */
  replayed?: true
}

export type DemandActivityInspection = {
  demandId: string
  operationId: string
  activity: DemandActivity | null
  diskDurability: 'confirmed'
}
export type DemandActivityRead = { demandId: string; activities: DemandActivity[]; diskDurability: 'confirmed' }

export type DemandNameChangePage = {
  revision: number
  records: DemandNameChangeRecord[]
  nextOffset: number | null
}

export type DemandStoreListener = (snapshot: DemandStoreSnapshot) => void

export function isDemandStatus(value: unknown): value is DemandStatus {
  return typeof value === 'string' && (DEMAND_STATUSES as readonly string[]).includes(value)
}

export function isDemandPriority(value: unknown): value is DemandPriority {
  return typeof value === 'string' && (DEMAND_PRIORITIES as readonly string[]).includes(value)
}
