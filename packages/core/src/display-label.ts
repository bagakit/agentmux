import { AgentMuxError } from './errors.js'
import type { AgentMuxSpatialGraph, SpatialJson } from './spatial-graph.js'

/** Generic host labels. The host interprets target identity and displayed fallbacks. */
export type AgentMuxNameTarget = { kind: string; id: string }
export type AgentMuxNameActor = { kind: 'agent' | 'user' | 'device' | 'unknown'; id: string | null; verified: boolean }
export type AgentMuxNameContext = {
  actor: AgentMuxNameActor
  source: string
  entryPoint: string
  transport: string | null
  location: Record<string, string | null>
}
export type AgentMuxNameChangeIntent = {
  operationId: string
  target: AgentMuxNameTarget
  before: string | null
  requested: string | null
  context: AgentMuxNameContext
  ownerRevision?: string | number | null
}
export type AgentMuxNameChangeRecord = AgentMuxNameChangeIntent & {
  id: string
  status: 'pending' | 'applied' | 'failed' | 'unknown'
  actual: string | null
  startedAt: number
  settledAt: number | null
  reason: string | null
}
/** Ephemeral admission receipt; replay is not written into immutable history. */
export type AgentMuxNameChangeAdmission = AgentMuxNameChangeRecord & { replayed: boolean }
export type AgentMuxNameChangeSettlement = {
  id: string
  status: 'applied' | 'failed' | 'unknown'
  actual?: string | null
  ownerRevision?: string | number | null
  reason?: string | null
}
export type AgentMuxNameHistoryQuery = { target?: AgentMuxNameTarget; afterId?: string; limit?: number }
export type AgentMuxNameHistoryPage = { records: AgentMuxNameChangeRecord[]; nextCursor: string | null; coverage: 'spatial' | 'host';
  /** A record's applied status proves application, never a filesystem ACK from a query. */
  diskAcknowledgement?: 'not-observed' }
