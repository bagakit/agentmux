import { useLayoutEffect, useRef, useState } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { SCRATCH_TOPIC_TITLE_MAX_LENGTH } from '@agentmux/host/mote-model'
import { Button } from '@agentmux/client-ui/components/Button'
import { readMoteMaterial, saveMoteFile } from '../lib/mote-cooperation'
import { confirmedMoteReference, emptyMoteDestination, openMoteMaterialAt } from '../lib/mote-materials-actions'
import { useLauncherState, type MoteProfileDraft } from '../lib/launcher-state'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { fileNavigationSelection, useAppStore } from '../store'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import '../styles/mote-profile-dialog.css'

/** Split only the first title line; all other original Markdown stays editable and intact. */
function fields(content: string) {
  const heading = /^#[^\S\r\n]+([^\r\n]*)(?:\r?\n|$)/m.exec(content)
  const prefix = heading ? content.slice(0, heading.index) : ''
  const remainder = heading ? content.slice(heading.index + heading[0].length) : content
  const blank = /^(?:\r?\n)/.exec(remainder)?.[0] ?? ''
  return { name: heading?.[1]?.trim() ?? '', prefix, heading: heading?.[0] ?? '', blank,
    body: remainder.slice(blank.length), newline: content.includes('\r\n') ? '\r\n' : '\n' }
}
function contentFor(draft: MoteProfileDraft) {
  const original = fields(draft.source.content)
  const heading = draft.name.trim() === original.name ? original.heading : '# ' + draft.name.trim() + original.newline
  return original.prefix + heading + (original.heading ? original.blank : original.newline) + draft.body
}

