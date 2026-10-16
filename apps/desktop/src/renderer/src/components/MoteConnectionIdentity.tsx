import { useWorkbenchDocument } from '../lib/workbench-document'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { useContext, useEffect, useId, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { moteConnectionBaseline, parseMotePreferencesReadResult, parseMotePreferencesSaveResult, sameMotePreferencesTarget,
  type MoteConnectionPreferencesReadResult, type MoteConnectionPreferencesSaveParams,
  type MoteConnectionPreferencesSaveResult, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { ConnectionRecord, ConnectionSetupEnrollmentSource } from '@agentmux/core/connections'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { api } from '../lib/api'
import { clearMoteConnectionSaveIntent, retainMoteConnectionSaveIntent, useAppStore } from '../store'
import { moteConnectionChoice, moteConnectionTarget } from '../lib/mote-connection-default'
import { SelectionField } from './SelectionField'
import { MoteBotSetup } from './MoteBotSetup'
import { SettingsNavigation } from './SettingsNavigation'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import '../styles/mote-connection-identity.css'

const BotIcon = semanticIconComponent('object.conversation')
const CloseIcon = semanticIconComponent('action.close')
const ForwardIcon = semanticIconComponent('navigation.forward')

type Snapshot = { saved: MoteConnectionPreferencesReadResult; connections: ConnectionRecord[]; connectionIssue: string | null }
const choiceKey = (ref: { connectionId: string; application: { domain: string; appId: string } }) => JSON.stringify([ref.connectionId, ref.application.domain, ref.application.appId])
async function read(target: MotePreferencesTarget): Promise<Snapshot> {
  const input = { kind: 'connection' as const, target }
  const [value, apps] = await Promise.allSettled([api.motePreferences.read(input), api.connections.call('connection.ls', {})])
  if (value.status === 'rejected') throw value.reason
  return { saved: parseMotePreferencesReadResult(value.value, input), connections: apps.status === 'fulfilled' ? apps.value.connections : [],
    connectionIssue: apps.status === 'fulfilled' ? null : presentError(apps.reason) }
}

/** A view of the original MOTE.md preference, never another identity registry. */
export function MoteConnectionIdentity({ scope, active }: { scope: MoteWorkfaceScope; active: boolean }) {
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const target = moteConnectionTarget(scope, bindings), identity = JSON.stringify(target)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [issue, setIssue] = useState(''), [editing, setEditing] = useState(false)
  const lifetime = useRef<object>({}), invoker = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const token = {}; lifetime.current = token
    if (!active || !target) return
    void read(target).then(value => { if (lifetime.current === token) { setSnapshot(value); setIssue('') } })
      .catch(error => { if (lifetime.current === token) setIssue(presentError(error)) })
    return () => { lifetime.current = {} }
  }, [active, identity])
  const ref = snapshot?.saved.values?.connection
  const choice = ref && snapshot && !snapshot.connectionIssue ? moteConnectionChoice(ref, snapshot.connections) : null
  function accept(value: Snapshot) {
    // A later child read or writer acknowledgement supersedes the opening read.
    lifetime.current = {}; setSnapshot(value); setIssue('')
  }
  return <section className="mote-connection" aria-label="Mote bot" data-mote-connection={scope.topic.id}>
    <button ref={invoker} type="button" className="mote-connection__row" onClick={() => setEditing(true)}>
      <BotIcon size={14} /><span>Chat bot</span><strong>{choice?.record?.config.label ?? (ref ? 'Saved bot' : snapshot?.saved.status === 'ready' ? 'Choose a bot' : snapshot || issue ? 'Not confirmed' : 'View bots')}</strong><ForwardIcon size={12} />
    </button>
    {issue || snapshot?.saved.issue || snapshot?.connectionIssue || choice?.issue ? <p role="status" className="mote-details__hint">{issue || snapshot?.saved.issue || snapshot?.connectionIssue || choice?.issue}</p> : null}
    {active && editing ? <MoteConnectionDialog key={identity} target={target} topicId={scope.topic.id} moteName={scope.topic.title} onClose={() => setEditing(false)}
      onRead={accept} returnFocus={() => invoker.current?.isConnected ? invoker.current : null} /> : null}
  </section>
}

