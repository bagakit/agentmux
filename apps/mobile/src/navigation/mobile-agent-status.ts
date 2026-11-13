import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'

export type MobileAgentPresentation = NonNullable<AgentMuxSpaceCatalog['agentPresentation']>[number]
/** Display density only. This never qualifies input, recovery, or Runtime health. */
export function ordinaryUnknownAgentStatus(presentation: MobileAgentPresentation | undefined, hasRequest = false): boolean {
  if (hasRequest || presentation?.group === 'attention' || presentation?.stateMark === 'attention' || presentation?.stateMark === 'error' ||
    presentation?.state === 'error' || presentation?.state === 'waiting' || presentation?.state === 'blocked') return false
  if (presentation?.group === 'working' || presentation?.group === 'results' || presentation?.stateMark === 'working' ||
    presentation?.stateMark === 'results' || presentation?.stateMark === 'interrupted' || presentation?.stateMark === 'recovery' ||
    presentation?.state === 'working' || presentation?.state === 'starting' || presentation?.state === 'exited') return false
  return !presentation || presentation.stateMark === 'unknown' || presentation.presenceUnknown === true ||
    presentation.state === 'unknown' || presentation.state === 'running' && !presentation.stateMark
}

const MARK_LABELS: Readonly<Record<NonNullable<MobileAgentPresentation['stateMark']>, string>> = {
  error: '出错', attention: '需要你', working: '执行中', results: '有新结果', unknown: '状态未确认',
  interrupted: '已中断', recovery: '可恢复', idle: '空闲'
}
const STATE_LABELS: Readonly<Record<string, string>> = {
  working: '执行中', waiting: '等待输入', blocked: '需要处理', done: '已完成', error: '出错', exited: '已结束',
  starting: '启动中', running: '状态未确认', disconnected: '断开'
}

/**
 * The phone's own words for a row's state, from the typed mark and state. The shared presentation
 * label is written for Desktop; it stays readable in the status details, never in the row.
 */
export function mobileAgentStateLabel(presentation: MobileAgentPresentation | undefined): string {
  if (!presentation) return '状态未确认'
  if (presentation.state === 'waiting' || presentation.state === 'blocked') return STATE_LABELS[presentation.state]!
  if (presentation.state === 'done' && presentation.stateMark !== 'results') return STATE_LABELS.done!
  return presentation.stateMark ? MARK_LABELS[presentation.stateMark] : STATE_LABELS[presentation.state] ?? '状态未确认'
}
