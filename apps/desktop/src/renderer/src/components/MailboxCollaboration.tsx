import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { AgentMuxRpcResult, DurableAgentMuxMessage } from '@agentmux/core'
import { formatSessionAddress } from '@agentmux/core/sharing'
import { ConversationMessage, type ConversationReadingProps } from '@agentmux/client-ui/components/ConversationMessage'
import { TextInput } from '@agentmux/client-ui/input'
import { ContentCopyButton } from '@agentmux/client-ui/components/ContentCopyButton'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from '../lib/api'
import { MailboxEmpty, MailboxSourceNotice, MailboxTime } from './MailboxReading'
import { SelectionField } from './SelectionField'
import '../styles/mailbox-collaboration.css'

type Page = AgentMuxRpcResult<'message.dispatch.ls'>
type Observation = AgentMuxRpcResult<'message.dispatch.read'>
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)

function OriginalMessage({ record, reading, onCopy }: { record: DurableAgentMuxMessage; reading?: ConversationReadingProps | undefined; onCopy?: ((text: string) => Promise<boolean>) | undefined }) {
  const [expanded, setExpanded] = useState(false)
  const { envelope: message, delivery } = record
  return <details className="mailbox-collaboration__message" data-message-id={message.messageId} onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open) }}>
    <summary><span>{message.replyTo ? 'Original reply' : 'Original request'}</span><span>{delivery.state}</span></summary>
    {expanded ? <><ConversationMessage {...(reading?.describeSpeaker ? { describeSpeaker: reading.describeSpeaker } : {})} {...(reading?.openHttpLink ? { openHttpLink: reading.openHttpLink } : {})} compact recordedIdentity messageId={message.messageId}
      speaker={message.senderSessionId ? { role: 'agent', id: message.senderSessionId } : { role: 'unknown', id: 'unknown' }}
      name={message.senderSessionId ?? 'Author unknown'} content={message.body} copyText={message.body} {...(onCopy ? { onCopy } : {})} />
      <dl className="composer-mailbox__record-facts">
        <dt>Message</dt><dd>{message.messageId}</dd><dt>Operation</dt><dd>{message.operationId}</dd>
        <dt>Sender Session</dt><dd>{message.senderSessionId ?? 'Unknown'}</dd><dt>Sender Run</dt><dd>{message.senderRunId ?? 'Unknown'}</dd>
        <dt>Recipient Session</dt><dd>{message.recipientSessionId ?? 'Unknown'}</dd><dt>Recipient Run</dt><dd>{message.recipientRunId ?? 'Unknown'}</dd>
        <dt>Thread</dt><dd>{message.threadId}</dd><dt>Correlation</dt><dd>{message.correlationId}</dd><dt>Reply to</dt><dd>{message.replyTo ?? 'None recorded'}</dd>
        <dt>Recorded Workspace</dt><dd>{message.workspaceId ?? 'Unknown'}</dd>
        <dt>Delivery</dt><dd>{delivery.state}{delivery.reason ? ` · ${delivery.reason}` : ''}</dd><dt>Receipt time</dt><dd><MailboxTime value={delivery.at} complete /></dd>
      </dl></> : null}
  </details>
}