export type AgentMuxDisplayLabelSource = 'manual' | 'launch' | 'derived' | 'retained'
export type AgentMuxDisplayLabel = {
  target: AgentMuxNameTarget
  value: string | null
  source: AgentMuxDisplayLabelSource
  nameRevision: number
  operationId: string
}
export type AgentMuxDisplayLabelMutation = {
  operationId: string
  target: AgentMuxNameTarget
  value: string | null
  source: Exclude<AgentMuxDisplayLabelSource, 'retained'>
  expectedNameRevision: number
}
export type AgentMuxDisplayLabelResult = {
  state: import('./spatial-graph.js').AgentMuxSpatialState
  label: AgentMuxDisplayLabel | null
  record: AgentMuxNameChangeRecord
  changed: boolean
  applied: boolean
  diskDurability: 'confirmed' | 'unconfirmed'
  issue: string | null
}
export const AGENTMUX_DISPLAY_LABEL_RESOURCE = 'agentmux:display-labels'
export type AgentMuxDisplayLabelDocument = {
  schemaVersion: 1
  /** A layout projection explicitly omits history; empty never claims no history. */
  history: 'complete' | 'query-only'
  labels: Record<string, AgentMuxDisplayLabel>
  records: AgentMuxNameChangeRecord[]
}
export function nameTargetKey(target: AgentMuxNameTarget): string { return JSON.stringify([target.kind, target.id]) }
function invalid(message: string): never { throw new AgentMuxError(message, 'NAME_CHANGE_INVALID') }
export function validateNameTarget(target: AgentMuxNameTarget): void {
  if (!target || typeof target.kind !== 'string' || !target.kind || typeof target.id !== 'string' || !target.id ||
      target.kind.includes('\0') || target.id.includes('\0')) invalid('An exact name target is required.')
}
export function validateNameContext(context: AgentMuxNameContext): void {
  if (!context || !context.actor || !['agent', 'user', 'device', 'unknown'].includes(context.actor.kind) ||
      typeof context.actor.verified !== 'boolean' || !(context.actor.id === null || typeof context.actor.id === 'string') ||
      typeof context.source !== 'string' || !context.source || typeof context.entryPoint !== 'string' || !context.entryPoint ||
      !(context.transport === null || typeof context.transport === 'string') || !context.location ||
      Object.values(context.location).some(value => value !== null && typeof value !== 'string')) invalid('Trusted name context is required.')
  if (context.actor.verified && (!context.actor.id || context.actor.kind === 'unknown')) invalid('Unknown actors cannot be verified.')
}
export function validateNameIntent(input: AgentMuxNameChangeIntent): void {
  validateNameTarget(input.target); validateNameContext(input.context)
  if (typeof input.operationId !== 'string' || !input.operationId || input.operationId.includes('\0') ||
      !(input.before === null || typeof input.before === 'string') || !(input.requested === null || typeof input.requested === 'string'))
    invalid('A name change needs an operation ID and exact before/requested values.')
}
export function parseNameChangeRecord(value: unknown): AgentMuxNameChangeRecord {
  const record = value as AgentMuxNameChangeRecord
  validateNameIntent(record)
  if (record.id !== record.operationId || !['pending', 'applied', 'failed', 'unknown'].includes(record.status) ||
      !(record.actual === null || typeof record.actual === 'string') || !Number.isFinite(record.startedAt) ||
      !(record.settledAt === null || Number.isFinite(record.settledAt)) || !(record.reason === null || typeof record.reason === 'string')) invalid('Name history result is malformed.')
  return structuredClone(record)
}
export function displayLabelDocument(graph: AgentMuxSpatialGraph): AgentMuxDisplayLabelDocument {
  const raw = graph.resources[AGENTMUX_DISPLAY_LABEL_RESOURCE]
  if (raw === undefined) return { schemaVersion: 1, history: 'complete', labels: {}, records: [] }
  const value = raw as unknown as AgentMuxDisplayLabelDocument
  if (!value || value.schemaVersion !== 1 || !['complete', 'query-only'].includes(value.history) || !value.labels || Array.isArray(value.labels) || !Array.isArray(value.records))
    invalid('The original name document is unreadable; original data is retained.')
  for (const [key, label] of Object.entries(value.labels)) {
    validateNameTarget(label.target)
    if (key !== nameTargetKey(label.target) || !['manual', 'launch', 'derived', 'retained'].includes(label.source) ||
        !Number.isSafeInteger(label.nameRevision) || label.nameRevision < 1 || !(label.value === null || typeof label.value === 'string'))
      invalid('The original name revision is unreadable; original data is retained.')
  }
  for (const record of value.records) {
    parseNameChangeRecord(record)
  }
  return structuredClone(value)
}
export function displayLabel(graph: AgentMuxSpatialGraph, target: AgentMuxNameTarget): AgentMuxDisplayLabel | null {
  return displayLabelDocument(graph).labels[nameTargetKey(target)] ?? null
}
export function setDisplayLabelDocument(graph: AgentMuxSpatialGraph, document: AgentMuxDisplayLabelDocument): void {
  graph.resources[AGENTMUX_DISPLAY_LABEL_RESOURCE] = document as unknown as SpatialJson
}
/** Layout observers carry current labels; history is read only through its query. */
export function projectSpatialState(state: import('./spatial-graph.js').AgentMuxSpatialState): import('./spatial-graph.js').AgentMuxSpatialState {
  const raw = state.graph.resources[AGENTMUX_DISPLAY_LABEL_RESOURCE] as unknown as AgentMuxDisplayLabelDocument | undefined
  if (!raw) return structuredClone(state)
  return structuredClone({ ...state, graph: { ...state.graph, resources: { ...state.graph.resources,
    [AGENTMUX_DISPLAY_LABEL_RESOURCE]: { schemaVersion: 1, history: 'query-only', labels: raw.labels, records: [] } } } })
}
