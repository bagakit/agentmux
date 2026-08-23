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

export type DemandActivity = {
  id: string
  kind: string
  message: string
  createdAt: number
  actorId: string | null
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
  activities: DemandActivity[]
  decisions: DemandDecision[]
  createdAt: number
  updatedAt: number
}

export type DemandStoreSnapshot = {
  schema: typeof DEMAND_STORE_SCHEMA
  revision: number
  updatedAt: number
  demands: Demand[]
}

export type CreateDemandInput = {
  id?: string
  title: string
  description?: string
  status?: DemandStatus
  priority?: DemandPriority
  projectId?: string | null
  projectName?: string | null
  executorId?: string | null
  tags?: readonly string[]
  plannedStartAt?: number | null
  targetAt?: number | null
  parentDemandId?: string | null
  phaseIndex?: number | null
  sessionIds?: readonly string[]
}

export type UpdateDemandInput = Partial<Pick<
  Demand,
  'title' | 'description' | 'status' | 'priority' | 'projectId' | 'projectName' | 'executorId' | 'tags' | 'plannedStartAt' | 'targetAt' | 'parentDemandId' | 'phaseIndex'
>>

export type DemandReceipt = {
  schema: typeof DEMAND_RECEIPT_SCHEMA
  operation: string
  operationId: string
  revision: number
  demand: Demand
}

export type DemandStoreListener = (snapshot: DemandStoreSnapshot) => void

export function isDemandStatus(value: unknown): value is DemandStatus {
  return typeof value === 'string' && (DEMAND_STATUSES as readonly string[]).includes(value)
}

export function isDemandPriority(value: unknown): value is DemandPriority {
  return typeof value === 'string' && (DEMAND_PRIORITIES as readonly string[]).includes(value)
}
