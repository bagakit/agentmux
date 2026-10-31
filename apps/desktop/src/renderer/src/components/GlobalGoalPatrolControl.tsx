import { useSyncExternalStore } from 'react'
import { useAppStore } from '../store'
import { requestAgentConversationFloatingOpen } from '../lib/pmo-teams-topic-floating'
import { globalGoalPatrolSnapshot, subscribeGlobalGoalPatrol, requestGlobalGoalPatrol } from '../lib/global-goal-patrol-state'
export { requestGlobalGoalPatrol } from '../lib/global-goal-patrol-state'

export function GlobalGoalPatrolControl() {
  const request = useSyncExternalStore(subscribeGlobalGoalPatrol, globalGoalPatrolSnapshot, globalGoalPatrolSnapshot)
  const binding = useAppStore(state => request?.operationId ? state.spatialRequests[request.operationId] : undefined)
  function openCurrent() {
    if (!binding) return
    const target = binding.target
    requestAgentConversationFloatingOpen(binding.agentSessionId, binding.executionHostId,
      '全局 Demand 巡查 · 检查全部目标并汇总建议；原请求与创建回执保留。', target.displayWorkspaceId && target.groupId ? {
      displayWorkspaceId: target.displayWorkspaceId, groupId: target.groupId, tabId: binding.tabId, regionId: binding.regionId
    } : undefined)
  }
  return <div className="goals-global-patrol" aria-label="全局巡查">
    <div className="goal-patrol__actions">
      <button type="button" className="goals-button" disabled={request?.pending} onClick={() => void requestGlobalGoalPatrol()}>
        {request?.pending ? '正在准备全局巡查…' : request ? '检查本次巡查' : '全局巡查'}
      </button>
      {binding ? <button type="button" className="goals-button" onClick={openCurrent}>打开巡查对话</button> : null}
      {request?.operationId && !request.pending ? <button type="button" className="goals-button" onClick={() => void requestGlobalGoalPatrol(true)}>新巡查</button> : null}
    </div>
    {request ? <div className="goals-global-patrol__feedback" role="status">
      {request.report ? <span>{request.report.agent?.initialPrompt === 'confirmed' ? '任务已投递；检查结果与处理建议回到本次对话。' : '原讨论与请求已保留；输入回执尚待确认。'}</span> : null}
      {request.issue ? <span>{request.issue}</span> : null}
      {request.report?.issues.map((issue, index) => <span key={index}>{issue.message} {issue.recovery}</span>)}
    </div> : null}
  </div>
}
