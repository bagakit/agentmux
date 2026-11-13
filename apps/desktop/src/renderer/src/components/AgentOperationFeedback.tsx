import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'
import { useAppStore } from '../store'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { agentOperationKey, dismissAgentOperation, inspectAgentOperation, type AgentOperationFeedback as Operation, type AgentOperationSubject } from '../lib/agent-operation-feedback'
import { stopSessionInBackground } from '../lib/session-stop-background'
import { agentOperationsForSubject } from '../lib/agent-operation'

const CheckIcon = semanticIconComponent('action.refresh')
const StopIcon = semanticIconComponent('action.stop')
const titles = { stop: '停止', takeover: '接手', fork: 'Fork' }
function label(operation: Operation) {
  if (operation.phase === 'pending') return `${titles[operation.kind]}中`
  if (operation.phase === 'succeeded') return operation.kind === 'stop' ? '已停止' : '已创建'
  if (operation.phase === 'partial') return `${titles[operation.kind]}部分完成`
  return `${titles[operation.kind]}${operation.phase === 'failed' ? '失败' : '未确认'}`
}

/** Both the real card and Region header read these exact original references. */
export function AgentOperationFeedback({ subject, compact = false }: { subject: AgentOperationSubject; compact?: boolean }) {
  const operations = useAppStore(useShallow(state => agentOperationsForSubject(state.agentOperations, subject)))
  const active = useWorkbenchPresentationActive()
  if (!operations.length) return null
  return <AgentOperationFeedbackBody operations={operations} compact={compact} active={active} />
}

function AgentOperationFeedbackBody({ operations, compact, active }: { operations: Operation[]; compact: boolean; active: boolean }) {
  const { ref, visible } = useVisibleWork<HTMLDivElement>(active)
  const [checking, setChecking] = useState<string | null>(null)
  const decoration = useMemo(() => operations.find(operation => operation.phase === 'pending' && operation.kind === 'stop') ??
    operations.find(operation => operation.phase === 'pending') ?? operations.at(-1)!, [operations])
  // Offscreen completion needs no decorative wait; pending/unknown references always remain.
  useEffect(() => { if (!visible) operations.filter(operation => operation.phase === 'succeeded').forEach(dismissAgentOperation) }, [operations, visible])
  const phase = (decoration.startedAt % 3200) / -1000
  return <div ref={ref} className={`agent-operation-feedback${compact ? ' agent-operation-feedback--compact' : ''}`}
    data-kind={decoration.kind} data-phase={decoration.phase} data-motion-active={visible && decoration.phase === 'pending'}
    style={{ '--operation-phase': `${phase}s` } as CSSProperties} onClick={event => event.stopPropagation()}>
    {!compact ? <div className="agent-operation-feedback__motion" aria-hidden="true">
      <span className="agent-operation-feedback__veil" /><span className="agent-operation-feedback__trail" />
    </div> : null}
    {operations.map(operation => <details className="agent-operation-feedback__item" data-phase={operation.phase} key={agentOperationKey(operation)}>
      <summary className="agent-operation-feedback__label" onAnimationEnd={event => {
        if (event.animationName === 'agent-operation-settle' && operation.phase === 'succeeded') dismissAgentOperation(operation)
      }}><span role="status">{label(operation)}</span></summary>
      <div className="agent-operation-feedback__detail">
        {operation.message ? <p>{operation.message}</p> : null}
        <p><code>{operation.operationId}</code></p>
        {operation.callerOperationIds?.length ? <p>原请求：{operation.callerOperationIds.join(' · ')}</p> : null}
        {operation.report?.agent ? <p>Agent {operation.report.agent.agentSessionId}</p> : null}
        <div className="agent-operation-feedback__actions">
          <button type="button" disabled={checking === agentOperationKey(operation)} onClick={() => {
            setChecking(agentOperationKey(operation))
            void inspectAgentOperation(operation).finally(() => setChecking(null))
          }}><CheckIcon size={12} />核对原操作</button>
          {operation.kind === 'stop' && operation.canContinue && operation.phase !== 'succeeded' ? <button type="button" onClick={() => {
            void stopSessionInBackground({ control: operation.control, operationId: operation.operationId }, { continueOriginal: true })
          }}><StopIcon size={12} />继续同次停止</button> : null}
          {operation.phase === 'succeeded' ? <button type="button" onClick={() => dismissAgentOperation(operation)}>收起</button> : null}
        </div>
      </div>
    </details>)}
  </div>
}
