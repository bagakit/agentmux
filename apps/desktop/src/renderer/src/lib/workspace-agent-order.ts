import type { AgentMuxSpaceControlRequest, AgentMuxSpatialSave, AgentMuxWorkspaceAgentOrderMember, AgentMuxWorkspaceAgentOrderReport } from '@agentmux/core/control'
import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { workspaceAgentSessions } from './surface-tool-dock'

export const EMPTY_WORKSPACE_AGENT_ORDER: readonly string[] = Object.freeze([])
export function workspaceAgentOrderKey(session: { hostId: string; id: string; control?: SessionSnapshot['control'] }): string {
  return session.control?.kind === 'agent' ? JSON.stringify([session.control.hostId, session.control.agentSessionId]) : JSON.stringify([session.hostId, session.id])
}
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
export function orderedWorkspaceAgents<T extends { hostId: string; id: string; createdAt: number }>(sessions: readonly T[], order: readonly string[] = EMPTY_WORKSPACE_AGENT_ORDER): T[] {
  const ranks = new Map(order.map((key, index) => [key, index]))
  const seen = new Set<string>()
  return [...sessions].sort((a, b) => {
    const ak = workspaceAgentOrderKey(a), bk = workspaceAgentOrderKey(b)
    const ar = ranks.get(ak), br = ranks.get(bk)
    if (ar !== br) return ar === undefined ? 1 : br === undefined ? -1 : ar - br
    return a.createdAt - b.createdAt || (ak < bk ? -1 : ak > bk ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  }).filter(session => { const key = workspaceAgentOrderKey(session); if (seen.has(key)) return false; seen.add(key); return true })
}
type State = {
  config: AppConfig | null
  sessions: SessionSnapshot[]
  scratchTopicSnapshots: Record<string, ScratchTopicsSnapshot>
  workspaceAgentOrder: Record<string, string[]>
}
type Ports = {
  get(): State
  set(workspaceId: string, order: string[]): void
  save(): Promise<AgentMuxSpatialSave>
}
type Request = Extract<AgentMuxSpaceControlRequest, { operation: 'space.agent-order' }>
/** The shared GUI/public action reads and writes only the original client preference. */
export async function executeWorkspaceAgentOrder(ports: Ports, request: Request): Promise<AgentMuxWorkspaceAgentOrderReport> {
  const state = ports.get(), displayWorkspaceId = request.displayWorkspaceId
  const before = Object.hasOwn(state.workspaceAgentOrder, displayWorkspaceId) ? state.workspaceAgentOrder[displayWorkspaceId]! : EMPTY_WORKSPACE_AGENT_ORDER
  const workspaces = state.config?.workspaces.filter(value => value.id === displayWorkspaceId) ?? []
  const workspace = workspaces.length === 1 ? workspaces[0] : undefined
  const members = workspace ? workspaceAgentSessions(state.sessions, workspace, scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)) : []
  const references = (keys: readonly string[]) => keys.flatMap(key => { const value = member(key); return value ? [value] : [] })
  const report = (outcome: AgentMuxWorkspaceAgentOrderReport['outcome'], issues: AgentMuxWorkspaceAgentOrderReport['issues'] = [], save: AgentMuxSpatialSave | null = null, stored = before): AgentMuxWorkspaceAgentOrderReport => ({
    scope: 'workspace-agent-list', displayWorkspaceId, storedOrder: references(stored),
    effectiveOrder: references(orderedWorkspaceAgents(members, stored).map(workspaceAgentOrderKey)),
    changed: JSON.stringify(stored) !== JSON.stringify(before), outcome, save, issues
  })
  if (!workspace) return report('unknown', [{ step: 'target', code: 'WORKSPACE_LIST_UNCONFIRMED',
    message: 'The exact original Workspace list scope is not currently confirmed.', recovery: 'Read the original Workspace catalog; its saved preference and all Sessions are retained.' }])
  if (request.order === undefined) return report('read')
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
  const next = requested.length ? [...requested, ...before.filter(key => !available.has(key) && !requested.includes(key))] : []
  ports.set(displayWorkspaceId, next)
  let save: AgentMuxSpatialSave
  try { save = await ports.save() } catch (error) { save = { layoutApplied: false, localStorageWritten: false,
    storageFlushRequested: false, diskDurability: 'unconfirmed', reason: error instanceof Error ? error.message : String(error) } }
  // This preference is in the client batch. A Core topology commit cannot acknowledge
  // Chromium's separate localStorage flush, which returns no filesystem receipt.
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