/** A bounded original journal reader. It never sends, assigns, consumes or controls an Agent. */
export function MailboxCollaboration({ control, active, reading, onCopy }: {
  control: AgentSessionControl; active: boolean; reading?: ConversationReadingProps | undefined; onCopy?: ((text: string) => Promise<boolean>) | undefined
}) {
  const reference = { hostId: control.hostId, agentSessionId: control.agentSessionId }
  const scope = JSON.stringify([control.hostId, control.agentSessionId, control.run.runId])
  const visibilityOwner = useMemo(() => ({}), [active, scope])
  const live = useRef({ active, scope, owner: visibilityOwner }), listRequest = useRef(0), detailRequest = useRef(0)
  const [page, setPage] = useState<Page | null>(null), [selected, setSelected] = useState<string | null>(null)
  const selectionOwner = useMemo(() => ({}), [selected, visibilityOwner])
  const selectionLease = useRef<object | null>(selectionOwner)
  const [record, setRecord] = useState<Observation | null>(null)
  const [listIssue, setListIssue] = useState<{ message: string; cursor: string | null; pages: number; extend: boolean } | null>(null)
  const [detail, setDetail] = useState<{ source: string; loading: boolean; issue: string | null } | null>(null)
  const [navigationIssue, setNavigationIssue] = useState<{ source: string; message: string } | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  const [query, setQuery] = useState(''), [status, setStatus] = useState('all')
  const search = useRef<HTMLInputElement>(null)
  const loadedPages = useRef(1), navigationRequest = useRef(0)
  const root = useRef<HTMLElement>(null), back = useRef<HTMLButtonElement>(null)
  const listPosition = useRef<{ scroll: number; source: string; focused: boolean } | null>(null)
  const currentSelection = useRef(selected); currentSelection.current = selected
  useLayoutEffect(() => {
    live.current = { active, scope, owner: visibilityOwner }
    return () => { live.current.active = false; ++listRequest.current; ++detailRequest.current; ++navigationRequest.current }
  }, [active, scope, visibilityOwner])
  useLayoutEffect(() => {
    selectionLease.current = selectionOwner
    return () => { selectionLease.current = null; ++detailRequest.current; ++navigationRequest.current }
  }, [selectionOwner])
  const isCurrentOwner = () => live.current.active && live.current.owner === visibilityOwner && selectionLease.current === selectionOwner
  const admitted = (request: number, current: number) => live.current.active && live.current.owner === visibilityOwner && request === current
  async function loadPage(cursor: string | null = null, pages = loadedPages.current, extend = false) {
    if (!live.current.active || live.current.owner !== visibilityOwner) return
    const request = ++listRequest.current
    setLoadingList(true); setListIssue(null)
    try {
      let result: Page | null = null, next = cursor, readPages = 0
      const records: Page['dispatches'][number][] = []
      for (let index = 0; index < pages; ++index) {
        result = await api.sessions.dispatches(reference, { limit: 20, ...(next ? { afterSourceMessageId: next } : {}) })
        if (!admitted(request, listRequest.current)) return
        if (result.hostId !== reference.hostId || result.participantSessionId !== reference.agentSessionId) throw new Error('The original Host or participant did not match this reading source.')
        records.push(...result.dispatches); ++readPages; next = result.nextSourceMessageId
        if (!next) break
      }
      if (!result) return
      loadedPages.current = extend ? loadedPages.current + readPages : readPages
      const observed = result
      setPage(previous => ({ ...observed, dispatches: [...new Map([...(previous?.dispatches ?? []), ...records].map(item => [item.sourceMessageId, item])).values()] }))
    } catch (error) { if (admitted(request, listRequest.current)) setListIssue({ message: reason(error), cursor, pages, extend }) }
    finally { if (admitted(request, listRequest.current)) setLoadingList(false) }
  }
  async function loadDetail(source: string) {
    if (!isCurrentOwner() || currentSelection.current !== source) return
    const request = ++detailRequest.current
    setDetail({ source, loading: true, issue: null })
    try {
      const result = await api.sessions.dispatch(reference, source)
      if (!admitted(request, detailRequest.current) || currentSelection.current !== source) return
      if (result.hostId !== reference.hostId || result.dispatch.sourceMessageId !== source || result.source.envelope.messageId !== source ||
        result.dispatch.ownerAgentSessionId !== reference.agentSessionId && result.dispatch.workerAgentSessionId !== reference.agentSessionId) throw new Error('The original collaboration record did not match this source and participant.')
      setRecord(result)
    } catch (error) { if (admitted(request, detailRequest.current) && currentSelection.current === source) setDetail({ source, loading: false, issue: reason(error) }) }
    finally { if (admitted(request, detailRequest.current) && currentSelection.current === source) setDetail(value => value?.source === source ? { ...value, loading: false } : value) }
  }
  useEffect(() => { if (active) void loadPage() }, [active, scope])
  useEffect(() => { if (selected && active) void loadDetail(selected) }, [selected, active, scope])
  useLayoutEffect(() => {
    const position = listPosition.current
    if (!position) return
    const viewport = root.current?.closest<HTMLElement>('.composer-mailbox__content')
    if (selected) { if (viewport) viewport.scrollTop = 0; if (position.focused) back.current?.focus({ preventScroll: true }) }
    else {
      if (viewport) viewport.scrollTop = position.scroll
      if (position.focused) Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-source-message]') ?? []).find(node => node.dataset.sourceMessage === position.source)?.focus({ preventScroll: true })
      listPosition.current = null
    }
  }, [selected])
  function select(source: string, event: MouseEvent<HTMLButtonElement>) {
    if (!isCurrentOwner()) return
    listPosition.current = { scroll: root.current?.closest('.composer-mailbox__content')?.scrollTop ?? 0, source, focused: document.activeElement === event.currentTarget }
    ++navigationRequest.current; setNavigationIssue(null); setSelected(source)
  }
  async function openAgent(id: string) {
    const source = selected
    if (!source || !isCurrentOwner() || currentSelection.current !== source) return
    const request = ++navigationRequest.current
    try { await api.ui.openObjectLink(formatSessionAddress(id)) }
    catch (error) { if (isCurrentOwner() && admitted(request, navigationRequest.current) && currentSelection.current === source) setNavigationIssue({ source, message: reason(error) }) }
  }
  function refresh() { if (!isCurrentOwner()) return; void loadPage(); if (selected) void loadDetail(selected) }
  function leave() { if (!isCurrentOwner()) return; ++detailRequest.current; ++navigationRequest.current; setSelected(null) }
  const original = selected && record?.dispatch.sourceMessageId === selected ? record : null
  const detailIssue = detail?.source === selected ? detail.issue : null
  const loadingDetail = detail?.source === selected && detail.loading
  const evidenceIdentity = useMemo(() => ({}), [original, detail, selectionOwner])
  const evidenceText = original ? JSON.stringify({
    interpretation: 'Original recorded communication. Delivery and supervision do not establish execution or Goal acceptance. Missing facts remain unknown.',
    readObservation: { state: loadingDetail ? 'reading-unconfirmed' : detailIssue ? 'read-unconfirmed' : 'confirmed', issue: detailIssue },
    record: original
  }, null, 2) : ''
  const names = useMemo(() => new Map([...new Set((page?.dispatches ?? []).flatMap(item => [item.ownerAgentSessionId, item.workerAgentSessionId]))]
    .map(id => [id, reading?.describeSpeaker?.({ role: 'agent', id }).name ?? id])), [page, reading?.describeSpeaker])
  const matches = (page?.dispatches ?? []).filter(item => {
    const searchable = [item.sourceMessageId, item.ownerAgentSessionId, item.workerAgentSessionId, names.get(item.ownerAgentSessionId), names.get(item.workerAgentSessionId)].join(' ').toLocaleLowerCase()
    return searchable.includes(query.trim().toLocaleLowerCase()) && (status === 'all' || (status === 'waiting' ? item.originAwaits : !item.originAwaits))
  })
  return <section ref={root} className="mailbox-collaboration" aria-label="Supervised collaboration records">
    <div className="mailbox-collaboration__heading"><strong>Supervised collaboration</strong><button type="button" className="composer-tool" aria-busy={loadingList || loadingDetail}
      onClick={refresh}>Refresh records</button></div>
    <details className="mailbox-collaboration__help"><summary><SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />About these records</summary>
      <p className="mailbox-collaboration__hint">Original supervised messages only. Other Agent messages remain in Inbox and Outbox. Search covers the loaded list; load more records to extend it.</p>
    </details>
    {listIssue ? <MailboxSourceNotice title="Collaboration list is unconfirmed" message={listIssue.message} action="Retry collaboration list" onAction={() => void loadPage(listIssue.cursor, listIssue.pages, listIssue.extend)} /> : null}
    {selected ? <><div className="mailbox-collaboration__actions"><button ref={back} type="button" className="composer-tool" onClick={leave}>Back to collaboration</button>
      {original ? <span className="mailbox-collaboration__evidence"><span>Original evidence</span><ContentCopyButton label="Copy collaboration evidence" text={evidenceText} identity={evidenceIdentity} /></span> : null}</div>
      {detailIssue ? <MailboxSourceNotice title="Original record read is unconfirmed" message={detailIssue} action="Retry original record" onAction={() => void loadDetail(selected)} /> : null}
      {original ? <article data-dispatch-source={selected}>
        <p>{original.dispatch.originAwaits ? 'Communication is awaiting a worker report.' : 'Worker report recorded; review is separate.'}</p>
        <p className="mailbox-collaboration__hint">Delivery and supervision do not confirm execution or Goal acceptance. No Goal association is provided by this record.</p>
        <dl className="composer-mailbox__record-facts"><dt>Host</dt><dd>{original.hostId}</dd><dt>Source</dt><dd>{selected}</dd>
          <dt>Owner</dt><dd><button type="button" className="composer-tool" onClick={() => void openAgent(original.dispatch.ownerAgentSessionId)}>{original.dispatch.ownerAgentSessionId}</button></dd>
          <dt>Worker</dt><dd><button type="button" className="composer-tool" onClick={() => void openAgent(original.dispatch.workerAgentSessionId)}>{original.dispatch.workerAgentSessionId}</button></dd></dl>
        {navigationIssue?.source === selected ? <p role="status">{navigationIssue.message}</p> : null}
        <OriginalMessage key={original.source.envelope.messageId} record={original.source} reading={reading} onCopy={onCopy} />
        <h3>Supervision events</h3>
        {original.dispatch.events.length ? <ol>{original.dispatch.events.map(event => <li key={event.replyMessageId}><strong>{event.kind}</strong> · {event.replyMessageId} · <MailboxTime value={event.at} /></li>)}</ol> : <p>No supervision events recorded.</p>}
        <h3>Original replies</h3>
        {original.replies.length ? original.replies.map(reply => <OriginalMessage key={reply.envelope.messageId} record={reply} reading={reading} onCopy={onCopy} />) : <p>No replies recorded.</p>}
        {original.identityDiagnostics.length ? <details className="mailbox-collaboration__diagnostics"><summary>Current identity observation is unconfirmed ({original.identityDiagnostics.length})</summary>
          {original.identityDiagnostics.map(item => <p key={JSON.stringify([item.agentSessionId, item.runId, item.code])}>{item.agentSessionId} · {item.runId} · {item.code}: {item.message}</p>)}
          <p>Original recorded identities remain above. Current Run health is not established by this observation.</p></details> : null}
      </article> : <MailboxEmpty title={loadingDetail ? 'Reading original record' : 'Original record is unconfirmed'} hint={selected} />}
    </> : page ? <><div className="mailbox-collaboration__filters" onKeyDown={event => { if (event.key === 'Enter') event.stopPropagation() }}>
      <TextInput ref={search} aria-label="Find loaded collaboration records" placeholder="Find by Agent or message ID" value={query}
        onChange={event => { if (isCurrentOwner()) setQuery(event.target.value) }} />
      <SelectionField label="Filter collaboration communication" value={status} onValueChange={value => { if (isCurrentOwner()) setStatus(value) }} options={[
        { value: 'all', label: 'All communication' }, { value: 'waiting', label: 'Awaiting report' }, { value: 'reported', label: 'Report recorded' }
      ]} />
      {query || status !== 'all' ? <button type="button" className="composer-tool" onClick={() => { if (!isCurrentOwner()) return; setQuery(''); setStatus('all'); search.current?.focus({ preventScroll: true }) }}>Clear filters</button> : null}
    </div><p className="mailbox-collaboration__hint" role="status">{matches.length} of {page.dispatches.length} loaded records · This list only.</p>
    <ol className="composer-mailbox__messages" aria-label="Supervised collaboration sources">{matches.map(item => <li key={item.sourceMessageId}>
      <button type="button" className="composer-mailbox__row" data-source-message={item.sourceMessageId} onClick={event => select(item.sourceMessageId, event)}>
        <span className="composer-mailbox__row-head"><strong>{names.get(item.ownerAgentSessionId)} → {names.get(item.workerAgentSessionId)}</strong></span>
        {names.get(item.ownerAgentSessionId) !== item.ownerAgentSessionId || names.get(item.workerAgentSessionId) !== item.workerAgentSessionId ? <span className="composer-mailbox__metadata">{item.ownerAgentSessionId} → {item.workerAgentSessionId}</span> : null}
        <span className="composer-mailbox__preview">{item.sourceMessageId}</span><span className="composer-mailbox__metadata">{item.originAwaits ? 'Awaiting report' : 'Report recorded · review separate'}</span>
      </button></li>)}</ol>
      {!page.dispatches.length ? <MailboxEmpty title="No supervised collaboration recorded" hint="This does not describe other Agent messages or execution status." /> : null}
      {page.dispatches.length && !matches.length ? <MailboxEmpty title="No loaded records match" hint="Clear the filters or load more original records. Other history has not been searched." /> : null}
      {page.nextSourceMessageId ? <button type="button" className="composer-tool" onClick={() => void loadPage(page.nextSourceMessageId, 1, true)}>Load more collaboration records</button> : null}
    </> : <MailboxEmpty title={loadingList ? 'Reading supervised collaboration' : 'Supervised collaboration is unconfirmed'} />}
  </section>
}
