import type { AgentMuxMotePresentation, AgentMuxSpaceAddress } from '@agentmux/core/control'
import type { MobileObjectIdentity } from '../navigation/MobileIdentity'
import type { MobilePrimaryWorkface } from '../navigation/home-preference'

/** Display references only: original content, appearance and Runtime facts stay with their owners. */
export type MobileObjectReference = { name: string; project: string; context?: AgentMuxSpaceAddress;
  mote?: { spaceId: string; name?: string; conversationName?: string; contentReference?: AgentMuxMotePresentation['content'] } }
export type MobilePresentationRoute = {
  primary: MobilePrimaryWorkface | 'survey'; showSession: boolean; showGoalWork: boolean
  identity: MobileObjectReference | null
  profile: { identity: MobileObjectReference; sourcePath: string | null } | null
  goals?: MobileGoalsContext
}
export type MobileGoalsContext = { goalId: string | null; mode: 'detail' | 'edit';
  discussion: { goalId: string; tabId: string; agentSessionId: string | null } | null }
const sourcePaths = ['MOTE.md', 'BEHAVIOR.md', 'SOUL.md', 'topic.md']
function invalid(): never { throw new Error('设备原工作面引用无法完整核实；原记录保留。') }
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const v = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(v, key)) || Object.keys(v).some(key => !required.includes(key) && !optional.includes(key))) return invalid()
  return v
}
function text(value: unknown, max = 4096): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function parseIdentity(value: unknown): MobileObjectReference {
  const v = object(value, ['name', 'project'], ['context', 'mote'])
  if (!text(v.name) || typeof v.project !== 'string' || v.project.length > 4096) invalid()
  if (v.context !== undefined) {
    const c = object(v.context, ['spaceId', 'zoneId', 'workspaceId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'])
    for (const key of ['spaceId', 'zoneId']) if (c[key] !== null && !text(c[key], 256)) invalid()
    for (const key of ['workspaceId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId']) if (!text(c[key], 256)) invalid()
  }
  if (v.mote !== undefined) {
    const m = object(v.mote, ['spaceId'], ['name', 'conversationName', 'contentReference'])
    if (!text(m.spaceId, 256)) invalid()
    for (const key of ['name', 'conversationName']) if (m[key] !== undefined && !text(m[key])) invalid()
    if (m.contentReference !== undefined && m.contentReference !== null) {
      const c = object(m.contentReference, ['zoneId', 'hostId', 'workspaceId', 'workspacePath'])
      for (const key of ['zoneId', 'hostId', 'workspaceId']) if (!text(c[key], 256)) invalid()
      if (!text(c.workspacePath)) invalid()
    }
  }
  return structuredClone(value) as MobileObjectReference
}
export function retainObjectReference(identity: MobileObjectIdentity | null): MobileObjectReference | null {
  if (!identity) return null
  const m = identity.mote
  const content = m?.contentReference ?? m?.facts?.content
  const c = identity.context
  return { name: identity.name, project: identity.project,
    ...(c ? { context: { spaceId: c.spaceId, zoneId: c.zoneId, workspaceId: c.workspaceId, displayWorkspaceId: c.displayWorkspaceId,
      groupId: c.groupId, tabId: c.tabId, regionId: c.regionId } } : {}),
    ...(m ? { mote: { spaceId: m.spaceId, ...(m.name ? { name: m.name } : {}),
      ...(m.conversationName ? { conversationName: m.conversationName } : {}),
      ...(content ? { contentReference: content } : {}) } } : {}) }
}
export function parsePresentationRoute(value: unknown): MobilePresentationRoute {
  const v = object(value, ['primary', 'showSession', 'showGoalWork', 'identity', 'profile'], ['goals'])
  if (!['goals', 'topics', 'mote', 'focus', 'space', 'survey'].includes(String(v.primary)) ||
    typeof v.showSession !== 'boolean' || typeof v.showGoalWork !== 'boolean' || v.showGoalWork && !v.showSession) invalid()
  if (v.identity !== null) parseIdentity(v.identity)
  if (v.profile !== null) {
    const p = object(v.profile, ['identity', 'sourcePath'])
    parseIdentity(p.identity)
    if (p.sourcePath !== null && !sourcePaths.includes(String(p.sourcePath))) invalid()
  }
  if (v.goals !== undefined) {
    const goals = object(v.goals, ['goalId', 'mode', 'discussion'])
    if (!(goals.goalId === null || text(goals.goalId, 256)) || !['detail', 'edit'].includes(String(goals.mode))
      || goals.goalId === null && (goals.mode !== 'detail' || goals.discussion !== null)) invalid()
    if (goals.discussion !== null) {
      const discussion = object(goals.discussion, ['goalId', 'tabId', 'agentSessionId'])
      if (discussion.goalId !== goals.goalId || !text(discussion.tabId, 256)
        || !(discussion.agentSessionId === null || text(discussion.agentSessionId, 256))) invalid()
    }
  }
  return structuredClone(value) as MobilePresentationRoute
}
