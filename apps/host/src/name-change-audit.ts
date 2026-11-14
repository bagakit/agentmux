import { mintObjectId } from '@agentmux/core/object-id'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentMuxNameContext, AgentMuxNameChangeIntent, AgentMuxNameChangeRecord, AgentMuxNameChangeAdmission, AgentMuxNameChangeSettlement, AgentMuxNameTarget } from '@agentmux/core/control'

/** Request provenance is captured by the trusted host, never by an editable name payload. */
export const nameChangeRequests = new AsyncLocalStorage<{ context: AgentMuxNameContext; operationId: string }>()

export function unknownNameContext(entryPoint: string): AgentMuxNameContext {
  return { actor: { kind: 'unknown', id: null, verified: false }, source: 'owner', entryPoint,
    transport: null, location: {} }
}

export interface NameChangeRecordPort {
  beginNameChange(input: AgentMuxNameChangeIntent): Promise<AgentMuxNameChangeAdmission>
  settleNameChange(input: AgentMuxNameChangeSettlement): Promise<AgentMuxNameChangeRecord>
}
export type NamedChange = { target: AgentMuxNameTarget; before: string | null; requested: string | null;
  ownerRevision?: string | number | null; location?: Record<string, string | null> }

/** Different owners keep their own writes. A durable intent precedes them; an absent result stays unknown. */
export class NameChangeAudit {
  constructor(private readonly port: NameChangeRecordPort) {}

  async run<T>(changes: readonly NamedChange[], apply: () => Promise<T>,
    observe?: (result: T, change: NamedChange) => { actual: string | null; ownerRevision?: string | number | null;
      status?: 'applied' | 'failed' | 'unknown'; reason?: string | null },
    failure?: (error: unknown) => 'failed' | 'unknown'): Promise<T> {
    if (changes.length === 0) return await apply()
    const request = nameChangeRequests.getStore()
    const context = structuredClone(request?.context ?? unknownNameContext('name-owner'))
    const records: AgentMuxNameChangeRecord[] = []
    try {
      for (const [index, change] of changes.entries()) {
        const { location, ...intent } = change
        const record = await this.port.beginNameChange({ ...intent,
          operationId: `${request?.operationId ?? mintObjectId()}/name/${index}`,
          context: { ...context, location: { ...context.location, ...location } } })
        if (record.replayed) throw Object.assign(new Error(
          `Name operation ${record.id} is already recorded as ${record.status}. Inspect that operation and the current name before making a new edit.`
        ), { code: 'NAME_CHANGE_ALREADY_RECORDED', operationId: record.id, applied: record.status === 'applied' })
        records.push(record)
      }
    } catch (error) {
      // Earlier intents in a multi-name edit were accepted, but no data mutation has started.
      await Promise.allSettled(records.map(record => this.port.settleNameChange({
        id: record.id, status: 'failed', actual: record.before, reason: 'Name recording failed before the owner write.'
      })))
      throw error
    }
    let result: T
    try { result = await apply() }
    catch (error) {
      const status = failure?.(error) ?? 'unknown'
      await Promise.allSettled(records.map(record => this.port.settleNameChange({
        id: record.id, status, ...(status === 'failed' ? { actual: record.before } : {}),
        reason: error instanceof Error ? error.message : String(error)
      })))
      throw error
    }
    const outcomes = await Promise.allSettled(records.map(async (record, index) => await this.port.settleNameChange({
      id: record.id, status: 'applied', ...(observe?.(result, changes[index]!) ?? { actual: record.requested })
    })))
    if (outcomes.some(outcome => outcome.status === 'rejected')) throw Object.assign(new Error(
      `The name owner applied the change, but its audit result is unconfirmed. Keep the applied name; inspect operations ${records.map(record => record.id).join(', ')} before retrying.`
    ), { code: 'NAME_CHANGE_RESULT_UNCONFIRMED', applied: true, operationIds: records.map(record => record.id) })
    return result
  }
}

