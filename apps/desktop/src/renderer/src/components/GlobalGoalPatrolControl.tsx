import { mintObjectId } from '@agentmux/core/object-id'
import { useSyncExternalStore } from 'react'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import { useAppStore } from '../store'
import { requestAgentConversationFloatingOpen } from '../lib/pmo-teams-topic-floating'

const key = 'agentmux.global-goal-patrol.operation.v1'
type Request = { operationId: string; pending: boolean; issue?: string; report?: AgentMuxSpaceMutationReport }
function retainedOperation(): Request | null {
  try {
    const operationId = localStorage.getItem(key)
    return operationId ? { operationId, pending: false } : null
  } catch { return null }
}
// Only a client reference is retained here. The original spatial/Core owners hold all effects.
let current = retainedOperation(), flight: Promise<void> | null = null
const listeners = new Set<() => void>()
const snapshot = () => current
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function publish(value: Request) { current = value; for (const listener of listeners) listener() }
export async function requestGlobalGoalPatrol(fresh = false): Promise<void> {
  if (flight) return flight
  const operationId = !fresh && current ? current.operationId : mintObjectId()
  let preferenceIssue: string | undefined
  try { localStorage.setItem(key, operationId) }
  catch { preferenceIssue = '本机入口引用保存未确认；本次操作仍沿原空间回执保留。' }
  publish({ operationId, pending: true, ...(preferenceIssue ? { issue: preferenceIssue } : {}) })
  flight = Promise.resolve().then(async () => {
    try {
      const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: operationId, operation: 'demand.patrol-all' })
      if (result.operation !== 'demand.patrol-all') throw new Error('The original global inspection returned another operation.')
      publish({ operationId, pending: false, report: result, ...(preferenceIssue ? { issue: preferenceIssue } : {}) })
    } catch (error) { publish({ operationId, pending: false, issue: (error instanceof Error ? error.message : String(error)) + ' 原操作保留；检查本次请求，不会自动重发。' }) }
  }).finally(() => { flight = null })
  return flight
}

export function GlobalGoalPatrolControl() {
  const request = useSyncExternalStore(subscribe, snapshot, snapshot)
  const binding = useAppStore(state => request ? state.spatialRequests[request.operationId] : undefined)
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
      {request && !request.pending ? <button type="button" className="goals-button" onClick={() => void requestGlobalGoalPatrol(true)}>新巡查</button> : null}
    </div>
    {request ? <div className="goals-global-patrol__feedback" role="status">
      {request.report ? <span>{request.report.agent?.initialPrompt === 'confirmed' ? '任务已投递；检查结果与处理建议回到本次对话。' : '原讨论与请求已保留；输入回执尚待确认。'}</span> : null}
      {request.issue ? <span>{request.issue}</span> : null}
      {request.report?.issues.map((issue, index) => <span key={index}>{issue.message} {issue.recovery}</span>)}
    </div> : null}
  </div>
}
