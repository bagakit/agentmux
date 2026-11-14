import type { AgentMuxSpaceControlRequest, AgentMuxSpatialSave, AgentMuxWorkspaceAgentOrderMember, AgentMuxWorkspaceAgentOrderReport } from '@agentmux/core/control'
import { workspaceAgentListMembers, type WorkspaceAgentScopeState, type WorkspaceAgentExecutionResolver } from './workspace-agent-scope'
import { workspaceAgentOrderKey } from './workspace-agent-key'
import { workspaceAgentGroups, type WorkspaceAgentEntry, type WorkspaceAgentLink } from './workspace-agent-arrangement'
import { api } from './api'
import { readWorkspaceAgentLinks, workspaceAgentOrderEntries } from './workspace-agent-relations'
export { workspaceAgentOrderKey } from './workspace-agent-key'

export const EMPTY_WORKSPACE_AGENT_ORDER: readonly string[] = Object.freeze([])
function member(key: string): AgentMuxWorkspaceAgentOrderMember | null {
  try {
    const parsed: unknown = JSON.parse(key)
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some(value => typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value))) return null
    return { hostId: parsed[0], agentSessionId: parsed[1] }
  } catch { return null }
}
function memberKey(value: AgentMuxWorkspaceAgentOrderMember): string {
  return JSON.stringify([value.hostId, value.agentSessionId])
}
export function restoreWorkspaceAgentOrder(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([scope, keys]) => {
    if (!scope.trim() || !Array.isArray(keys)) return []
    const order = [...new Set(keys.flatMap(key => typeof key === 'string' && member(key) ? [memberKey(member(key)!)] : []))]
    return [[scope, order]]
  }))
}
/** Runtime activity and Run replacement never participate in list order. */
export function orderedWorkspaceAgents<T extends WorkspaceAgentEntry>(sessions: readonly T[], order: readonly string[] = EMPTY_WORKSPACE_AGENT_ORDER, links: readonly WorkspaceAgentLink[] = []): T[] {
  return workspaceAgentGroups(sessions, order, links).flatMap(group => group.members.map(member => member.session))
}

/** A narrowed object reorders only its own slots in the original Workspace preference. */
export function mergeWorkspaceAgentSubsetOrder(
  sessions: readonly { hostId: string; id: string; createdAt: number }[],
  order: readonly string[],
  subset: readonly string[],
  reordered: readonly string[]
): string[] {
  const keys = [...new Set([...order, ...orderedWorkspaceAgents(sessions, order).map(workspaceAgentOrderKey), ...subset])]
  const members = new Set(subset)
  let index = 0
  return keys.map(key => members.has(key) ? reordered[index++]! : key)
}

