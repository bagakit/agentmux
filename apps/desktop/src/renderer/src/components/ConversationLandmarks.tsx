import * as Dialog from '@agentmux/client-ui/components/Modal'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { mintObjectId } from '@agentmux/core/object-id'
import { parseConversationLandmarkWrite, type ConversationItemRef, ConversationRef, ConversationLandmark, ConversationLandmarkChange, ConversationLandmarkPage, ConversationLandmarkWrite } from '@agentmux/core/conversation'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { api } from '../lib/api'
import { useAppStore, retainConversationLandmarkIntent, clearConversationLandmarkIntent } from '../store'
import { conversationLandmarkIntentKey, conversationLandmarkRecordKey } from '../lib/conversation-landmark-intent'
import type { RevealConversationItem } from '../lib/mailbox-message-navigation'
import { DocumentOverlayPortal } from './WindowOverlayHost'
const BookmarkIcon = semanticIconComponent('object.bookmark'), CloseIcon = semanticIconComponent('action.close')
const EditIcon = semanticIconComponent('action.edit'), RemoveIcon = semanticIconComponent('action.remove')
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined

function retainedInput(key: string): ConversationLandmarkWrite | null {
  const original = useAppStore.getState().conversationLandmarkIntents?.[key]
  if (!original) return null
  try { const input = parseConversationLandmarkWrite(original); return conversationLandmarkIntentKey(input) === key ? input : null }
  catch { return null }
}
/** One explicit metadata operation; no read on mount, output subscription or body cache. */
function useLandmarks(reference: ConversationRef, active: boolean, retainedKey?: string, onAccepted?: (page: ConversationLandmarkPage) => void) {
  const owner = useMemo(() => ({}), [reference.hostId, reference.agentSessionId])
  const current = useRef(owner); current.current = owner
  useEffect(() => { current.current = owner; return () => { if (current.current === owner) current.current = {} } }, [owner])
  const [page, setPage] = useState<ConversationLandmarkPage | null>(null)
  const [intent, setIntent] = useState<ConversationLandmarkWrite | null>(() => retainedKey ? retainedInput(retainedKey) : null)
  const [busy, setBusy] = useState(false), busyRef = useRef(false)
  const [issue, setIssue] = useState<string | null>(null), [confirmed, setConfirmed] = useState<string | null>(null)
  const [conflict, setConflict] = useState<'revision' | 'missing' | null>(null)
  const valid = () => current.current === owner
  async function load(operationId?: string) {
    const next = await api.landmarks.list({ hostId: reference.hostId, agentSessionId: reference.agentSessionId, ...(operationId ? { operationId } : {}) })
    if (valid()) setPage(next)
    return next
  }
  async function run(action: () => Promise<void>) {
    if (busyRef.current || !active) return
    busyRef.current = true; setBusy(true); setIssue(null)
    try { await action() } catch (error) { if (valid()) setIssue(message(error)) }
    finally { busyRef.current = false; if (valid()) setBusy(false) }
  }
  function accept(next: ConversationLandmarkPage, original: ConversationLandmarkWrite) {
    if (!valid()) return
    if (!next.recordedOperation || JSON.stringify(next.recordedOperation.input) !== JSON.stringify(original)) throw new Error('The original save receipt is unconfirmed. Keep this same operation and check again.')
    setPage(next); setConfirmed(original.operationId); setIntent(null); setConflict(null); onAccepted?.(next)
    void clearConversationLandmarkIntent(original)
  }
  function apply(change: ConversationLandmarkChange) { return run(async () => {
    const original = intent ?? { hostId: reference.hostId, agentSessionId: reference.agentSessionId, operationId: mintObjectId(), expectedRevision: (await load()).revision, change }
    if (!valid()) return
    const retained = await retainConversationLandmarkIntent(original)
    if (valid()) setIntent(original)
    if (valid() && retained.diskDurability !== 'confirmed') setIssue(`Your original intent is kept in this app; workbench saving is unconfirmed. ${retained.reason ?? 'Check the workbench save warning before closing.'}`)
    try { accept(await api.landmarks.apply(original), original) }
    catch (error) {
      if (valid()) setConflict(code(error) === 'CONVERSATION_LANDMARK_CONFLICT' ? 'revision' : code(error) === 'CONVERSATION_LANDMARK_NOT_FOUND' ? 'missing' : null)
      throw error
    }
  }) }
  function check() { return run(async () => {
    if (!intent) { await load(); return }
    const observed = await load(intent.operationId)
    if (!valid()) return
    if (observed.recordedOperation) accept(observed, intent)
    else setIssue('The original operation is not recorded in this observation. Its intent is kept; retry the same operation to obtain its result.')
  }) }
  function refreshAfterConflict() { return run(async () => {
    if (!intent || !conflict) return
    const observed = await load(intent.operationId)
    if (!valid()) return
    if (observed.recordedOperation) accept(observed, intent)
    else { await clearConversationLandmarkIntent(intent); setIntent(null); setConflict(null); setIssue(conflict === 'missing' ? 'The original write was rejected because its point no longer exists. The list is refreshed; review the available points before a new action.' : 'The original write was rejected by a revision conflict. The list is refreshed; review your name and explicitly save a new intent.') }
  }) }
  const restoreRetained = () => {
    const original = retainedKey ? retainedInput(retainedKey) : undefined
    if (original && !busyRef.current) { setIntent(original); setConfirmed(null); return original }
    // Another open reading tool may have confirmed this same operation. The absent
    // client intent is not its receipt: reconcile only when this form reopens.
    else if (intent && !busyRef.current) void check()
    return null
  }
  const beginNewConfirmedIntent = () => { if (confirmed && !intent && !busyRef.current) { setConfirmed(null); setIssue(null); return true } return false }
  return { page, intent, busy, issue, confirmed, conflict, beginNewConfirmedIntent, restoreRetained, adopt: setPage, refresh: () => run(async () => { await load(intent?.operationId) }), apply, check, refreshAfterConflict }
}

