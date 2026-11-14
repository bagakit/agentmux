import { parseAdoptedHostRoute, parseHostRouteConfiguration, parseHostRouteParams, parseHostRouteResult,
  type HostRouteConfiguration, type HostRouteParams, type HostRouteSettings } from '@agentmux/core/host-route'
import { configValuesEqual } from '../../../shared/config-edit'

/** Authored input and original save references. Current policy stays at its Core. */
export type HostRouteDraft = {
  baseline: HostRouteSettings
  configuration: HostRouteConfiguration
  retainedSaves: Array<{ input: HostRouteParams['route.configure']; notSent?: true; refusal?: HostRouteSaveRefusal }>
  grantRequestText?: string
}
const REFUSED_SAVES = ['HOST_ROUTE_POLICY_CHANGED', 'HOST_ROUTE_OPERATION_CHANGED', 'HOST_ROUTE_SOURCE_MISMATCH'] as const
export type HostRouteSaveRefusal = { code: typeof REFUSED_SAVES[number]; message: string }
/** These original Core codes reject configure before its durable write. Other failures stay unknown. */
export function hostRouteSaveRefusal(cause: unknown): HostRouteSaveRefusal | undefined {
  if (!cause || typeof cause !== 'object') return undefined
  const value = cause as { code?: unknown; message?: unknown }
  return REFUSED_SAVES.some(code => code === value.code) && typeof value.message === 'string'
    ? { code: value.code as HostRouteSaveRefusal['code'], message: value.message } : undefined
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const unreadable = (): never => { throw Error('The original route edit is unreadable. Its record is retained; saved routes and existing work remain available.') }
function entries(value: unknown): Record<string, unknown> { return value === undefined ? {} : record(value) ? value : unreadable() }

/** Empty names are valid while editing, but the original Core validates every Save. */
function draftConfiguration(value: unknown): HostRouteConfiguration {
  if (!record(value) || !Array.isArray(value.routes) || !Array.isArray(value.grants)) return unreadable()
  const routes = value.routes.map(row => {
    if (!record(row) || typeof row.id !== 'string') return unreadable()
    return { id: row.id, route: parseAdoptedHostRoute(row.route) }
  })
  const grants = value.grants.map(row => {
    if (!record(row) || typeof row.id !== 'string') return unreadable()
    const parsed = parseHostRouteConfiguration({ routes: [], grants: [{ ...row, id: row.id || 'draft' }] }).grants[0]!
    return { ...parsed, id: row.id }
  })
  return { routes, grants }
}
export function readHostRouteDraft(value: unknown, runtimeId: string): HostRouteDraft | undefined {
  const raw = entries(value)[runtimeId]
  if (raw === undefined) return undefined
  if (!record(raw) || !Array.isArray(raw.retainedSaves)) return unreadable()
  if (raw.grantRequestText !== undefined && typeof raw.grantRequestText !== 'string') return unreadable()
  const baseline = parseHostRouteResult('route.inspect', raw.baseline) as HostRouteSettings
  if (baseline.identity.runtimeId !== runtimeId) return unreadable()
  return { baseline, configuration: draftConfiguration(raw.configuration), ...(raw.grantRequestText === undefined ? {} : { grantRequestText: raw.grantRequestText }),
    retainedSaves: raw.retainedSaves.map(value => {
      if (!record(value) || (value.notSent !== undefined && value.notSent !== true)) return unreadable()
      const refusal = value.refusal === undefined ? undefined : hostRouteSaveRefusal(value.refusal)
      if (value.refusal !== undefined && !refusal) return unreadable()
      return { input: parseHostRouteParams('route.configure', value.input), ...(value.notSent ? { notSent: true as const } : {}), ...(refusal ? { refusal } : {}) }
    }) }
}
export function putHostRouteDraft(value: unknown, runtimeId: string, edit: HostRouteDraft): unknown {
  if (edit.baseline.identity.runtimeId !== runtimeId) return unreadable()
  return { ...entries(value), [runtimeId]: edit }
}
export function hostRouteDraft(saved: HostRouteSettings): HostRouteDraft {
  return { baseline: saved, configuration: structuredClone({ routes: saved.routes, grants: saved.grants }), retainedSaves: [] }
}
export function hostRouteDraftDirty(edit: HostRouteDraft): boolean {
  return !configValuesEqual(edit.configuration, { routes: edit.baseline.routes, grants: edit.baseline.grants })
}
/** A late ACK acknowledges only its captured input, retaining newer edits and unknown saves. */
export function acknowledgeHostRouteSave(edit: HostRouteDraft, input: HostRouteParams['route.configure'], saved: HostRouteSettings): HostRouteDraft {
  if (!configValuesEqual(saved.identity, edit.baseline.identity) || saved.operation?.operationId !== input.operationId ||
      !configValuesEqual({ routes: saved.routes, grants: saved.grants }, input.configuration)) return unreadable()
  const acceptsBaseline = edit.baseline.revision === input.expectedRevision || edit.baseline.revision === saved.revision
  return { ...edit, baseline: acceptsBaseline ? saved : edit.baseline, configuration: acceptsBaseline && configValuesEqual(edit.configuration, input.configuration)
    ? { routes: saved.routes, grants: saved.grants } : edit.configuration,
    retainedSaves: edit.retainedSaves.filter(original => original.input.operationId !== input.operationId) }
}
