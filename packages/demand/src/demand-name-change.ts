import type { DemandNameChangeRecord, DemandNameContext } from './demand-types.js'

function text(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && (allowEmpty || value.trim().length > 0)
}

/** This validates the host's attribution envelope, not its authentication. */
export function demandNameContext(context?: DemandNameContext): DemandNameContext {
  if (context === undefined) return {
    actor: { kind: 'unknown', id: null, verified: false }, source: 'unknown', entryPoint: 'demand.update', transport: null, location: {}
  }
  if (!context || !context.actor || !['agent', 'user', 'device', 'unknown'].includes(context.actor.kind) ||
      typeof context.actor.verified !== 'boolean' || !(context.actor.id === null || text(context.actor.id)) ||
      (context.actor.verified && (context.actor.kind === 'unknown' || context.actor.id === null)) ||
      !text(context.source) || !text(context.entryPoint) || !(context.transport === null || text(context.transport)) ||
      !context.location || typeof context.location !== 'object' || Array.isArray(context.location) ||
      Object.keys(context.location).length > 32 || Object.entries(context.location).some(([key, value]) => !text(key) || !(value === null || text(value, true)))) {
    throw new Error('Demand rename attribution must be a valid host context.')
  }
  return { actor: { kind: context.actor.kind, id: context.actor.id, verified: context.actor.verified }, source: context.source,
    entryPoint: context.entryPoint, transport: context.transport, location: { ...context.location } }
}

export function parseDemandNameChange(value: unknown): DemandNameChangeRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Demand nameChange must be an object.')
  const record = value as DemandNameChangeRecord
  const keys = ['id', 'operationId', 'target', 'before', 'requested', 'actual', 'context', 'ownerRevision', 'status', 'startedAt', 'settledAt', 'reason']
  if (Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => !(key in record)) ||
      !text(record.operationId) || record.id !== record.operationId || !record.target || record.target.kind !== 'demand' || typeof record.target.id !== 'string' || !record.target.id.trim() ||
      typeof record.before !== 'string' || !(record.requested === null || typeof record.requested === 'string') || typeof record.actual !== 'string' ||
      !(record.ownerRevision === null || (Number.isSafeInteger(record.ownerRevision) && record.ownerRevision > 0)) ||
      !['applied', 'failed', 'unknown'].includes(record.status) || !Number.isSafeInteger(record.startedAt) || record.startedAt <= 0 ||
      !Number.isSafeInteger(record.settledAt) || record.settledAt < record.startedAt || !(record.reason === null || typeof record.reason === 'string')) {
    throw new Error('Demand nameChange facts are invalid.')
  }
  return { ...structuredClone(record), context: demandNameContext(record.context) }
}
