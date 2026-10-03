import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { AgentMuxNameContext, AgentMuxNameChangeIntent, AgentMuxNameChangeRecord,
  AgentMuxNameChangeAdmission, AgentMuxNameChangeSettlement, AgentMuxNameTarget } from '@agentmux/core/control'
import type { AppConfig } from '../shared/contracts.js'

/** Request provenance is captured by the trusted host, never by an editable name payload. */
export const nameChangeRequests = new AsyncLocalStorage<{ context: AgentMuxNameContext; operationId: string }>()

export function unknownNameContext(entryPoint: string): AgentMuxNameContext {
  return { actor: { kind: 'unknown', id: null, verified: false }, source: 'owner', entryPoint,
    transport: null, location: {} }
}

export function desktopNameContext(entryPoint: string, sender: unknown, expected: unknown,
  windowId: number): AgentMuxNameContext {
  if (!Object.is(sender, expected)) return unknownNameContext(entryPoint)
  const webContentsId = (sender as { id?: number }).id
  const uid = process.getuid?.()
  return { actor: uid === undefined ? { kind: 'unknown', id: null, verified: false }
    : { kind: 'device', id: `local-user:${uid}`, verified: true },
    source: 'desktop-ui', entryPoint, transport: 'electron-ipc',
    location: { windowId: String(windowId), webContentsId: webContentsId === undefined ? null : String(webContentsId) } }
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
          operationId: `${request?.operationId ?? randomUUID()}/name/${index}`,
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

// Package names belong to their manifests, not the configuration's editable labels.
function namedToolkitTools(config: AppConfig) {
  return (config.toolkit?.tools ?? []).filter(tool => 'name' in tool)
}

/** Only existing objects can be renamed. Registration/deletion is not fabricated rename history. */
export function configNameChanges(before: AppConfig, after: AppConfig): NamedChange[] {
  const changes: NamedChange[] = []
  const compare = (kind: string, old: Record<string, string>, next: Record<string, string>): void => {
    for (const [id, value] of Object.entries(old)) {
      if (Object.hasOwn(next, id) && next[id] !== value) changes.push({ target: { kind, id }, before: value, requested: next[id]! })
    }
  }
  compare('executor', Object.fromEntries(Object.entries(before.executors).map(([id, value]) => [id, value.label])),
    Object.fromEntries(Object.entries(after.executors).map(([id, value]) => [id, value.label])))
  compare('prompt', Object.fromEntries((before.composerShortcuts ?? []).map(value => [value.id, value.label])),
    Object.fromEntries((after.composerShortcuts ?? []).map(value => [value.id, value.label])))
  compare('host', Object.fromEntries(before.hosts.map(value => [value.id, value.label])),
    Object.fromEntries(after.hosts.map(value => [value.id, value.label])))
  compare('workspace', Object.fromEntries(before.workspaces.map(value => [value.id, value.name])),
    Object.fromEntries(after.workspaces.map(value => [value.id, value.name])))
  compare('toolkit', Object.fromEntries(namedToolkitTools(before).map(value => [value.id, value.name])),
    Object.fromEntries(namedToolkitTools(after).map(value => [value.id, value.name])))
  const actions = (config: AppConfig): Record<string, string> => Object.fromEntries(namedToolkitTools(config)
    .flatMap(tool => (tool.actions ?? []).map(action => [JSON.stringify([tool.id, action.id]), action.label])))
  compare('toolkit-action', actions(before), actions(after))
  return changes
}

/** Read back the original owner value; normalization can differ from the request. */
export function configNameValue(config: AppConfig, target: AgentMuxNameTarget): string | null {
  switch (target.kind) {
    case 'executor': return config.executors[target.id]?.label ?? null
    case 'prompt': return config.composerShortcuts?.find(item => item.id === target.id)?.label ?? null
    case 'host': return config.hosts.find(item => item.id === target.id)?.label ?? null
    case 'workspace': return config.workspaces.find(item => item.id === target.id)?.name ?? null
    case 'toolkit': return namedToolkitTools(config).find(item => item.id === target.id)?.name ?? null
    case 'toolkit-action': return namedToolkitTools(config).flatMap(tool => (tool.actions ?? []).map(action => ({
      id: JSON.stringify([tool.id, action.id]), label: action.label }))).find(item => item.id === target.id)?.label ?? null
    default: return null
  }
}