/** A persisted user form over the original Files/Editor CAS writer, opened without navigation. */
export function MoteProfileDialog({ scope, reference, onOpenPath, onClose, returnFocus }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined
  onOpenPath(path: string): Promise<unknown>
  onClose(): void; returnFocus(): HTMLElement | null
}) {
  const ownerDocument = useWorkbenchDocument(), content = useRef<HTMLDivElement>(null)
  const key = 'mote-profile:' + JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.rootPath])
  const retained = useLauncherState(state => state.drafts[key]?.moteProfile)
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const [draft, setDraft] = useState<MoteProfileDraft | null>(retained ?? null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [issue, setIssue] = useState(''), [attempt, setAttempt] = useState(0)
  const latest = useRef(draft); latest.current = draft
  const lifetime = useRef({}), controller = useRef<AbortController | null>(null)
  const path = scope.rootPath + '/topic.md'
  function update(next: MoteProfileDraft) {
    latest.current = next; setDraft(next); useLauncherState.getState().setMoteProfileDraft(key, next)
  }
  useLayoutEffect(() => {
    const epoch = {}; lifetime.current = epoch
    setLoading(true); setIssue('')
    void readMoteMaterial(scope, path).then(read => {
      if (lifetime.current !== epoch) return
      if (read.result.status !== 'read') throw new Error('The saved profile could not be read. Your draft is kept; reread the original profile.')
      const source = read.result.document, current = latest.current
      if (!current) { const parsed = fields(source.content); const value = { source, name: parsed.name || scope.topic.title, body: parsed.body }; latest.current = value; setDraft(value) }
      else if (source.revision !== current.source.revision || source.content !== current.source.content)
        setIssue('The saved profile changed. Your draft is kept; review the original file before saving.')
    }).catch(cause => { if (lifetime.current === epoch) setIssue(presentError(cause)) })
      .finally(() => { if (lifetime.current === epoch) setLoading(false) })
    return () => { lifetime.current = {}; controller.current?.abort() }
  }, [key, attempt])
  async function save() {
    const submitted = latest.current
    if (!submitted || busy) return
    if (!submitted.name.trim() || /[\r\n]/.test(submitted.name) || submitted.name.trim().length > SCRATCH_TOPIC_TITLE_MAX_LENGTH) {
      setIssue(`Enter a one-line name of up to ${SCRATCH_TOPIC_TITLE_MAX_LENGTH} characters.`); return
    }
    const epoch = lifetime.current, navigation = fileNavigationSelection(useAppStore.getState())
    let moved = false
    const unsubscribe = useAppStore.subscribe(state => { if (fileNavigationSelection(state) !== navigation) moved = true })
    const current = () => lifetime.current === epoch && latest.current === submitted && !moved
    const abort = new AbortController(); controller.current = abort
    setBusy(true); setIssue('')
    try {
      const state = useAppStore.getState(), original = confirmedMoteReference(state, scope, { reference })
      const destination = original ?? emptyMoteDestination(state, scope, { reference })
      if (!destination) throw new Error('The original Mote location is unconfirmed. Your profile draft is kept; reopen it from its original Mote.')
      await saveMoteFile(scope, path, submitted.source, contentFor(submitted), async requested =>
        (await openMoteMaterialAt(scope, requested, original, destination, abort.signal))?.reference, current, destination)
      await useAppStore.getState().refreshScratchTopics(scope.workspace.id, true, scope.topic.id)
      if (current() && useLauncherState.getState().setMoteProfileDraft(key, undefined)) onClose()
    } catch (cause) { if (lifetime.current === epoch) setIssue(presentError(cause)) }
    finally { unsubscribe(); if (lifetime.current === epoch) setBusy(false) }
  }
  async function useSaved() {
    const epoch = lifetime.current, previous = latest.current
    try {
      const read = await readMoteMaterial(scope, path)
      if (lifetime.current !== epoch || latest.current !== previous) return
      if (read.result.status !== 'read') throw new Error('The saved profile is still unconfirmed. Your draft is kept.')
      const source = read.result.document, parsed = fields(source.content)
      update({ source, name: parsed.name || scope.topic.title, body: parsed.body }); setIssue('')
    } catch (cause) { if (lifetime.current === epoch) setIssue(presentError(cause)) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><DocumentOverlayPortal component={Dialog.Portal}>
    <Dialog.Overlay className="dialog-scrim mote-behavior-overlay" />
    <Dialog.Content ref={content} className="dialog-surface mote-profile-dialog" aria-busy={busy}
      onOpenAutoFocus={event => { event.preventDefault(); content.current?.querySelector<HTMLInputElement>('input')?.focus() }}
      onCloseAutoFocus={event => { event.preventDefault(); const node = returnFocus(), active = ownerDocument.activeElement
        if (node?.isConnected && (active === ownerDocument.body || !active?.isConnected || content.current?.contains(active))) node.focus({ preventScroll: true }) }}>
      <header className="mote-behavior-header"><div><Dialog.Title>Edit profile</Dialog.Title><Dialog.Description>Introduce your Mote and what you’ll work on together.</Dialog.Description></div></header>
      <form onSubmit={event => { event.preventDefault(); void save() }}>
        <div className="mote-profile-dialog__body">
          <label>Name<TextInput aria-label="Mote name" value={draft?.name ?? ''} disabled={!draft} maxLength={SCRATCH_TOPIC_TITLE_MAX_LENGTH}
            onChange={event => { if (latest.current) update({ ...latest.current, name: event.target.value }) }} /></label>
          <label>About & working notes<textarea aria-label="Mote profile and working notes" value={draft?.body ?? ''} disabled={!draft} rows={8}
            onChange={event => { if (latest.current) update({ ...latest.current, body: event.target.value }) }} /></label>
          <p className="mote-details__hint">Describe its role, shared context and working notes. Markdown is welcome.</p>
          {loading ? <p role="status" className="mote-details__hint">Reading saved profile…</p> : null}
          {issue ? <div role="status" className="mote-details__issue">{issue} <Button type="button" onClick={() => setAttempt(value => value + 1)}>Reread</Button>
            <Button type="button" onClick={() => void useSaved()}>Discard draft & reload</Button>
            <Button type="button" onClick={() => void onOpenPath(path).then(opened => { if (opened) onClose() }).catch(cause => setIssue(presentError(cause)))}>Open original file</Button></div> : null}
          {persistenceIssue ? <p role="status" className="mote-details__issue">{persistenceIssue}</p> : null}
        </div>
        <footer className="mote-quick-mode-dialog__footer"><span>Your draft is kept when you close.</span><Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={loading || busy || !draft}>{busy ? 'Saving…' : 'Save profile'}</Button></footer>
      </form>
    </Dialog.Content>
  </DocumentOverlayPortal></Dialog.Root>
}