function LandmarkPopover({ title, trigger, active, onOpen, children }: {
  title: string; trigger: ReactNode; active: boolean; onOpen?: () => void; children: ReactNode
}) {
  const [open, setOpen] = useState(false), [anchor, setAnchor] = useState<HTMLButtonElement | null>(null), [content, setContent] = useState<HTMLDivElement | null>(null)
  const focusPending = useRef(false)
  useLayoutEffect(() => { if (!active) { focusPending.current = false; setOpen(false) } }, [active])
  useLayoutEffect(() => {
    if (!open || !active || !anchor || !content) return
    let current = true
    const update = async () => { const result = await computePosition(anchor, content, { strategy: 'fixed', placement: 'bottom-end', middleware: [offset(6), flip(), shift({ padding: 10 })] }); if (current) {
      Object.assign(content.style, { left: result.x + 'px', top: result.y + 'px', visibility: 'visible' })
      if (focusPending.current) { focusPending.current = false; (content.querySelector<HTMLElement>('input:not([disabled])') ?? content.querySelector<HTMLElement>('button:not([disabled])'))?.focus({ preventScroll: true }) }
    } }
    const release = autoUpdate(anchor, content, () => { void update() })
    return () => { current = false; release() }
  }, [open, active, anchor, content])
  return <Dialog.Root modal={false} open={open && active} onOpenChange={next => { focusPending.current = next; setOpen(next); if (next) onOpen?.() }}>
    <Dialog.Trigger asChild><button ref={setAnchor} type="button" className="conversation-landmark__trigger" aria-label={title} title={title}>{trigger}</button></Dialog.Trigger>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Content ref={setContent} className="conversation-landmark" style={{ visibility: 'hidden' }} aria-describedby={undefined} onOpenAutoFocus={event => event.preventDefault()} onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() }}>
      <header><Dialog.Title>{title}</Dialog.Title><Dialog.Close type="button" className="icon-button" aria-label={`Close ${title}`}><CloseIcon size={13}/></Dialog.Close></header>
      {children}
    </Dialog.Content></DocumentOverlayPortal>
  </Dialog.Root>
}
function Pending({ state }: { state: ReturnType<typeof useLandmarks> }) {
  return <>{state.issue ? <p className="conversation-landmark__issue" role="status">{state.issue}</p> : null}
    {state.intent ? <div className="conversation-landmark__pending"><p>Original save intent retained. Availability of its record is checked separately.</p><code className="conversation-landmark__operation">{state.intent.operationId}</code>
      <button type="button" className="small-button" disabled={state.busy} onClick={() => { void state.check() }}>Check original save</button>
      <button type="button" className="small-button" disabled={state.busy} onClick={() => { void state.apply(state.intent!.change) }}>Retry original save</button>
      {state.conflict ? <button type="button" className="small-button" disabled={state.busy} onClick={() => { void state.refreshAfterConflict() }}>{state.conflict === 'missing' ? 'Review missing point' : 'Refresh after conflict'}</button> : null}
    </div> : null}</>
}
function SaveConversationLandmarkInner({ reference, routeHostId, active = true }: { reference: ConversationItemRef; routeHostId?: string | undefined; active?: boolean }) {
  const catalog = { hostId: routeHostId ?? reference.hostId, agentSessionId: reference.agentSessionId }
  const newKey = conversationLandmarkRecordKey(reference, routeHostId), oldKey = conversationLandmarkRecordKey(reference), old = retainedInput(oldKey)
  const key = retainedInput(newKey) ? newKey : old?.hostId === catalog.hostId && old.agentSessionId === catalog.agentSessionId ? oldKey : newKey
  const state = useLandmarks(catalog, active, key), field = useId(), [name, setName] = useState(() => { const input = retainedInput(key); return input?.change.kind === 'create' ? input.change.point.name : '' }), pointId = useRef<string | null>(null)
  return <LandmarkPopover title="Name reading point" trigger={<BookmarkIcon size={12}/>} active={active} onOpen={() => { const retained = state.restoreRetained(); if (retained?.change.kind === 'create') { setName(retained.change.point.name); pointId.current = retained.change.point.id } else if (state.beginNewConfirmedIntent()) { setName(''); pointId.current = null } }}>
    <form onSubmit={event => { event.preventDefault(); if (!name.trim() || state.intent || state.confirmed) return; pointId.current ??= mintObjectId(); void state.apply({ kind: 'create', point: { id: pointId.current, name, reference, ...(routeHostId ? { routeHostId } : {}) } }) }}
      onKeyDown={event => { if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event)) event.preventDefault() }}>
      <label htmlFor={field}>Name</label><input id={field} value={name} onChange={event => setName(event.target.value)} readOnly={state.busy || !!state.intent || !!state.confirmed} autoComplete="off" placeholder="A place to return to"/>
      <p className="conversation-landmark__source">{reference.source.kind === 'native' ? `${reference.source.providerId} · Native record` : 'Captured record'} · <code>{reference.source.recordId}</code></p>
      <Pending state={state}/>
      {state.confirmed ? <p role="status">Saved. Return from Reading points.</p> : <button type="submit" className="small-button" disabled={state.busy || !!state.intent || !name.trim()}>{state.busy ? 'Saving…' : 'Save reading point'}</button>}
    </form>
  </LandmarkPopover>
}
export const renderConversationLandmarkAction = (reference: ConversationItemRef, active: boolean, routeHostId?: string) => <SaveConversationLandmark key={JSON.stringify([routeHostId,reference])} reference={reference} routeHostId={routeHostId} active={active}/>

