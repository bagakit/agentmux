import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { SpaceMountMethods, SpaceMountRecord } from '../../../shared/space-mount'
import type { MountedSpaceRegion } from '../lib/space-mount-view'
import { api } from '../lib/api'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { ServiceWindowNotice } from './ServiceWindowNotice'

type Report = SpaceMountMethods['open']['result']
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const sameReference = (a: NonNullable<Report['execution']>['reference'], b: NonNullable<Report['execution']>['reference']) =>
  a.bindingId === b.bindingId && a.agentSessionId === b.agentSessionId && a.createOperationId === b.createOperationId

/** A visible reader of one original Source operation. Core retains intent and all effects. */
export function MountedCreationRecovery({ target, member, visible, onRefresh, reference, supplement, sessionIssue, layout = 'surface' }: {
  target: SpaceMountRecord; member: MountedSpaceRegion; visible: boolean; onRefresh?: (() => void) | undefined
  reference: ReactNode; supplement?: ReactNode; sessionIssue?: string | undefined; layout?: 'inline' | 'surface'
}) {
  const original = member.region, operationId = original.creationOperationId!, agentSessionId = original.agentSessionId!
  const key = JSON.stringify([target.hostId, target.reference, member.tab.tabId, original.regionId, operationId, agentSessionId, original.execution])
  const scope = useRef({ key, active: visible, sequence: 0 })
  if (scope.current.key !== key || scope.current.active !== visible) scope.current = { key, active: visible, sequence: 0 }
  const [read, setRead] = useState<{ key: string; report?: Report; error?: string; reading?: boolean }>({ key })
  const [feedback, setFeedback] = useState<{ key: string; message: string } | null>(null)
  const [busy, setBusy] = useState<object | null>(null)
  const inFlight = useRef<object | null>(null), reader = useRef<AbortController | null>(null)
  const current = read.key === key ? read : { key }
  const report = current.report, execution = report?.execution, value = execution?.inspection
  const retired = report?.outcome === 'retired', continuation = retired ? undefined : value?.continuation
  async function inspect() {
    const source = scope.current
    if (!source.active) return
    const sequence = ++source.sequence, abort = new AbortController()
    reader.current?.abort(); reader.current = abort
    const owns = () => scope.current === source && source.active && source.sequence === sequence && !abort.signal.aborted
    setRead(prior => ({ ...(prior.key === key ? prior : { key }), reading: true }))
    try {
      const result = await api.spaceMounts.call('inspect', { hostId: target.hostId, reference: target.reference, requestId: operationId }, abort.signal)
      if (!owns()) return
      const next = result.request?.report
      if (!result.request?.known || result.request.operationId !== operationId || !next || next.operationId !== operationId)
        throw Error('The Source has not returned this original creation. Its identity and draft are kept.')
      const observed = next.execution
      if (next.agent && (next.agent.agentSessionId !== agentSessionId || next.agent.createOperationId !== operationId) || observed && (observed.coordinatorRuntimeId !== target.reference.runtimeId ||
          observed.reference.agentSessionId !== agentSessionId || observed.reference.createOperationId !== operationId ||
          observed.inspection?.continuation && !sameReference(observed.reference, observed.inspection.continuation)))
        throw Error('The observation belongs to another original request. This workface is kept.')
      setRead({ key, report: next })
    } catch (error) {
      if (owns()) setRead(prior => ({ ...(prior.key === key ? prior : { key }), reading: false, error: errorText(error) }))
    }
  }
  useEffect(() => {
    // StrictMode can repeat setup without a render. Give each reader lifetime
    // its own fence so cleanup cannot park the next reader or revive old replies.
    const source = { key, active: visible, sequence: 0 }
    scope.current = source
    if (visible) void inspect()
    return () => { source.active = false; reader.current?.abort() }
  }, [key, visible])
  async function continueOriginal() {
    const source = scope.current
    if (!source.active || inFlight.current === source || !continuation || !execution || !sameReference(execution.reference, continuation)) return
    inFlight.current = source; setBusy(source); setFeedback(null)
    try {
      await api.spaceMounts.call('continueExecution', { hostId: target.hostId, reference: target.reference, execution: continuation })
      if (scope.current !== source || !source.active) return
      setFeedback({ key, message: 'The original creation was confirmed. Reading its Session from the original device.' })
      onRefresh?.(); void inspect()
    } catch (error) {
      if (scope.current === source && source.active) setFeedback({ key, message: `Original continuation is unconfirmed: ${errorText(error)}` })
    } finally {
      if (inFlight.current === source) inFlight.current = null
      setBusy(prior => prior === source ? null : prior)
    }
  }
  const creationIssues = report?.issues.filter(issue => issue.step === 'creation') ?? []
  const observerIssues = report?.issues.filter(issue => issue.step === 'observation') ?? []
  const actions = <>
    {continuation ? <Button type="button" variant="primary" disabled={busy === scope.current} onClick={() => void continueOriginal()}>Continue original request</Button> : null}
    <Button type="button" onClick={() => { void inspect(); onRefresh?.() }}>Check original status</Button>
  </>
  if (layout === 'inline') return <ServiceWindowNotice disclosure={{ scope: key, id: 'original-creation',
    cause: current.error ?? report?.outcome ?? 'creation-unconfirmed', visible }}
    notice={{ kind: 'indeterminate', notice: {
      step: retired ? 'Original Session retired' : report?.agent ? 'Original Agent confirmed; Session observation unconfirmed' : 'Agent creation unconfirmed',
      mode: [retired ? 'The original Core confirmed retirement. No replacement was created.'
        : report?.agent ? 'The Source confirmed this original Agent. Its Session observation has not arrived yet.' : 'The Source retained this original task; its Agent creation is unconfirmed.',
        ...creationIssues.map(issue => issue.message), ...observerIssues.map(issue => issue.message), value?.diagnostic?.message,
        current.error, sessionIssue, feedback?.key === key ? feedback.message : undefined].filter(Boolean).join(' '),
      restore: continuation ? 'Continue uses the retained original request. Your conversation and private draft are kept.'
        : 'Check this same original request. Conversation reading and its original authority remain separate.'
    } }} actions={actions} />
  return <FullPageLoadingSurface scope="region" visible={visible} phase={busy === scope.current ? 'recovering' : current.reading && !report ? 'loading' : 'parked'}
    eyebrow="Original creation" title={busy === scope.current ? 'Continuing the original request' : retired ? 'Original Session retired' : report?.agent ? current.error ? 'Last confirmed original Agent' : 'Original Agent confirmed' : 'Agent creation unconfirmed'}
    description={<>
      <span>{retired ? 'The original Core confirmed that this Session was explicitly retired. Its original task reference and your draft are kept.' : report?.agent ? 'The Source confirmed the original Agent. Its Session observation has not arrived yet.' : 'The Source retained this task, but its original Agent has not been confirmed.'}</span>
      {value ? <p>{current.error ? 'Last confirmed tools' : 'Original tools'}: {value.state === 'connected' ? 'connected' : 'connection unconfirmed'}.{!report?.agent ? ' This does not confirm Agent creation.' : null}</p> : null}
      {value?.helperStarts ? <p>Project helper: {value.helperStarts.executor.outcome === 'confirmed' ? 'start acknowledged' : value.helperStarts.executor.outcome === 'unknown' ? 'start outcome unknown' : 'start not submitted'}. Agent helper: {value.helperStarts.frontend.outcome === 'confirmed' ? 'start acknowledged' : value.helperStarts.frontend.outcome === 'unknown' ? 'start outcome unknown' : 'start not submitted'}.</p> : null}
      {creationIssues.map((issue, index) => <p key={index}>Original creation{issue.executionFailure ? ` · ${issue.executionFailure.stage} on ${issue.executionFailure.hostId}` : ''}: {issue.message}</p>)}
      {value?.diagnostic ? <p>Current tools connection: {value.diagnostic.message}</p> : null}
      {current.error ? <p role="status">Latest observation: {current.error}</p> : null}
      {feedback?.key === key ? <p role="status">{feedback.message}</p> : null}
    </>}
    detail={retired ? 'Retirement is separate from a connection failure. No replacement task has been created.' : continuation ? 'Continue uses the retained original request. Your private draft stays here.' : 'Check the original creation status. Missing startup receipts remain unconfirmed; your task and draft are kept.'}
    actions={actions}
    details={{ summary: 'Original request details', content: <>
      {reference}<dl><div><dt>Original creation</dt><dd><code>{operationId}</code></dd></div></dl>
      {observerIssues.map((issue, index) => <p key={index}>Source observation: {issue.message}</p>)}
      {sessionIssue ? <p>Session observation: {sessionIssue}</p> : null}
    </> }} supplement={supplement} />
}
