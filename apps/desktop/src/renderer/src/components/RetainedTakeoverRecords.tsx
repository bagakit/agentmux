import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@agentmux/client-ui/components/Button'
import { ContentCopyButton } from '@agentmux/client-ui/components/ContentCopyButton'
import { agentOperationsForSubject, isRetainedTakeoverRecord, type AgentOperationFeedback, type AgentOperationSubject } from '../lib/agent-operation'
import { agentOperationKey, inspectAgentOperation } from '../lib/agent-operation-feedback'
import { useAppStore } from '../store'

type Takeover = Extract<AgentOperationFeedback, { kind: 'takeover' }>

export function RetainedTakeoverRecords({ subject }: { subject: AgentOperationSubject }) {
  const records = useAppStore(useShallow(state => agentOperationsForSubject(state.agentOperations, subject)
    .filter((operation): operation is Takeover => operation.kind === 'takeover' && isRetainedTakeoverRecord(operation))))
  if (!records.length) return null
  return <details>
    <summary>旧接手记录</summary>
    <ul>{records.map(operation => <TakeoverRecord key={agentOperationKey(operation)} operation={operation} />)}</ul>
  </details>
}

function TakeoverRecord({ operation }: { operation: Takeover }) {
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)
  const failure = useAppStore(state => state.spatialRequests[operation.operationId]?.originalFailure)
  const report = operation.report?.requestId === operation.operationId ? operation.report : undefined
  const issues = report?.issues ?? []
  const originalFailure = failure ?? issues.find(issue => issue.step === 'original-target' && issue.code === 'SPACE_INTENT_SAVE_FAILED')
  const unsaved = originalFailure?.code === 'SPACE_INTENT_SAVE_FAILED' && !report?.agent && !report?.to
  const status = report?.agent && report.outcome === 'retired' ? '接手 Agent 已关闭'
    : report?.agent && (report.outcome === 'opened' || report.outcome === 'partial') ? '接手 Agent 已创建'
      : unsaved ? '接手未提交' : '接手结果待核对'
  const checks = issues.filter(issue => !(originalFailure && issue.step.startsWith('original-') && issue.code === originalFailure.code) &&
    !(unsaved && issue.code === 'SPACE_PLACEMENT_UNKNOWN'))
  const note = operation.message !== issues.map(issue => issue.message).join('\n') ? operation.message : undefined
  return <li>
    <p className="agent-information-takeovers__heading"><strong role="status">{checking ? '正在检查接手结果…' : status}</strong></p>
    {unsaved ? <p>原请求在提交前保存失败。</p> : null}
    <div className="agent-operation-feedback__actions">
      <Button type="button" aria-busy={checking} disabled={checking} onClick={() => {
        setChecking(true)
        void inspectAgentOperation(operation).finally(() => { setChecked(true); setChecking(false) })
      }}>检查结果</Button>
    </div>
    {checked && !checking && !report?.agent ? <p role="status">本次检查未能确认创建结果。</p> : null}
    <details className="agent-operation-feedback__technical">
      <summary>技术信息</summary>
      {originalFailure ? <p>原操作：{originalFailure.message}</p> : null}
      {checks.map((issue, index) => <p key={`${issue.step}:${issue.code}:${index}`}>{issue.message}</p>)}
      {note ? <p>{note}</p> : null}
      <div className="agent-operation-feedback__reference"><code>{operation.operationId}</code>
        <ContentCopyButton text={operation.operationId} identity={agentOperationKey(operation)} label="复制原操作编号" actionLabel="复制" />
      </div>
    </details>
  </li>
}