function MoteConnectionDialog({ target, topicId, moteName, onClose, onRead, returnFocus }: {
  target: MotePreferencesTarget | null; topicId: string; moteName: string; onClose(): void; onRead(value: Snapshot): void; returnFocus(): HTMLElement | null
}) {
  const ownerDocument = useWorkbenchDocument(), content = useRef<HTMLDivElement>(null)
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><DocumentOverlayPortal component={Dialog.Portal}>
    <Dialog.Overlay className="dialog-scrim" />
    <Dialog.Content ref={content} className="dialog-surface mote-connection-dialog" onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() }}
      onCloseAutoFocus={event => { event.preventDefault(); const active = ownerDocument.activeElement, node = returnFocus();
        if (node?.isConnected && (active === ownerDocument.body || !active?.isConnected || content.current?.contains(active))) node.focus({ preventScroll: true }) }}>
      <header className="mote-connection-dialog__header"><div><Dialog.Title>Bot for {moteName}</Dialog.Title>
        <Dialog.Description>New group chats use this bot. Existing groups keep their bot.</Dialog.Description></div>
        <Dialog.Close asChild><button type="button" className="icon-button" aria-label="Close bot choice"><CloseIcon size={16} /></button></Dialog.Close>
      </header>
      <MoteConnectionPanel target={target} topicId={topicId} moteName={moteName} onRead={onRead} onSaved={onClose} />
    </Dialog.Content>
  </DocumentOverlayPortal></Dialog.Root>
}