function ConversationLandmarkListInner({ reference, reveal, active }: { reference: ConversationRef; reveal: RevealConversationItem; active: boolean }) {
  const state = useLandmarks(reference, active), [edit, setEdit] = useState<{ id: string; name: string } | null>(null), [navigation, setNavigation] = useState<string | null>(null)
  const request = useRef(0), source = JSON.stringify([reference.hostId, reference.agentSessionId, active]), currentSource = useRef(source); currentSource.current = source
  useEffect(() => () => { request.current++ }, [source])
  useEffect(() => { if (state.confirmed) setEdit(null) }, [state.confirmed])
  async function openPoint(point: ConversationLandmark) {
    const generation = ++request.current, originalSource = source
    setNavigation(null)
    const result = await reveal(point.reference, point.routeHostId ?? reference.hostId)
    if (generation !== request.current || currentSource.current !== originalSource || !active) return
    if (result.kind === 'located') setNavigation(`Located ${point.name}.`)
    else if (result.kind === 'unavailable') setNavigation(result.message)
    else setNavigation('Navigation cancelled by your later reading intent. The point is kept.')
  }
  return <LandmarkPopover title="Reading points" trigger={<><BookmarkIcon size={11}/><span>Reading points</span></>} active={active} onOpen={() => { void state.refresh() }}>
    <div className="conversation-landmark__list">
      {!state.page && !state.issue ? <p role="status">{state.busy ? 'Reading saved points…' : 'Open the list to read saved points.'}</p> : null}
      {state.page?.points.length === 0 ? <p>No named points in this conversation.</p> : null}
      {state.page?.points.map(point => <div className="conversation-landmark__row" key={point.id}>
        {edit?.id === point.id ? <form onSubmit={event => { event.preventDefault(); if (edit.name.trim() && !state.intent) void state.apply({ kind: 'rename', id: point.id, name: edit.name }) }} onKeyDown={event => { if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event)) event.preventDefault() }}>
          <label><span className="sr-only">Reading point name</span><input aria-label="Reading point name" value={edit.name} readOnly={state.busy || !!state.intent} onChange={event => setEdit({ ...edit, name: event.target.value })}/></label>
          <button type="submit" className="small-button" disabled={state.busy || !!state.intent || !edit.name.trim()}>Save name</button>
          <button type="button" className="small-button" onClick={() => setEdit(null)}>Cancel</button>
        </form> : <><button type="button" className="conversation-landmark__destination" title={point.name} onClick={() => { void openPoint(point) }}><span>{point.name}</span><small>{point.reference.source.kind === 'native' ? `${point.reference.source.providerId} · Native` : 'Captured'}</small></button>
          <button type="button" className="icon-button" aria-label={`Rename ${point.name}`} disabled={state.busy || !!state.intent} onClick={() => setEdit({ id: point.id, name: point.name })}><EditIcon size={12}/></button>
          <button type="button" className="icon-button" aria-label={`Remove ${point.name}`} disabled={state.busy || !!state.intent} onClick={() => { void state.apply({ kind: 'remove', id: point.id }) }}><RemoveIcon size={12}/></button></>}
      </div>)}
    </div>
    <Pending state={state}/><RetainedLandmarkIntents reference={reference} active={active} onAccepted={state.adopt} excludeOperationId={state.intent?.operationId}/>{navigation ? <p role="status">{navigation}</p> : null}
    <footer><button type="button" className="small-button" disabled={state.busy} onClick={() => { void state.refresh() }}>Refresh points</button><span>Original record references</span></footer>
  </LandmarkPopover>
}

