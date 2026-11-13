import { derivedActionItemOptional as find, readSettingsResource } from '@agentmux/host/settings-resource-read'
import {
  AGENT_BUILT_IN_DERIVED_ACTIONS, isAgentBuiltInDerivedActionId, parseAgentDerivedActionFields, parseAgentDerivedActionId, parseAgentDerivedActionsConfig,
  type AgentDerivedAction, type AgentDerivedActionsConfig
} from '@agentmux/core/agent-derived-actions'
import type { AgentMuxControlSettingsResourceFields as Fields, AgentMuxControlSettingsResourceRequest as Request,
  AgentMuxControlSettingsResourceResult as Result } from '@agentmux/core'
import type { AppConfig } from '../shared/contracts.js'
import { ConfigConflict, configValuesEqual } from '../shared/config-edit.js'
import type { ConfigOwner } from './config-owner.js'

function fail(code: 'INVALID_SETTING_VALUE' | 'SETTING_RESOURCE_NOT_FOUND' | 'SETTING_RESOURCE_EXISTS' | 'SETTING_IDENTITY_IMMUTABLE', message: string): never {
  throw Object.assign(new Error(message), { code })
}
/** Core parse errors carry their own code; the resource protocol reports them as invalid values. */
function parsed<T>(read: () => T): T {
  try { return read() } catch (cause) {
    const code = (cause as { code?: string }).code
    fail(code === 'SETTING_IDENTITY_IMMUTABLE' ? code : 'INVALID_SETTING_VALUE', cause instanceof Error ? cause.message : String(cause))
  }
}
function withConfig(config: AppConfig, next: AgentDerivedActionsConfig): AppConfig {
  // Validate the complete result once so list limits apply to every write path.
  const value = parsed(() => parseAgentDerivedActionsConfig(next))
  // The default (no user list, every official action visible) is not written back.
  if (!value.actions && !value.hidden) { const { agentDerivedActions: _default, ...rest } = config; return rest }
  return { ...config, agentDerivedActions: value }
}
function checkExpected(existing: Fields, expected: Fields | undefined, keys: readonly string[], id: string): void {
  if (!expected) return
  if (keys.some(key => !Object.hasOwn(expected, key))) fail('INVALID_SETTING_VALUE', 'Expected must cover every changed field.')
  for (const key of keys) {
    const previous = expected[key] === null ? undefined : expected[key]
    if (!configValuesEqual(existing[key], previous)) throw new ConfigConflict(`agentDerivedActions.${id}.${key}`)
  }
}

/** One owner transaction per write; official actions accept only their visibility. */
export async function executeSettingsDerivedActionsControl(request: Request, owner: ConfigOwner): Promise<Result> {
  if (request.operation === 'settings.resource.list' || request.operation === 'settings.resource.get') return readSettingsResource(owner.current, request)
  const id = request.id
  let changed = false
  const saved = await owner.update(current => {
    const config = current.agentDerivedActions ?? {}
    const actions = config.actions ?? []
    const existing = find(current, id)
    if (isAgentBuiltInDerivedActionId(id)) {
      if (request.operation !== 'settings.resource.update') fail('SETTING_IDENTITY_IMMUTABLE', `“${id}” is an official derived action. Hide it instead; it cannot be created or deleted.`)
      if (Object.keys(request.changes).some(key => key !== 'hidden') || typeof request.changes.hidden !== 'boolean') fail('SETTING_IDENTITY_IMMUTABLE', `“${id}” is an official derived action; only {hidden: true|false} can change.`)
      checkExpected(existing!.value, request.expected, ['hidden'], id)
      const hidden = new Set(config.hidden ?? [])
      if (request.changes.hidden) hidden.add(id); else hidden.delete(id)
      // One stable value for the same visibility: the official catalog order.
      const next = AGENT_BUILT_IN_DERIVED_ACTIONS.map(action => action.id).filter(value => hidden.has(value))
      changed = !configValuesEqual(next, config.hidden ?? [])
      if (!changed) return current
      const { hidden: _previous, ...rest } = config
      return withConfig(current, next.length ? { ...rest, hidden: next } : rest)
    }
    parsed(() => parseAgentDerivedActionId(id))
    if (request.operation === 'settings.resource.add') {
      if (existing) fail('SETTING_RESOURCE_EXISTS', `Derived action “${id}” already exists; use update.`)
      const value = parsed(() => parseAgentDerivedActionFields(request.value))
      changed = true
      return withConfig(current, { ...config, actions: [...actions, { id, ...value }] })
    }
    if (!existing) fail('SETTING_RESOURCE_NOT_FOUND', `Derived action “${id}” does not exist; update never adds an identity.`)
    if (request.operation === 'settings.resource.remove') {
      if (request.expected !== undefined && !configValuesEqual(parsed(() => parseAgentDerivedActionFields(request.expected)), existing.value)) throw new ConfigConflict(`agentDerivedActions.${id}`)
      changed = true
      return withConfig(current, { ...config, actions: actions.filter(action => action.id !== id) })
    }
    if (Object.hasOwn(request.changes, 'id')) fail('SETTING_IDENTITY_IMMUTABLE', 'Resource identity cannot be changed.')
    // null clears the optional default Agent; every other field is replaced as written.
    const combined: Record<string, unknown> = { ...existing.value, ...request.changes }
    if (request.changes.executorId === null) delete combined.executorId
    const value = parsed(() => parseAgentDerivedActionFields(combined))
    checkExpected(existing.value, request.expected, Object.keys(request.changes), id)
    changed = !configValuesEqual(value, existing.value)
    if (!changed) return current
    return withConfig(current, { ...config, actions: actions.map(action => action.id === id ? { id, ...value } as AgentDerivedAction : action) })
  })
  return request.operation === 'settings.resource.remove'
    ? { operation: request.operation, resource: 'derived-actions', id, removed: true }
    : { operation: request.operation, resource: 'derived-actions', item: find(saved, id)!, changed }
}
