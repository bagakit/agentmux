import { getAmuxProtocolTemplate, renderAmuxProtocol } from '@agentmux/core/amux-protocol'
import type { WorkspaceRecord } from '../../../shared/contracts'
import type { FocusScanLane } from './focus-collection-lanes'
import { focusGroupTaskReference, focusGroupReadScope } from './focus-group-reference'
import type { MoteTaskPacket } from './mote-task-packet'

export type FocusGroupTaskKind = 'organize' | 'analyze' | 'learn'
export const FOCUS_GROUP_TASKS = [
  { id: 'organize', label: '整理任务', description: '盘点 action，提出关闭、收尾与接管方案' },
  { id: 'analyze', label: '从旁分析', description: '找共性问题、知识主题与反复出现的错误' },
  { id: 'learn', label: '从中学习', description: '从自己的职责视角提炼可复用经验' }
] as const satisfies readonly { id: FocusGroupTaskKind; label: string; description: string }[]
export type FocusGroupRecipient = { kind: 'mote'; topicId: string } | { kind: 'new-agent'; targetKey: string }
export const focusGroupProjectKey = (project: Pick<WorkspaceRecord, 'hostId' | 'id' | 'path'>) => JSON.stringify([project.hostId, project.id, project.path])
/** Frozen public scope and displayed identities, independent of labels or card state. */
export function focusGroupTaskScopeKey(lane: FocusScanLane, resources: readonly WorkspaceRecord[]): string {
  return JSON.stringify([focusGroupReadScope(lane, resources) ?? ['unconfirmed-group', lane.hostId, lane.id],
    lane.contextRefs.map(ref => [ref.hostId, ref.id]).sort()])
}

export function focusGroupTaskPrompt(kind: FocusGroupTaskKind, recipient: FocusGroupRecipient): string {
  if (kind !== 'learn') return getAmuxProtocolTemplate('focus-task', kind)
  const perspective = getAmuxProtocolTemplate('focus-task', recipient.kind === 'mote' ? 'mote-perspective' : 'project-perspective')
  return renderAmuxProtocol('focus-task', 'learn', { perspective })
}

/** Capture complete displayed identities, never names, state, excerpts or history. */
export function focusGroupTask(kind: FocusGroupTaskKind, lane: FocusScanLane, resources: readonly WorkspaceRecord[], recipient: FocusGroupRecipient): MoteTaskPacket {
  return { prompt: focusGroupTaskPrompt(kind, recipient), focusTask: focusGroupTaskReference(lane, resources) }
}
