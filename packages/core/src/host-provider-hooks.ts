import { createHash } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { managedHookConfigurationIdentity, type AgentHostExecutorHookResult, type AgentManagedHookInspection,
  type AgentManagedHookPlan } from './managed-hook-installer.js'
import type { AgentHookStrategy, AgentProviderId } from './types.js'

type HookExecutor = { executorId: string; label: string; configRevision: string; canInspectLoading: boolean }

export type AgentHostProviderHookListInput = { providerId?: AgentProviderId; workspacePath?: string }
export type AgentHostProviderHookTarget = AgentHostProviderHookListInput & {
  runtimeId: string; providerId: AgentProviderId; scopeId: string; scopeRevision: string
}
export type AgentHostProviderHookScope = Pick<AgentHostExecutorHookResult, 'inspection' | 'health' | 'canUpdate' | 'update'> & {
  providerId: AgentProviderId
  scopeId: string
  scopeRevision?: string
  kind: 'configuration' | 'launch-carried' | 'unresolved' | 'unmanaged'
  paths: string[]
  executors: HookExecutor[]
}
export type AgentHostProviderHookList = { runtimeId: string; workspacePath?: string; scopes: AgentHostProviderHookScope[] }
export type AgentHostProviderHookResult = { runtimeId: string; workspacePath?: string; scope: AgentHostProviderHookScope }

type PlannedScope = Pick<AgentHostProviderHookScope, 'providerId' | 'scopeId' | 'scopeRevision' | 'kind' | 'paths' | 'executors'> & {
  plan?: AgentManagedHookPlan
  observation?: AgentManagedHookInspection
}

export function managedHookObservation(providerId: AgentProviderId, status: AgentManagedHookInspection['status'],
  code: string, action: string | null): AgentManagedHookInspection {
  return { providerId, checkedAt: Date.now(), status, code, action, targets: [] }
}

export function unsupportedManagedHook(providerId: AgentProviderId, strategy: AgentHookStrategy) {
  return managedHookObservation(providerId, 'skipped', strategy.kind === 'none' ? 'HOOKS_UNSUPPORTED' : 'HOOKS_NOT_MANAGED',
    strategy.kind === 'none' ? null : 'This Provider owns its Hook setup; inspect it through the Provider.')
}

export function managedHookInspectionFailure(providerId: AgentProviderId, error: unknown) {
  if (error instanceof AgentMuxError && error.code === 'HOOK_WORKSPACE_REQUIRED') {
    return managedHookObservation(providerId, 'skipped', error.code, error.message)
  }
  return managedHookObservation(providerId, 'error', error instanceof AgentMuxError ? error.code : 'MANAGED_HOOK_CHECK_FAILED',
    'The scoped Hook inspection did not complete. Check the Provider configuration and native reader, then inspect again.' +
      (error instanceof AgentMuxError ? ` ${error.message}` : ''))
}

export function managedHookHealth(inspection: AgentManagedHookInspection,
  unmanaged: boolean): AgentHostExecutorHookResult['health'] {
  const issue = inspection.status === 'not_installed' || inspection.targets.some(target =>
    target.legacyDeclarations || target.code === 'HOOK_TARGET_UNPARSEABLE' || target.code === 'UNSAFE_HOOK_TARGET') ||
    ['MANAGED_HOOK_INCOMPLETE', 'HOOK_CONFIGURATION_DISABLED', 'HOOK_NATIVE_DISABLED'].includes(inspection.code)
  return inspection.status === 'installed' ? 'current' : unmanaged ? 'not-managed' : issue ? 'issue' : 'unknown'
}

export function groupProviderHookScopes<T>(executors: readonly T[], resolve: (executor: T) => {
  providerId: AgentProviderId; executor: HookExecutor; kind: PlannedScope['kind']; plan?: AgentManagedHookPlan; observation?: AgentManagedHookInspection
}): PlannedScope[] {
  const groups = new Map<string, PlannedScope>()
  for (const entry of executors) {
    const { providerId, executor, ...scope } = resolve(entry)
    let { kind, plan, observation } = scope
    let identity
    try { identity = plan && managedHookConfigurationIdentity(plan) }
    catch (error) {
      kind = 'unresolved'
      plan = undefined
      observation = managedHookInspectionFailure(providerId, error)
    }
    const scopeId = identity?.scopeId ?? createHash('sha256').update(JSON.stringify([providerId, kind,
      kind === 'unresolved' ? executor.executorId : null])).digest('hex')
    const previous = groups.get(scopeId)
    if (!previous) {
      groups.set(scopeId, { providerId, kind, scopeId, paths: identity?.paths ?? [], executors: [executor],
        ...(plan && identity ? { plan, scopeRevision: identity.scopeRevision } : {}), ...(observation ? { observation } : {}) })
      continue
    }
    previous.executors.push(executor)
    if (plan && previous.scopeRevision !== identity?.scopeRevision) {
      delete previous.plan
      delete previous.scopeRevision
      previous.observation = managedHookObservation(providerId, 'error', 'HOOK_SCOPE_PLAN_CONFLICT',
        'The Executors targeting this native configuration disagree on the managed Hook declaration. Check their Provider configurations and refresh.')
    }
  }
  return [...groups.values()]
}
