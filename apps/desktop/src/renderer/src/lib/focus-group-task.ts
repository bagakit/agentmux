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

const instructions = {
  organize: '整理这组工作，给我一份可以逐项决定的清单。建议哪些继续、哪些先收尾、哪些可以合并或接手、哪些可以关闭。每项写明对象、依据和影响。证据不足的列为待核。',
  analyze: '从这组工作中找反复出现的问题。每项给出具体例子、可能原因和建议改法。涉及项目规则或知识库时，指出值得改的具体条目和适用范围。'
}

export function focusGroupTaskPrompt(kind: FocusGroupTaskKind, recipient: FocusGroupRecipient): string {
  if (kind !== 'learn') return instructions[kind]
  const opening = recipient.kind === 'mote'
    ? '从这组工作中提炼与你职责相关、下次还能用的方法。'
    : '从这组工作中提炼对本项目后续工作有用的方法。'
  return opening + '每条写清什么情况下适用、具体怎么做、依据是什么，以及什么时候会失效。值得保留的就写成可审阅的知识条目草稿。'
}

/** Capture complete displayed identities, never names, state, excerpts or history. */
export function focusGroupTask(kind: FocusGroupTaskKind, lane: FocusScanLane, resources: readonly WorkspaceRecord[], recipient: FocusGroupRecipient): MoteTaskPacket {
  return { prompt: focusGroupTaskPrompt(kind, recipient), focusTask: focusGroupTaskReference(lane, resources) }
}
