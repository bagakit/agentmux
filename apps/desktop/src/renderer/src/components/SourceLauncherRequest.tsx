import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { MountedAgentOpenInput } from '../lib/space-mount-launch'
import { openSourceLauncherWork } from '../lib/source-launcher-request'
import { OriginalLaunchNames } from './OriginalLaunchNames'

/** Historical request receipts and fresh original-owner reads remain separate. */
export function SourceLauncherRequest({ input, busy, onContinue, active = true }: { input: MountedAgentOpenInput; busy: boolean; active?: boolean; onContinue(input: MountedAgentOpenInput): void }) {
  const key = JSON.stringify([input.target.hostId, input.target.reference, input.slot])
  const scope = useRef({ request: input.request, key, active })
  if (scope.current.request !== input.request || scope.current.key !== key || scope.current.active !== active) scope.current = { request: input.request, key, active }
  const [read, setRead] = useState<{ owner: object; inspection?: AgentMuxRpcResult<'space.inspect'>; issue?: string }>()
  const reader = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const owner = { request: input.request, key, active }; scope.current = owner
    return () => { owner.active = false; reader.current?.abort() }
  }, [input.request, key, active])
  const current = read?.owner === scope.current ? read : undefined
  const historical = input.receipt?.operationId === input.request.operationId ? input.receipt : undefined
  async function check() {
    const owner = scope.current
    if (!owner.active) return
    reader.current?.abort(); const controller = new AbortController(); reader.current = controller
    const owns = () => scope.current === owner && owner.active && !controller.signal.aborted
    try {
      const reply = await api.spaceMounts.call('inspect', { hostId: input.target.hostId, reference: input.target.reference, requestId: input.request.operationId }, controller.signal)
      if (!owns()) return
      const next = reply.request?.report, operationId = input.request.operationId
      if (!reply.request?.known || reply.request.operationId !== operationId || !next || next.operationId !== operationId)
        throw Error('The Source has not confirmed this original request. Its receipt and input are kept.')
      const sessionId = historical?.agent?.agentSessionId ?? historical?.execution?.reference.agentSessionId
      if (next.agent && (next.agent.createOperationId !== operationId || sessionId && next.agent.agentSessionId !== sessionId) ||
          next.execution && (next.execution.coordinatorRuntimeId !== input.target.reference.runtimeId || next.execution.reference.createOperationId !== operationId ||
            sessionId && next.execution.reference.agentSessionId !== sessionId))
        throw Error('The observation belongs to another original request. This receipt and input are kept.')
      setRead({ owner, inspection: reply })
    } catch (cause) { if (owns()) setRead(prior => ({ ...(prior?.owner === owner ? prior : {}), owner, issue: presentError(cause) })) }
  }
  const inspection = current?.inspection, issue = current?.issue
  const observed = inspection?.request?.known && inspection.request.report?.operationId === input.request.operationId ? inspection.request.report : undefined
  const report = observed ?? historical, terminal = report?.outcome === 'opened' || report?.outcome === 'retired'
  const originalIssues = historical?.issues.filter(item => item.step === 'creation') ?? []
  const currentCreationIssues = observed?.issues.filter(item => item.step === 'creation' && !originalIssues.some(original =>
    original.code === item.code && original.message === item.message && JSON.stringify(original.executionFailure) === JSON.stringify(item.executionFailure))) ?? []
  const observationIssues = report?.issues.filter(item => item.step !== 'creation') ?? []
  async function open() {
    if (!report) return
    const owner = scope.current
    try { await openSourceLauncherWork(input, report) }
    catch (cause) { if (scope.current === owner && owner.active) setRead(prior => ({ ...(prior?.owner === owner ? prior : {}), owner, issue: presentError(cause) })) }
  }
  return <div className="launcher-source-original">
    <p role="status">{report?.outcome === 'retired' ? 'The original Agent was retired. Its request and your input are retained.' : report?.agent || report?.outcome === 'opened'
      ? 'The project device confirmed this Agent. Your Launcher draft remains here.' : input.issue ?? 'This original task is retained. Check its project device.'}</p>
    {originalIssues.length ? <div className="agent-work-setup__error" role="status" aria-label="Original creation failures"><strong>{report?.agent || terminal ? 'Earlier creation' : 'Original creation'}</strong>
      {originalIssues.map((item, index) => <p key={index}><code>{item.code}</code>: {item.message}{item.executionFailure ? <small> · {item.executionFailure.stage} · {item.executionFailure.role} · {item.executionFailure.hostId}</small> : null}</p>)}
    </div> : null}
    {currentCreationIssues.length ? <div className="agent-work-setup__error" role="status" aria-label="Current creation failures"><strong>Current creation</strong>
      {currentCreationIssues.map((item, index) => <p key={index}><code>{item.code}</code>: {item.message}{item.executionFailure ? <small> · {item.executionFailure.stage} · {item.executionFailure.role} · {item.executionFailure.hostId}</small> : null}</p>)}
    </div> : null}
    {observationIssues.length ? <div role="status" aria-label="Source observation issues"><strong>{observed ? 'Latest Source observation' : 'Original Source observation'}</strong>
      {observationIssues.map((item, index) => <p key={index}><code>{item.code}</code>: {item.message}</p>)}
    </div> : null}
    <div className="agent-work-setup__actions"><div>
      <button type="button" className="small-button" onClick={() => void check()}>Check original task</button>
      {!terminal ? <button type="button" className="small-button" disabled={busy} onClick={() => onContinue(input)}>{input.submitted ? 'Continue original task' : 'Send original task'}</button> : null}
      {report?.to ? <button type="button" className="small-button" onClick={() => void open()}>Open original work</button> : null}
    </div></div>
    {issue ? <p className="agent-work-setup__error" role="status">Latest observation: {issue}</p> : null}
    <OriginalLaunchNames owner={{ kind: 'source', input, ...(observed ? { observation: observed } : {}) }} active={active} />
    <details><summary>Original request</summary><p>Continuing uses this same operation and frozen target. Checking does not replay its first input.</p><pre style={{ maxHeight: '35vh', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ request: input.request,
      receipt: input.receipt, names: input.origin?.names, ...(input.issue ? { historicalIssue: input.issue } : {}), inspection }, null, 2)}</pre></details>
  </div>
}