/** The same original preference and operation window in Settings and the Mote dialog. */
export function MoteConnectionPanel({ target, topicId, moteName, onRead, onSaved, createOnOpen = false, inSettings = false, onCreateIntentConsumed, onManageConnection, onContinueSetup }: {
  target: MotePreferencesTarget | null; topicId: string; moteName: string; onRead(value: Snapshot): void; onSaved?(): void; createOnOpen?: boolean; inSettings?: boolean; onCreateIntentConsumed?: (() => void) | undefined; onManageConnection?: ((record: ConnectionRecord) => void) | undefined; onContinueSetup?: ((record: ConnectionRecord, source: ConnectionSetupEnrollmentSource) => void) | undefined
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [selection, setSelection] = useState(''), fieldId = useId()
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [issue, setIssue] = useState('')
  const [attempt, setAttempt] = useState<{ input: MoteConnectionPreferencesSaveParams; receipt: MoteConnectionPreferencesSaveResult | null } | null>(null)
  const intents = useAppStore(state => state.moteConnectionSaveIntents)
  const retained = Object.values(intents).filter(item => target && sameMotePreferencesTarget(item.input.target, target))
  const [choosing, setChoosing] = useState(false)
  const [reviewed, setReviewed] = useState(false), [newChoice, setNewChoice] = useState(false)
  const edited = useRef(false), alive = useRef<object | null>(null), flight = useRef(false), readEpoch = useRef(0)
  const identityOptions = useRef<HTMLDetailsElement>(null)
  const choose = () => { setChoosing(true); if (identityOptions.current) identityOptions.current.open = true }
  const settings = useContext(SettingsNavigation)
  useEffect(() => { const token = {}; alive.current = token; void refresh(); return () => { if (alive.current === token) { alive.current = null; readEpoch.current++ } } }, [])
  async function refresh() {
    if (!target) { setIssue('This Mote’s original home is unconfirmed. Its files and discussions are kept; reopen it after refreshing the directory.'); return }
    const token = alive.current, epoch = ++readEpoch.current
    setLoading(true)
    try {
      const value = await read(target)
      if (!token || alive.current !== token || readEpoch.current !== epoch) return
      setSnapshot(value); onRead(value)
      if (!edited.current) setSelection(value.saved.values?.connection ? choiceKey(value.saved.values.connection) : '')
      if (!flight.current) setReviewed(value.saved.status === 'ready')
      setIssue(value.saved.issue ?? (value.saved.values?.connection ? '' : value.connectionIssue) ?? '')
    } catch (error) { if (alive.current === token && readEpoch.current === epoch) setIssue(presentError(error)) }
    finally { if (alive.current === token && readEpoch.current === epoch) setLoading(false) }
  }
  async function save(value = selection) {
    if (!target || !snapshot || flight.current || pending) return
    const baseline = moteConnectionBaseline(snapshot.saved), chosen = snapshot.connections.find(item => choiceKey(item.config) === value)
    if (!baseline) { setIssue('Read this Mote’s current choice before saving. Your selection is kept.'); return }
    if (value && !chosen?.config.enabled) { setIssue('Choose an available bot or update this bot in settings.'); return }
    const input: MoteConnectionPreferencesSaveParams = { kind: 'connection', target, operationId: crypto.randomUUID(), baseline,
      values: { connection: chosen ? { connectionId: chosen.config.connectionId, application: structuredClone(chosen.config.application) } : null } }
    const token = alive.current, epoch = ++readEpoch.current
    let dispatched = false
    edited.current = true; flight.current = true; setLoading(false); setBusy(true); setIssue(''); setReviewed(false); setNewChoice(false); setAttempt({ input, receipt: null })
    try {
      const retained = await retainMoteConnectionSaveIntent({ input, phase: 'not-dispatched' })
      if (!retained.localStorageWritten) throw new Error('The original save input could not be retained. No request was sent.')
      const dispatch = await retainMoteConnectionSaveIntent({ input, phase: 'may-have-dispatched' })
      if (!dispatch.localStorageWritten) {
        await retainMoteConnectionSaveIntent({ input, phase: 'not-dispatched' })
        throw new Error('The original dispatch input could not be retained. No request was sent.')
      }
      dispatched = true
      const result = parseMotePreferencesSaveResult(await api.motePreferences.save(input), input)
      if (result.status !== 'unconfirmed') await clearMoteConnectionSaveIntent(input.operationId)
      if (!token || alive.current !== token) return
      setAttempt({ input, receipt: result })
      if (result.status === 'saved' || result.status === 'unchanged') {
        const current = parseMotePreferencesReadResult({ kind: 'connection', target, status: 'ready',
          source: { resource: result.source!.resource, result: { status: 'read', document: result.source!.document! } }, values: result.source!.values, issue: null }, { kind: 'connection', target })
        // A later explicit read may already have observed another file revision.
        if (readEpoch.current === epoch) { onRead({ ...snapshot, saved: current }); setSnapshot({ ...snapshot, saved: current }); setSelection(value); setChoosing(false); setAttempt(null); onSaved?.() }
        else { setIssue('This choice was saved. The current choice is shown separately.'); void refresh() }
      } else setIssue(result.message ?? 'This choice was not confirmed. Your original save request is kept.')
    } catch (error) { if (alive.current === token) {
      if (!dispatched) setAttempt(null)
      setIssue((dispatched ? 'The save result is unconfirmed. Check the current choice before deciding another save. ' : '') + presentError(error))
    } }
    finally { flight.current = false; if (alive.current === token) setBusy(false) }
  }
  const pending = !!attempt && (!attempt.receipt || attempt.receipt.status === 'unconfirmed') || !newChoice && retained.some(item => item.phase === 'may-have-dispatched')
  const current = snapshot?.saved.values?.connection
  const currentChoice = current && snapshot && !snapshot.connectionIssue ? moteConnectionChoice(current, snapshot.connections) : null
  const savedBotIssue = current ? snapshot?.connectionIssue ?? currentChoice?.issue : null
  useEffect(() => { if ((pending || issue || savedBotIssue) && identityOptions.current) identityOptions.current.open = true }, [pending, issue, savedBotIssue])
  return <div className="mote-connection-panel" data-mote-identity-panel={topicId}>
        <div className="mote-connection-dialog__body">
          {current && savedBotIssue ? <section className="mote-bot-saved-issue" aria-label="Saved bot needs attention"><strong>Saved bot · {current.application.domain}</strong><code>{current.application.appId}</code><p role="status">{savedBotIssue}</p><button type="button" className="small-button" onClick={choose}>Review saved bot</button></section> : null}
          <MoteBotSetup target={target} topicId={topicId} record={currentChoice?.record ?? null} hasSavedBot={!!current} onChoose={choose} onCurrent={() => void refresh()}
            createOnOpen={createOnOpen} onCreateIntentConsumed={onCreateIntentConsumed} onContinue={onContinueSetup ?? (settings ? (record, source) => {
              onSaved?.()
              settings.openMoteConnector({ target, topicId, moteName, setup: { connectionId: record.config.connectionId, source } })
            } : undefined)} />
          <details ref={identityOptions} className="mote-identity-options"><summary>Identity options</summary>
          {snapshot ? <details className="mote-bot-existing" open={choosing} onToggle={event => setChoosing(event.currentTarget.open)}><summary>Choose a saved bot</summary><label htmlFor={fieldId}>Chat bot</label><SelectionField id={fieldId} label="Mote chat bot" value={selection} menuClassName="mote-connection-dialog__choices"
            disabled={busy} onValueChange={value => { edited.current = true; setSelection(value) }}
            options={[{ value: '', label: 'No default bot' }, ...snapshot.connections.map(item => ({ value: choiceKey(item.config), label: item.config.label,
              disabled: !item.config.enabled, description: item.config.application.domain + ' · ' + item.config.application.appId }))]} />
            {current ? <p className="mote-details__hint">Saved bot: {current.application.domain} · {current.application.appId}</p> : null}</details> : null}
          {loading ? <p role="status" className="mote-details__hint">Reading saved bots…</p> : null}
          {issue ? <p role="status" className="mote-details__issue">{issue}</p> : null}
          {pending ? <p className="mote-details__hint">The previous save is still unconfirmed. Reading the current choice does not confirm that save.</p> : null}
          <div className="mote-connection-dialog__secondary">
            <button type="button" className="small-button" onClick={() => void refresh()} disabled={loading}>Check current choice</button>
            {pending && reviewed && !busy ? <button type="button" className="small-button" onClick={() => { setAttempt(null); setNewChoice(true); edited.current = true }}>Use current revision for a new choice</button> : null}
            {!inSettings && settings ? <button type="button" className="small-button" onClick={() => { onSaved?.(); settings.openMoteConnector({ target, topicId, moteName }) }}>Manage bots</button> : null}
          </div>
          {retained.length ? <details className="mote-connection-dialog__requests"><summary>Retained save requests</summary>
            {retained.map(({ input, phase }) => <p key={input.operationId}><code>{input.operationId}</code><br />{input.values.connection?.application.appId ?? 'Remove default bot'} · {phase === 'not-dispatched' ? 'Not sent' : 'Result unconfirmed'}</p>)}
          </details> : null}
          </details>
          {current ? <div className="mote-identity-management"><div className="mote-bot-actions">{currentChoice?.record && onManageConnection ? <button type="button" className="small-button" onClick={() => onManageConnection(currentChoice.record!)}>Manage bot application</button> : null}<button type="button" className="small-button" data-mote-identity-unbind disabled={busy || pending || snapshot?.saved.status !== 'ready'} onClick={() => void save('')}>Unbind identity</button></div><p className="mote-details__hint">Unbinding removes this Mote’s default identity. The bot and existing groups are kept.</p></div> : null}
        </div>
        {choosing || pending || attempt ? <footer className="mote-connection-dialog__footer">
          <button type="button" className="primary-button" onClick={() => void save()} disabled={busy || pending || !snapshot || snapshot.saved.status !== 'ready'}>{busy ? 'Saving choice…' : 'Use this bot'}</button>
        </footer> : null}
  </div>
}