type State = WorkspaceAgentScopeState & {
  workspaceAgentOrder: Record<string, string[]>
}
type Ports = {
  get(): State
  resolveExecution?: WorkspaceAgentExecutionResolver
  set(workspaceId: string, order: string[]): void
  save(): Promise<AgentMuxSpatialSave>
}
type Request = Extract<AgentMuxSpaceControlRequest, { operation: 'space.agent-order' }>
/** The shared GUI/public action reads and writes only the original client preference. */
export async function executeWorkspaceAgentOrder(ports: Ports, request: Request): Promise<AgentMuxWorkspaceAgentOrderReport> {
  const state = ports.get(), displayWorkspaceId = request.displayWorkspaceId
  let before = Object.hasOwn(state.workspaceAgentOrder, displayWorkspaceId) ? state.workspaceAgentOrder[displayWorkspaceId]! : EMPTY_WORKSPACE_AGENT_ORDER
  const workspaces = state.config?.workspaces.filter(value => value.id === displayWorkspaceId) ?? []
  const workspace = workspaces.length === 1 ? workspaces[0] : undefined
  let members: readonly WorkspaceAgentEntry[] = workspace ? workspaceAgentListMembers(state, workspace, ports.resolveExecution) : []
  const observations: AgentMuxWorkspaceAgentOrderReport['issues'] = []
  let sources: Parameters<typeof workspaceAgentOrderEntries>[2] | undefined
  const known = new Set([...before, ...members.map(workspaceAgentOrderKey)])
  // A manual write uses exact known members and derivations, never communication weights.
  const needsHistory = request.order === undefined || request.order.some(value => !known.has(memberKey(value)))
  if (workspace && needsHistory) {
    try {
      const observation = await api.sessions.historySources({ observation: true })
      sources = observation.sources
      members = workspaceAgentOrderEntries({ ...state, workbenchSpaceSelection: null }, workspace, sources, ports.resolveExecution)
      if (observation.warnings.length) observations.push({ step: 'observation', code: 'AGENT_ORDER_HISTORY_UNCONFIRMED', message: observation.warnings.map(warning => warning.message).join(' · '), recovery: 'Refresh the original Host sources. Confirmed members and the stored order remain available.' })
    } catch (error) { observations.push({ step: 'observation', code: 'AGENT_ORDER_HISTORY_UNCONFIRMED', message: error instanceof Error ? error.message : String(error), recovery: 'Refresh the original Host sources. Confirmed members and the stored order remain available.' }) }
  }
  let links: readonly WorkspaceAgentLink[] = []
  if (request.order === undefined) {
    const communication = await readWorkspaceAgentLinks(members)
    links = communication.links
    if (communication.incomplete) observations.push({ step: 'observation', code: 'AGENT_ORDER_RELATIONS_UNCONFIRMED', message: 'Communication proximity is partially observed; the effective order uses confirmed relationships only.', recovery: 'Read this exact order again to refresh relationships. Stored preferences and Agent actions remain available.' })
  }
  const references = (keys: readonly string[]) => keys.flatMap(key => { const value = member(key); return value ? [value] : [] })
  const report = (outcome: AgentMuxWorkspaceAgentOrderReport['outcome'], issues: AgentMuxWorkspaceAgentOrderReport['issues'] = [], save: AgentMuxSpatialSave | null = null, stored = before): AgentMuxWorkspaceAgentOrderReport => {
    const groups = workspaceAgentGroups(members, stored, links), pinned = new Set(stored)
    return { scope: 'workspace-agent-list', displayWorkspaceId, storedOrder: references(stored),
    effectiveOrder: references(groups.flatMap(group => group.members.map(({ session }) => workspaceAgentOrderKey(session)))),
    changed: JSON.stringify(stored) !== JSON.stringify(before), outcome, save, issues: [...issues, ...observations,
      ...(request.order !== undefined && groups.some(group => !group.members.some(({ session }) => pinned.has(workspaceAgentOrderKey(session)))) ? [{
        step: 'observation', code: 'AGENT_ORDER_RELATIONS_UNCONFIRMED', message: 'This manual write did not read communication weights for remaining automatic groups.',
        recovery: 'Read this exact order to observe automatic proximity. The current stored manual order is retained.' }] : [])] }
  }
  if (!workspace) return report('unknown', [{ step: 'target', code: 'WORKSPACE_LIST_UNCONFIRMED',
    message: 'The exact original Workspace list scope is not currently confirmed.', recovery: 'Read the original Workspace catalog; its saved preference and all Sessions are retained.' }])
  if (request.order === undefined) return report('read')
  const current = ports.get(), currentOrder = current.workspaceAgentOrder[displayWorkspaceId] ?? EMPTY_WORKSPACE_AGENT_ORDER
  if (JSON.stringify(currentOrder) !== JSON.stringify(before)) {
    before = currentOrder
    return report('refused', [{ step: 'target', code: 'AGENT_ORDER_CONFLICT', message: 'The original Workspace Agent order changed while its relationships were being read.',
      recovery: 'Read this exact Workspace order before applying another edit. The newer preference is kept.' }])
  }
  if (!current.config?.workspaces.some(value => value.id === workspace.id && value.hostId === workspace.hostId && value.path === workspace.path))
    return report('unknown', [{ step: 'target', code: 'WORKSPACE_LIST_UNCONFIRMED', message: 'The original Workspace scope changed during observation.', recovery: 'Read its original scope again. No order was changed.' }])
  members = sources ? workspaceAgentOrderEntries({ ...current, workbenchSpaceSelection: null }, workspace, sources, ports.resolveExecution)
    : workspaceAgentListMembers(current, workspace, ports.resolveExecution)
  if (request.expectedOrder && JSON.stringify(request.expectedOrder.map(memberKey)) !== JSON.stringify(before)) return report('refused', [{
    step: 'target', code: 'AGENT_ORDER_CONFLICT', message: 'The original Workspace Agent order changed after it was read.', recovery: 'Read this exact Workspace order and review the current preference before changing it.' }])
  const available = new Set(members.map(workspaceAgentOrderKey)), retained = new Set(before)
  const requested = request.order.map(memberKey)
  if (new Set(requested).size !== requested.length) return report('refused', [{ step: 'target', code: 'AGENT_ORDER_DUPLICATE_MEMBER',
    message: 'One original Host/Session appears more than once in the requested order.', recovery: 'Read this exact Workspace order and provide each original member once.' }])
  if (requested.some(key => !available.has(key) && !retained.has(key))) return report('refused', [{ step: 'target', code: 'AGENT_ORDER_MEMBER_UNCONFIRMED',
    message: 'An ordered Host/Session member is not confirmed in this exact Workspace list or its original saved preference.',
    recovery: 'Read this Workspace order and its original Sessions. No Agent or other Workspace preference was changed.' }])
  // Temporarily absent originals survive a normal reorder. [] explicitly resets the whole preference.
  const groupByMember = new Map(workspaceAgentGroups(members, requested).flatMap(group => group.members.map(({ session }) => [workspaceAgentOrderKey(session), group] as const)))
  const emitted = new Set<string>()
  const grouped = requested.flatMap(key => {
    const group = groupByMember.get(key)
    if (!group) return [key]
    if (emitted.has(group.key)) return []
    emitted.add(group.key); return group.members.map(({ session }) => workspaceAgentOrderKey(session))
  })
  const next = requested.length ? [...grouped, ...before.filter(key => !available.has(key) && !requested.includes(key))] : []
  ports.set(displayWorkspaceId, next)
  let save: AgentMuxSpatialSave
  try { save = await ports.save() } catch (error) { save = { layoutApplied: false, clientStateWritten: false,
    storageFlushRequested: false, diskDurability: 'unconfirmed', reason: error instanceof Error ? error.message : String(error) } }
  // This preference is in the client batch. A Core topology commit cannot acknowledge
  // the client user-document writer and its exact native receipt.
  save = { ...save, diskDurability: 'unconfirmed' }
  const issues = save.reason ? [{ step: 'save', code: 'AGENT_ORDER_SAVE_UNCONFIRMED', message: save.reason,
    recovery: 'The applied preference is retained. Inspect this exact Workspace before another change.' }] : []
  return report(issues.length ? 'partial' : JSON.stringify(next) === JSON.stringify(before) ? 'unchanged' : 'changed', issues, save, next)
}

/** The UI uses opaque original Host/Session keys; the public wire returns explicit identities. */
export function workspaceAgentOrderMembers(keys: readonly string[]): AgentMuxWorkspaceAgentOrderMember[] {
  return keys.map(key => {
    const value = member(key)
    if (!value) throw new Error('Agent ordering requires an exact original Host/Session key.')
    return value
  })
}