export function SaveConversationLandmark(props: { reference: ConversationItemRef; routeHostId?: string | undefined; active?: boolean }) {
  return <SaveConversationLandmarkInner key={JSON.stringify([props.routeHostId,props.reference])} {...props}/>
}
export function ConversationLandmarkList(props: { reference: ConversationRef; reveal: RevealConversationItem; active: boolean }) {
  return <ConversationLandmarkListInner key={JSON.stringify([props.reference.hostId, props.reference.agentSessionId])} {...props}/>
}

function RetainedLandmarkOperation({ input, active, onAccepted }: { input: ConversationLandmarkWrite; active: boolean; onAccepted: (page: ConversationLandmarkPage) => void }) {
  const state = useLandmarks(input, active, conversationLandmarkIntentKey(input), onAccepted)
  return <section className="conversation-landmark__recovery"><strong>{input.change.kind === 'create' ? input.change.point.name : input.change.kind === 'rename' ? input.change.name : 'Remove reading point'}</strong><Pending state={state}/></section>
}
function RetainedLandmarkIntents({ reference, active, onAccepted, excludeOperationId }: { reference: ConversationRef; active: boolean; onAccepted: (page: ConversationLandmarkPage) => void; excludeOperationId?: string | undefined }) {
  const intents = useAppStore(state => state.conversationLandmarkIntents)
  const inputs: ConversationLandmarkWrite[] = []; let unreadable = false
  for (const [key, original] of Object.entries(intents ?? {})) {
    try { const input = parseConversationLandmarkWrite(original); if (conversationLandmarkIntentKey(input) !== key) { unreadable = true; continue }; if (input.hostId === reference.hostId && input.agentSessionId === reference.agentSessionId && input.operationId !== excludeOperationId) inputs.push(input) }
    catch { unreadable = true }
  }
  return <>{unreadable ? <p role="status" className="conversation-landmark__issue">An original client save intent cannot be read. It is retained in the workbench; no operation was replaced or retried.</p> : null}{inputs.map(input => <RetainedLandmarkOperation key={input.operationId} input={input} active={active} onAccepted={onAccepted}/>)}</>
}
