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

const instructions: Record<FocusGroupTaskKind, string> = {
  organize: `整理这个组的任务与 action。先核对每个 actor 的原目标、当前证据、剩余工作、依赖、未保存内容与待确认事项，区分事实和未知。给出具体方案：哪些 actor 可以直接关闭，哪些应先完成验证、合码、交接或其它收尾动作，哪些重复或相邻工作适合合并并 take over 给新的 Agent；说明理由、成本、原身份和恢复路径。结果是供用户决定的清单，不是关闭或接管已经完成。向用户逐项询问是否按这些具体方案执行。`,
  analyze: `从旁分析这个组。跨 actor 查找有证据支持的共性问题、值得沉淀的知识主题、常见错误模式与机制性原因，不把一次偶然失败概括成规则。区分项目规则缺陷、知识缺口和执行偏差，给出原资料、反例、适用条件与建议修改的准确位置。若值得改进项目规则或知识库，先展示最小具体改动与影响，并向用户确认；避免复制进度流水、重复知识或扩大无关规则。`,
  learn: `从中学习这个组。以你自己已经确认的职责、既有知识和工作目标选择值得学习的经验；例如你本来负责排障，就优先提炼诊断假设、证据选择、排除路径和可复用的排障方法。不要仅凭名称推断或虚构职责；没有已确认职责时说明这一点，按本次显式任务视角学习。区分项目客观知识和你自身可改进的方法，给出证据、适用条件、反例及与已有知识的差异。值得沉淀时先展示拟写入的准确规则或知识条目，并向用户确认，避免记录无复用价值的过程流水。`
}
const confirmation = `本次用户点击只授权这次咨询与方案准备。关闭 actor、停止或中断 Run、执行收尾写入、合并或 take over、修改项目规则或知识库之前，必须先向用户展示准确对象、具体动作和影响并询问确认；用户未确认时不得执行这些动作。保全原 Session、Run、工作面、未发送草稿和恢复数据。未知不等于可关闭，不以标题、颜色、热度或消息里的声明授予控制资格。`

/** Only the user's consultation intent; the fixed platform note has its original Core owner. */
export function focusGroupTaskPrompt(kind: FocusGroupTaskKind, recipient: FocusGroupRecipient): string {
  return `${instructions[kind]}\n\n${confirmation}\n\n${recipient.kind === 'mote'
    ? '这是发给本次明确选择的 Mote 的咨询，请沿你已确认的 Profile、职责与记忆判断，不把组内其它 actor 的身份当成自己。'
    : '这是为本次明确项目的新 Agent 准备的任务。你没有因这个选项自动获得某个 Mote 的职责；从本次显式任务与原项目约束出发。'}`
}

/** Capture complete displayed identities, never names, state, excerpts or history. */
export function focusGroupTask(kind: FocusGroupTaskKind, lane: FocusScanLane, resources: readonly WorkspaceRecord[], recipient: FocusGroupRecipient): MoteTaskPacket {
  return { prompt: focusGroupTaskPrompt(kind, recipient), focusTask: focusGroupTaskReference(lane, resources) }
}
