import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ConnectionDelivery, ConnectionRecord, RoomBinding } from '@agentmux/core/connections'
import type { AgentInputSubmissionReceipt } from '@agentmux/core'
import { api } from '../lib/api'
import { deliveryFacts, deliveryMatches, formatGroupDiagnosis, groupTarget, readGroupDiagnosis, retainGroupDiagnosis, type GroupDiagnosis, type GroupWindow } from '../lib/group-diagnosis'

import { connectorDiagnosisKey, useConnectorGroupDiagnosis, type CheckedGroupDiagnosis } from '../lib/use-connector-group-diagnosis'
import { connectorGroupSummary, type ConnectorProblemAction, type ConnectorProblemActions } from '../lib/connector-group-status'
import { connectorDeliveryExplanation, connectorGapExplanation, connectorIntakeExplanation, connectorSourceExplanation } from '../lib/connector-diagnosis-explanation'
import { ConnectorTrafficSummary } from './ConnectorTrafficSummary'
import { ConnectorReceiverControl } from './ConnectorReceiverControl'
import { ConnectorDeliveryRetryControl } from './ConnectorDeliveryRetryControl'
import { OriginalInputWaitingControl } from './OriginalInputWaitingControl'

const LoadingIcon = semanticIconComponent('status.loading')
const receiptTitle = (kind: string) => kind === 'binding-notice' ? 'Connection notice' : kind === 'permission' ? 'Permission request' : kind === 'query-feedback' ? 'Message status update' : 'Conversation message'
/** Bounded original incoming/outgoing observations. Reading or copying never retries an effect. */
export function ConnectorDeliveryDetails({ binding, connection, hostingTarget, onMembers, actions, details, active = true, showConfiguration = true, observation, incomingControl, selectedProblem }: { binding: RoomBinding; connection?: ConnectionRecord | undefined; hostingTarget?: ConnectionHostingTarget | null; onMembers?: () => void; actions?: ConnectorProblemActions; active?: boolean; details?: ReactNode; showConfiguration?: boolean
  observation?: { snapshot: CheckedGroupDiagnosis | undefined; check(): void }; incomingControl?: ReactNode; selectedProblem?: { target: string; action: ConnectorProblemAction } | null }) {
  const own = useConnectorGroupDiagnosis([binding], 0, active && !observation, null, hostingTarget, [binding])
  const checked = observation ? observation.snapshot : own.entries[connectorDiagnosisKey(binding)]
  const latest = { check: observation?.check ?? own.check }
  const target = groupTarget(binding), key = JSON.stringify([target, hostingTarget]), originalSource = api.connections.call
  const source: typeof api.connections.call = useMemo(() => (method, params) => {
    if (hostingTarget === null) return Promise.reject(new Error('The original bot hosting owner is unconfirmed.'))
    return originalSource(method, params, hostingTarget)
  }, [originalSource, key])
  const current = useRef({ key, source }), live = useRef(false), epoch = useRef(0), exportRead = useRef(0)
  current.current = { key, source }
  const [read, setRead] = useState<{ key: string; value: GroupDiagnosis; checkedAt: number } | null>(null), [pending, setPending] = useState(false), [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<{ key: string; request: number; value: ConnectionDelivery | null; issue: boolean } | null>(null)
  const [input, setInput] = useState<{ key: string; ingressId: string; receipt: AgentInputSubmissionReceipt | null; issue: boolean } | null>(null)
  const [copying, setCopying] = useState(false), [feedback, setFeedback] = useState('')
  const originalSections = useRef<Record<'incoming' | 'receipts' | 'content', HTMLElement | null>>({ incoming: null, receipts: null, content: null })
  const reveal = useRef<'incoming' | 'receipts' | 'content' | null>(null)
  const visible = read?.key === key ? read.value : checked?.report ?? null
  const original = detail?.key === key ? detail : null
  const selectedReceipt = useRef<HTMLDivElement | null>(null)
  useEffect(() => { if (active && original?.value) { selectedReceipt.current?.scrollIntoView({ block: 'start' }); selectedReceipt.current?.focus({ preventScroll: true }) } }, [original?.request])
  const accepts = () => live.current && current.current.key === key && current.current.source === source && api.connections.call === originalSource
  function focusOriginal(section: 'incoming' | 'receipts' | 'content') {
    if (!active) return
    const node = originalSections.current[section]
    node?.scrollIntoView({ block: 'nearest' }); node?.focus({ preventScroll: true })
  }
  function showOriginal(section: 'incoming' | 'receipts' | 'content') {
    if (expanded) focusOriginal(section)
    else { reveal.current = section; setExpanded(true) }
  }
  function openProblem(action: ConnectorProblemAction) {
    const report = checked?.report
    if (action.kind === 'source') { latest.check(); return }
    if (!report) return
    // An explicit summary click selects that observed window, never a guessed row.
    setRead({ key, value: report, checkedAt: checked?.checkedAt ?? Date.now() })
    if (action.kind === 'earlier-receipts') { showOriginal('receipts'); void inspect({ ...report.window, after: action.after }); return }
    if (action.kind === 'receipts') {
      showOriginal('receipts')
      if (action.operationId && report.outgoing.value?.deliveries.some(row => row.operationId === action.operationId)) void inspectOriginal(action.operationId)
    } else if (action.kind === 'incoming') {
      showOriginal('incoming')
      const row = report.incoming.value?.rows.find(row => row.ingressId === action.ingressId)
      if (row?.kind === 'message' && row.scope === 'current-binding' && row.inputOperationId) void inspectInput(row)
    } else if (action.kind === 'content') showOriginal('content')
  }
  useEffect(() => { if (selectedProblem?.target === key) openProblem(selectedProblem.action) }, [selectedProblem, key])
  useEffect(() => {
    if (expanded && reveal.current) { focusOriginal(reveal.current); reveal.current = null }
  }, [expanded, key])
  useEffect(() => {
    if (!active || input?.key !== key) return
    const row = [...(originalSections.current.incoming?.querySelectorAll<HTMLElement>('[data-ingress-id]') ?? [])].find(node => node.dataset.ingressId === input.ingressId)
    row?.scrollIntoView({ block: 'start' }); row?.focus({ preventScroll: true })
  }, [input?.key, input?.ingressId, key])
  async function inspect(window: GroupWindow = {}) {
    const request = ++epoch.current; setPending(true)
    const result = await readGroupDiagnosis(source, target, window)
    if (!accepts() || request !== epoch.current) return
    setRead(previous => ({ key, value: retainGroupDiagnosis(previous?.key === key ? previous.value : null, result), checkedAt: Date.now() })); setPending(false)
  }
  async function inspectOriginal(operationId: string) {
    const request = ++epoch.current; setPending(true)
    try {
      const result = await source('connection.delivery.inspect', { operationId })
      if (!accepts() || request !== epoch.current) return
      const matched = result.delivery?.operationId === operationId && deliveryMatches(result.delivery, target)
      setDetail(previous => ({ key, request, value: matched ? result.delivery! : previous?.key === key && previous.value?.operationId === operationId ? previous.value : null, issue: !matched }))
    } catch { if (accepts() && request === epoch.current) setDetail(previous => ({ key, request, value: previous?.key === key && previous.value?.operationId === operationId ? previous.value : null, issue: true })) }
    finally { if (accepts() && request === epoch.current) setPending(false) }
  }
  async function inspectInput(row: NonNullable<GroupDiagnosis['incoming']['value']>['rows'][number]) {
    const request = ++epoch.current; setPending(true)
    try {
      const result = await source('connection.ingress.inspect', { ingressId: row.ingressId })
      if (!accepts() || request !== epoch.current) return
      const ingress = result.ingress, saved = ingress?.kind !== 'action' ? ingress?.input : undefined, receipt = result.inputReceipt
      const matches = ingress?.ingressId === row.ingressId && ingress.externalConversationId === target.externalConversationId && ingress.application.domain === target.domain && ingress.application.appId === target.appId &&
        saved?.operationId === row.inputOperationId && saved.hostId === target.executionHostId && saved.agentSessionId === target.agentSessionId && saved.author.bindingId === target.bindingId && saved.author.bindingRevision === row.bindingRevision && saved.author.connectionId === target.connectionId &&
        receipt?.originalControlOperationId === saved.operationId && receipt.key.kind === 'message' && receipt.key.agentSessionId === saved.agentSessionId && receipt.key.expectedRun.runId === saved.expectedRun.runId && receipt.key.messageId === saved.messageId
      setInput(previous => ({ key, ingressId: row.ingressId, receipt: matches ? receipt! : previous?.key === key && previous.ingressId === row.ingressId ? previous.receipt : null, issue: !matches }))
    } catch { if (accepts() && request === epoch.current) setInput(previous => ({ key, ingressId: row.ingressId, receipt: previous?.key === key && previous.ingressId === row.ingressId ? previous.receipt : null, issue: true })) }
    finally { if (accepts() && request === epoch.current) setPending(false) }
  }
  async function copyDiagnosis() {
    const request = ++exportRead.current
    // Freeze exact target and current bounded cursors at the click, separately from the changing display.
    const window: GroupWindow = { ...(visible?.outgoing.value?.after ? { after: visible.outgoing.value.after } : {}), ...(visible?.outgoing.value?.afterContent ? { afterContent: visible.outgoing.value.afterContent } : {}), ...(visible?.incoming.value?.beforeIngressId ? { beforeIngressId: visible.incoming.value.beforeIngressId } : {}) }
    setCopying(true); setFeedback('Reading this bounded group window…')
    try {
      const report = await readGroupDiagnosis(source, target, window)
      if (!accepts() || request !== exportRead.current) return
      await api.ui.writeClipboardText((hostingTarget ? `Bot hosting: ${hostingTarget.hostId} · Runtime: ${hostingTarget.runtimeId}\n` : '') + formatGroupDiagnosis(report))
      if (accepts() && request === exportRead.current) setFeedback('Bounded sanitized group diagnosis copied.')
    } catch { if (accepts() && request === exportRead.current) setFeedback('The diagnosis could not be copied. Original receipts remain available.') }
    finally { if (accepts() && request === exportRead.current) setCopying(false) }
  }
  useEffect(() => {
    live.current = true; reveal.current = null; setFeedback(''); setCopying(false); setDetail(null); setInput(null)
    return () => { live.current = false; epoch.current++; exportRead.current++ }
  }, [key, source])
  const configuration = checked?.report?.binding.value
  const outgoing = visible?.outgoing.value, incoming = visible?.incoming.value
  const sourceCause = connectorSourceExplanation(outgoing?.sourceObservation)
  const sectionIssue = (name: string, section: { issue: string | null; retained?: true } | undefined) => section?.issue ? <p className="agent-connector-note" role="status">{name} observation unconfirmed{section.retained ? '; earlier observed facts are kept.' : '.'}</p> : null
  const readFailed = !!visible && [visible.service, visible.adapterService, visible.connection, visible.binding, visible.outgoing, visible.incoming].some(section => section.issue)
  const summary = connectorGroupSummary(checked?.report ?? null)
  const hasSourceCheck = summary.problems.some(problem => problem.action?.kind === 'source')
  const originalFacts = original?.value ? deliveryFacts(original.value) : null
  const originalCause = originalFacts ? connectorDeliveryExplanation(originalFacts) : null
  const originalReceipt = original ? <div key={original.value?.operationId ?? 'unavailable-original'} ref={selectedReceipt} tabIndex={-1} className="agent-connector-receipt" data-selected-delivery={original.value?.operationId}>
        {original.issue && original.value ? <small role="status">Original receipt observation unconfirmed; earlier result retained.</small> : null}
        <strong role="status">{originalCause?.title ?? 'Original delivery receipt unavailable'}</strong>
        <small>{originalCause?.detail ?? 'The original operation is kept; no retry was sent.'}</small>
        {original.value?.wait ? <small>Original rate-limit earliest time: {new Date(original.value.wait.notBefore).toLocaleString()}; this does not confirm a platform effect.</small> : null}
        {original.value ? <><details className="agent-connector-disclosure"><summary>Original delivery identity</summary><div className="agent-connector-fields"><code>{original.value.operationId}</code>{originalFacts?.platformMessageId ? <code>{originalFacts.platformMessageId}</code> : null}<small>{receiptTitle(originalFacts!.kind)} · {original.value.state} · {originalFacts!.receipt ?? 'Platform receipt not recorded'}</small></div></details><ConnectorDeliveryRetryControl key={key + original.value.operationId} delivery={original.value} binding={binding} hostingTarget={hostingTarget} onObserve={value => {
          if (accepts()) setDetail(previous => previous?.key === key && previous.request === original.request ? { ...previous, value, issue: false } : previous)
        }} /></> : null}
      </div> : null
  const receiptRows = outgoing?.deliveries.map(delivery => {
    if (original?.value?.operationId === delivery.operationId) return originalReceipt
    const cause = connectorDeliveryExplanation(delivery)
    return <div className="agent-connector-receipt" key={delivery.operationId} data-delivery-operation={delivery.operationId}>
      <strong>{receiptTitle(delivery.kind)} · {cause.title}</strong>
      {delivery.receipt === 'unknown' || delivery.state === 'unknown' || delivery.receipt === 'not-applied' || delivery.state === 'not-applied' ? <small>{cause.detail}</small> : null}
      <details className="agent-connector-disclosure"><summary>Original delivery identity</summary><div className="agent-connector-fields"><code>{delivery.operationId}</code>{delivery.platformMessageId ? <code>{delivery.platformMessageId}</code> : null}<small>{delivery.state} · {delivery.receipt ?? 'Platform receipt not recorded'}</small></div></details>
      <button className="small-button" disabled={pending} onClick={() => void inspectOriginal(delivery.operationId)}>Check receipt</button>
    </div>
  }) ?? []
  if (originalReceipt && !outgoing?.deliveries.some(delivery => delivery.operationId === original?.value?.operationId)) receiptRows.push(originalReceipt)
  return <section className="agent-connector-fields connector-delivery-details" aria-busy={pending || checked?.checking} aria-label="Group delivery" data-connection-section="activity" tabIndex={-1}>
    {showConfiguration && configuration ? <div className="connector-group-details__configuration"><span>{checked?.report?.binding.issue ? 'Last observed sync' : 'Group sync'} · <strong>{configuration.state === 'paused' ? 'Paused' : configuration.state === 'detached' ? 'Disconnected' : 'Enabled'}</strong></span><span>Sharing · <strong>{configuration.scope.publication === 'future-shared-conversation' ? 'Complete conversation' : 'Agent replies only'}</strong></span></div> : null}
    <div className="agent-connector-section-title"><div><h3>Message activity</h3>{checked?.checkedAt ? <small className="agent-connector-checked">Checked <time dateTime={new Date(checked.checkedAt).toISOString()}>{new Date(checked.checkedAt).toLocaleTimeString()}</time> · recent receipt window</small> : null}</div>{!hasSourceCheck ? <button className="agent-connector-text-action" aria-busy={checked?.checking} disabled={checked?.checking} onClick={latest.check}>{checked?.checking ? <LoadingIcon size={13} animation="spin" /> : null}Check group activity</button> : null}</div>
    <ConnectorTrafficSummary incomingControl={incomingControl === undefined ? <ConnectorReceiverControl key={key} binding={binding} connection={connection} observed={checked?.report?.connection} hostingTarget={hostingTarget} onRefresh={latest.check} /> : incomingControl} summary={summary} actions={{ ...actions, ...(onMembers ? { members: onMembers } : {}),
      incoming: openProblem, receipts: openProblem, 'earlier-receipts': openProblem, content: openProblem, source: openProblem }} />

    <details className="agent-connector-disclosure connector-delivery-details__originals" open={expanded} onToggle={event => { setExpanded(event.currentTarget.open); if (event.currentTarget.open && read?.key !== key && checked?.report) setRead({ key, value: checked.report, checkedAt: checked?.checkedAt ?? Date.now() }) }}><summary>Message records</summary><div className="agent-connector-fields">
      <section className="connector-delivery-details__section" aria-label="Connection observation">
      <h4>Connection observation</h4>
      <p className="agent-connector-note">This reading stays in place while the activity summary updates.</p>
      <button className="agent-connector-text-action" disabled={pending} onClick={() => void inspect()}>Read latest records</button>
      {readFailed ? <p className="agent-connector-note" role="status">The latest check is incomplete. Earlier matching observations are kept.</p> : null}
      {visible?.service.value ? <p className="agent-connector-note">Automatic service: {visible.service.value.enabled ? 'on' : 'off'} · revision {visible.service.value.revision}</p> : null}
      {visible?.adapterService.value ? <p className="agent-connector-note">Platform: {visible.adapterService.value.enabled ? 'on' : 'off'} · revision {visible.adapterService.value.revision}</p> : null}
      {visible?.connection.value ? <p className="agent-connector-note">Application revision {visible.connection.value.revision} · authentication: {visible.connection.value.authentication.state} · transport: {visible.connection.value.transport.state} · intake: {visible.connection.value.intake.state} · delivery: {visible.connection.value.delivery.state}</p> : null}
      {visible?.binding.value ? <p className="agent-connector-note">Binding: {visible.binding.value.state} · {visible.binding.value.activeInputGrants} active input grants · current revision {visible.binding.value.currentRevision ?? 'unconfirmed'}</p> : null}
      {sectionIssue('Automatic service', visible?.service)}{sectionIssue('Platform policy', visible?.adapterService)}{sectionIssue('Application', visible?.connection)}{sectionIssue('Binding', visible?.binding)}
      {outgoing?.observation ? <p className="agent-connector-note">{outgoing.observation.reason === 'access-unconfirmed' ? <>Member access check unavailable. Application permissions could not be checked; saved decisions are kept. Review member access and check group activity again.</> : outgoing.observation.reason === 'effect-unconfirmed' ? <>Platform request observation: {outgoing.observation.state}. {outgoing.observation.state === 'unknown' ? 'Some original platform request results are unconfirmed.' : 'Check each original platform request receipt below for its outcome.'} Each request has its own receipt below. Unconfirmed requests are not sent again.</> : <>Source observation: {outgoing.observation.state}{outgoing.observation.reason ? ' · ' + outgoing.observation.reason : ''}. This describes local source reading, not platform delivery.</>}</p> : null}
      {sectionIssue('Outgoing', visible?.outgoing)}
      </section>
      <section ref={node => { originalSections.current.incoming = node }} className="connector-delivery-details__section" data-receipt-section="incoming" tabIndex={-1} aria-label="Incoming message details">
      <h4>Incoming events & Core input</h4>
      <p className="agent-connector-note">Latest 5 records from this application and group, including other receiving connections. Platform acknowledgement is not recorded by this read API.</p>
      {incoming ? <><p className="agent-connector-note">{incoming.rows.length} recent records, newest first.{incoming.next ? ' Earlier records are available.' : ''}</p>
        {!incoming.rows.length ? <p className="agent-connector-note">No intake in this exact group window. This is not a complete-history or platform-receipt claim.</p> : null}
        {incoming.rows.map(row => {
          const cause = connectorIntakeExplanation(row)
          const selected = input?.key === key && input.ingressId === row.ingressId && input.receipt !== null
          return <div className="agent-connector-receipt" key={row.ingressId} data-ingress-id={row.ingressId} tabIndex={-1}>
            <strong>{row.kind === 'action' ? 'Group action' : 'Group message'} · {selected ? 'Original input receipt' : cause.title}</strong>{!selected ? <small>{cause.detail}</small> : null}
            {row.scope === 'other-binding' ? <small>Earlier binding revision; this does not confirm the current group input.</small> : null}
            <details className="agent-connector-disclosure"><summary>Original intake identity</summary><div className="agent-connector-fields"><code>{row.ingressId}</code>{row.inputOperationId ? <code>{row.inputOperationId}</code> : null}<small>Recording: {row.recording?.state ?? 'not recorded'} · Intake: {row.state}{row.code ? ' · ' + row.code : ''}{row.recording?.code ? ' · ' + row.recording.code : ''}</small></div></details>
            {row.kind === 'message' && row.scope === 'current-binding' && row.inputOperationId && !(input?.key === key && input.ingressId === row.ingressId) ? <button className="small-button" disabled={pending} onClick={() => void inspectInput(row)}>Open original input</button> : null}
            {input?.key === key && input.ingressId === row.ingressId ? <>
              {input.issue ? <small role="status">Original input receipt could not be confirmed. Saved input and any earlier receipt are kept.</small> : null}
              {input.receipt ? <OriginalInputWaitingControl hostId={target.executionHostId} receipt={input.receipt} showReceipt onRefresh={() => inspect(visible?.window)} /> : <button className="small-button" disabled={pending} onClick={() => void inspectInput(row)}>Check original input result</button>}
              <button className="small-button" onClick={() => setInput(null)}>Close original input</button>
            </> : null}
          </div>
        })}
        {incoming.next ? <button className="small-button" disabled={pending} onClick={() => void inspect({ beforeIngressId: incoming.next! })}>Earlier intake</button> : null}</> : null}
      {sectionIssue('Incoming', visible?.incoming)}
      </section>
      <section ref={node => { originalSections.current.receipts = node }} className="connector-delivery-details__section" data-receipt-section="receipts" tabIndex={-1} aria-label="Platform delivery details">
      <h4>Platform delivery receipts</h4>
      <p className="agent-connector-note">Up to 5 receipts from this reading.{outgoing?.next ? ' Earlier receipts are available.' : ''} This is not the complete group history.</p>
      <div className="connector-delivery-details__receipts">{receiptRows}</div>
      {outgoing?.next ? <button className="small-button" disabled={pending} onClick={() => void inspect({ after: outgoing.next! })}>Earlier receipts</button> : null}
      <button className="small-button" disabled={pending} onClick={() => void inspect()}>Latest receipts</button>
      </section>
      <section ref={node => { originalSections.current.content = node }} className="connector-delivery-details__section" data-receipt-section="content" tabIndex={-1} aria-label="Conversation content details">
      <h4>Conversation content</h4>
      <strong>{sourceCause.title}</strong>
      <p className="agent-connector-note">{sourceCause.detail}</p>
      {outgoing?.sourceObservation ? <details className="agent-connector-disclosure"><summary>Reading details</summary><div className="agent-connector-fields"><small>{outgoing.sourceObservation.state}{outgoing.sourceObservation.reason ? ' · ' + outgoing.sourceObservation.reason : ''}</small>{outgoing.sourceObservation.code ? <code>{outgoing.sourceObservation.code}</code> : null}{outgoing.sourceObservation.checkpointKey ? <code>{outgoing.sourceObservation.checkpointKey}</code> : null}</div></details> : null}
      <p className="agent-connector-note">{outgoing?.coverage?.state === 'incomplete' ? 'Some content in this reading is not confirmed for sharing.' : outgoing?.coverage?.state === 'complete' ? 'No content gaps recorded in this reading.' : 'Content coverage has not been checked.'}{outgoing?.coverage?.nextContent ? ' More content is available.' : ''}</p>
      {outgoing?.coverage?.gaps.map(gap => { const cause = connectorGapExplanation(gap); return <div className="agent-connector-receipt" key={gap.gapKey}><strong>{cause.title}</strong><small>{cause.detail}</small><details className="agent-connector-disclosure"><summary>Original content gap</summary><div className="agent-connector-fields"><code>{gap.gapKey}</code><small>{gap.reason}{gap.code ? ' · ' + gap.code : ''}</small></div></details></div> })}
      {outgoing?.coverage?.omittedGapCount ? <p className="agent-connector-note">{outgoing.coverage.omittedGapCount} additional gaps in this owner page.</p> : null}
      {outgoing?.coverage?.nextContent ? <button className="small-button" disabled={pending} onClick={() => void inspect({ afterContent: outgoing.coverage!.nextContent! })}>Next content window</button> : null}
      </section>
    <div className="agent-connector-row"><button className="small-button" aria-busy={copying} disabled={copying} onClick={() => void copyDiagnosis()}>{copying ? <LoadingIcon size={13} animation="spin" /> : null}Copy group diagnosis</button>{copying ? <button className="small-button" onClick={() => { exportRead.current++; setCopying(false); setFeedback('Group diagnosis copy canceled.') }}>Cancel copy</button> : null}</div>
    {feedback ? <p className="agent-connector-note" role="status">{feedback}</p> : null}
    </div></details>
    {details ? <details className="agent-connector-disclosure"><summary>Connection identity and settings</summary><div className="agent-connector-fields">{details}</div></details> : null}
  </section>
}
