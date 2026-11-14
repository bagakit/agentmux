import { useSyncExternalStore } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
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
      'Review all goals · Findings and suggested actions', target.displayWorkspaceId && target.groupId ? {
      displayWorkspaceId: target.displayWorkspaceId, groupId: target.groupId, tabId: binding.tabId, regionId: binding.regionId
    } : undefined)
  }
  return <div className="goals-global-patrol" aria-label="Review all goals">
    <div className="goal-patrol__actions">
      <Button type="button" disabled={request?.pending} onClick={() => void requestGlobalGoalPatrol()}>
        {request?.pending ? 'Preparing review…' : request ? 'Check this review' : 'Review all goals'}
      </Button>
      {binding ? <Button type="button" onClick={openCurrent}>Open review discussion</Button> : null}
      {request?.operationId && !request.pending ? <Button type="button" onClick={() => void requestGlobalGoalPatrol(true)}>New review</Button> : null}
    </div>
    {request ? <div className="goals-global-patrol__feedback" role="status">
      {request.report ? <span>{request.report.agent?.initialPrompt === 'confirmed' ? 'Request delivered. Findings and suggested actions return to this discussion.' : 'The original discussion and request are kept. Input receipt is unconfirmed.'}</span> : null}
      {request.issue ? <span>{request.issue}</span> : null}
      {request.report?.issues.map((issue, index) => <span key={index}>{issue.message} {issue.recovery}</span>)}
    </div> : null}
  </div>
}
