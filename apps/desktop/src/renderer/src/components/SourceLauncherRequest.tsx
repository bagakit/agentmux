import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { MountedAgentOpenInput } from '../lib/space-mount-launch'
import { openSourceLauncherWork } from '../lib/source-launcher-request'
import { OriginalLaunchNames } from './OriginalLaunchNames'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { sourceLaunchDiagnostics } from './source-launch-diagnostics'
import './SourceLauncherRequest.css'

/** Historical request receipts and fresh original-owner reads remain separate. */
export function SourceLauncherRequest({ input, busy, onContinue, active = true }: { input: MountedAgentOpenInput; busy: boolean; active?: boolean; onContinue(input: MountedAgentOpenInput): void }) {
  const key = JSON.stringify([input.target.hostId, input.target.reference, input.slot])
  const scope = useRef({ request: input.request, key, active })
  if (scope.current.request !== input.request || scope.current.key !== key || scope.current.active !== active) scope.current = { request: input.request, key, active }
  const [read, setRead] = useState<{ owner: object; inspection?: AgentMuxRpcResult<'space.inspect'>; issue?: string }>()
  const [copy, setCopy] = useState<{ owner: object; snapshot: string; status: 'writing' | 'copied' | 'failed' }>()
  const reader = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const owner = { request: input.request, key, active }; scope.current = owner
    return () => { owner.active = false; reader.current?.abort() }
  }, [input.request, key, active])
  const current = read?.owner === scope.current ? read : undefined
  const historical = input.receipt?.operationId === input.request.operationId && (!input.receipt.execution || input.receipt.execution.coordinatorRuntimeId === input.target.reference.runtimeId) ? input.receipt : undefined
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
  const snapshot = useMemo(() => JSON.stringify(sourceLaunchDiagnostics(input, historical, observed, Boolean(issue)), null, 2), [input.target, input.request.operationId, historical, observed, Boolean(issue)])
  const originalDetails = useMemo(() => JSON.stringify({ request: input.request, receipt: input.receipt, names: input.origin?.names, ...(input.issue ? { historicalIssue: input.issue } : {}), inspection }, null, 2), [input.request, input.receipt, input.origin?.names, input.issue, inspection])
  const latestSnapshot = useRef(snapshot); latestSnapshot.current = snapshot
  const copyState = copy?.owner === scope.current && copy.snapshot === snapshot ? copy.status : undefined
  async function copyDiagnosis() {
    const owner = scope.current
    if (!owner.active) return
    const value = snapshot
    setCopy({ owner, snapshot: value, status: 'writing' })
    const owns = () => scope.current === owner && owner.active && latestSnapshot.current === value
    const copied = await copyTextToClipboard(value, () => { if (owns()) setCopy({ owner, snapshot: value, status: 'failed' }) })
    if (copied && owns()) setCopy({ owner, snapshot: value, status: 'copied' })
  }
  const cause = currentCreationIssues[0] ?? originalIssues[0], typed = cause?.executionFailure
  const role = typed?.role === 'executor' ? 'Tool helper' : typed?.role === 'frontend' ? 'Agent helper' : 'Agent'
  const stage = typed ? ({ resolve: 'connection', inventory: 'Executor check', prepare: 'preparation', start: 'start', attach: 'attachment', create: 'creation' } as const)[typed.stage] : undefined
  const title = report?.outcome === 'retired' ? 'Agent retired' : report?.agent || report?.outcome === 'opened' ? 'Agent created' : 'Launch not confirmed'
  const reason = issue ? 'Latest check could not be completed. The last confirmed facts are kept.' : terminal || report?.agent ? 'The original work and your newer draft are retained.'
    : typed ? `${role} ${stage} is unconfirmed.` : cause?.message ?? 'The original request is kept.'
  return <section className="launcher-source-original source-launch-feedback" aria-label="Original launch status">
    <div className="source-launch-feedback__top">
      <div className="source-launch-feedback__status"><strong>{title}</strong><p role="status">{reason}</p></div>
      <button type="button" className="small-button source-launch-feedback__copy" disabled={copyState === 'writing'} onClick={() => void copyDiagnosis()}>Copy diagnostics</button>
    </div>
    {copyState ? <p className="source-launch-feedback__copy-status" role="status">{copyState === 'copied' ? 'Diagnostics copied' : copyState === 'writing' ? 'Copying diagnostics…' : 'Could not copy diagnostics. Try again.'}</p> : null}
    <div className="source-launch-feedback__actions">
      {!terminal ? <button type="button" className="small-button source-launch-feedback__primary" disabled={busy} onClick={() => onContinue(input)}>{input.submitted ? 'Continue original task' : 'Send original task'}</button> : null}
      {report?.to ? <button type="button" className={`small-button${terminal ? ' source-launch-feedback__primary' : ''}`} onClick={() => void open()}>Open original work</button> : null}
      <button type="button" className="small-button" onClick={() => void check()}>Check original task</button>
    </div>
    <details className="source-launch-feedback__details">
      <summary>Diagnosis details</summary>
      <div className="source-launch-feedback__detail-body">
        {originalIssues.length ? <div aria-label="Original creation failures"><h4>{report?.agent || terminal ? 'Earlier creation' : 'Original creation'}</h4>
          {originalIssues.map((item, index) => <p key={index}><code>{item.code}</code><span>{item.message}</span>{item.executionFailure ? <small>{item.executionFailure.stage} · {item.executionFailure.role} · {item.executionFailure.hostId}</small> : null}</p>)}
        </div> : null}
        {currentCreationIssues.length ? <div aria-label="Current creation failures"><h4>Current creation</h4>
          {currentCreationIssues.map((item, index) => <p key={index}><code>{item.code}</code><span>{item.message}</span>{item.executionFailure ? <small>{item.executionFailure.stage} · {item.executionFailure.role} · {item.executionFailure.hostId}</small> : null}</p>)}
        </div> : null}
        {observationIssues.length ? <div aria-label="Source observation issues"><h4>{observed ? 'Latest Source observation' : 'Original Source observation'}</h4>
          {observationIssues.map((item, index) => <p key={index}><code>{item.code}</code><span>{item.message}</span></p>)}
        </div> : null}
        {issue ? <div><h4>Latest observation</h4><p>{issue}</p></div> : null}
        <div><h4>Inspect this original task</h4><p>Use the original Source Host and operation with <code>space inspect</code>. This read does not continue or send input.</p><pre>{JSON.stringify(sourceLaunchDiagnostics(input, historical, observed, Boolean(issue)).cli, null, 2)}</pre></div>
        <OriginalLaunchNames owner={{ kind: 'source', input, ...(observed ? { observation: observed } : {}) }} active={active} />
        <div><h4>Original request</h4><p>Private request retained locally. Its body is excluded from Copy diagnostics.</p><pre>{originalDetails}</pre></div>
      </div>
    </details>
  </section>
}
