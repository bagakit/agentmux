import { ComposerTextarea } from '@agentmux/client-ui/input'
import * as Dialog from '@radix-ui/react-dialog'
import { DEFAULT_NOTEBOOK_ID } from '@agentmux/core/notebook-catalog'
import { useEffect, useRef, useState } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { fileNavigationSelection, useAppStore } from '../store'
import { EMPTY_LAUNCHER_DRAFT, useLauncherState } from '../lib/launcher-state'
import { refreshNotebookLibrary, useNotebookLibrary } from '../lib/notebook-library'
import { openNotebookPage } from '../lib/recall-notebooks'
import { saveSurveyToRecall, type SurveyRecallCapture as CaptureTarget } from '../lib/survey-recall-capture'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** A result destination, separate from Survey's browser navigation and Recall's directory. */
export function SurveyRecallCapture({ target, onClose }: { target: CaptureTarget | null; onClose(): void }) {
  const library = useNotebookLibrary(state => state.state)
  const libraryIssue = useNotebookLibrary(state => state.issue)
  const draft = useLauncherState(state => target ? state.drafts[target.draftId] ?? EMPTY_LAUNCHER_DRAFT : EMPTY_LAUNCHER_DRAFT)
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const receipt = draft.noteCreation
  const [notebookId, setNotebookId] = useState(DEFAULT_NOTEBOOK_ID)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const current = useRef(target); current.current = target
  const source = receipt?.notebook?.source ?? target?.source
  useEffect(() => {
    if (!target) return
    setError(null)
    const original = useLauncherState.getState().drafts[target.draftId]
    setNotebookId(original?.noteCreation?.notebook?.notebookId ?? DEFAULT_NOTEBOOK_ID)
    if (!original) useLauncherState.getState().setDraft(target.draftId, 'note', target.source.title ?? '')
    void refreshNotebookLibrary().catch(() => {})
  }, [target])

  async function save() {
    if (!target || busy) return
    const captured = target
    setBusy(true); setError(null)
    try {
      const result = await saveSurveyToRecall(captured, notebookId, draft.note)
      if (current.current === captured && result.issue) setError(result.issue)
    } catch (cause) { if (current.current === captured) setError(presentError(cause)) }
    finally { setBusy(false) }
  }
  async function openSaved() {
    if (!receipt?.notebookRegistered || busy) return
    const captured = target, navigation = fileNavigationSelection(useAppStore.getState())
    setBusy(true); setError(null)
    try {
      const saved = await refreshNotebookLibrary(), page = saved.pages[receipt.noteId]
      if (!page) throw new Error('The saved page is not confirmed in its Notebook. Your file and capture receipt are kept; check this same page again.')
      if (current.current !== captured || fileNavigationSelection(useAppStore.getState()) !== navigation) return
      const state = useAppStore.getState()
      state.setRecallNotebook(page.notebookId, page.noteId); state.setMainSurface('recall')
      if (await openNotebookPage(page)) onClose()
    } catch (cause) { setError(presentError(cause)) }
    finally { setBusy(false) }
  }
  function anotherFinding() {
    if (!target || !saved || !receipt) return
    try {
      useLauncherState.setState(state => {
        const original = state.drafts[target.draftId] ?? EMPTY_LAUNCHER_DRAFT
        const { noteCreation: _saved, ...retained } = original
        return { drafts: { ...state.drafts, [target.draftId]: { ...retained, note: original.note === receipt.draft ? '' : original.note } } }
      })
      setError(null)
    } catch (cause) { setError(presentError(cause) + ' The saved page and current draft are kept.') }
  }
  const saved = receipt?.status === 'written' && receipt.notebookRegistered
  return <Dialog.Root open={Boolean(target)} onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}><Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="confirmation-dialog dialog-surface topic-dialog survey-recall-capture"
        onEscapeKeyDown={event => { if (busy || isImeOwnedKeyboardEvent(event)) event.preventDefault() }}
        onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <Dialog.Title className="confirmation-dialog__title">Save to Recall</Dialog.Title>
        <Dialog.Description className="confirmation-dialog__description">Keep a finding with its source. Your browser stays here.</Dialog.Description>
        <label>Notebook<select aria-label="Recall destination notebook" value={receipt?.notebook?.notebookId ?? notebookId} disabled={busy || Boolean(receipt)} onChange={event => setNotebookId(event.target.value)}>
          {Object.values(library?.notebooks ?? {}).map(book => <option key={book.notebookId} value={book.notebookId}>{book.name}</option>)}
        </select></label>
        <label>Finding<ComposerTextarea aria-label="Recall finding" value={draft.note} rows={6} placeholder="What do you want to remember?"
          onValueChange={value => { if (target) useLauncherState.getState().setDraft(target.draftId, 'note', value) }} /></label>
        {source ? <details className="topic-knowledge-sources"><summary>{source.title || 'Original source'}</summary><p>{source.url}</p></details> : null}
        {saved ? <p role="status" className="survey-relation-notice">Saved to {library?.notebooks[receipt.notebook?.notebookId ?? '']?.name ?? 'Recall'}.
          {draft.note !== receipt.draft ? ' Your newer input is still kept as a draft.' : ''}</p> : null}
        {error || receipt?.notebookIssue || libraryIssue || persistenceIssue ? <p role="status" className="surface-inline-error">{error ?? receipt?.notebookIssue ?? libraryIssue ?? persistenceIssue}</p> : null}
        <footer><button type="button" className="small-button" disabled={busy} onClick={onClose}>{saved ? 'Done' : 'Cancel'}</button>
          {saved ? <button type="button" className="small-button" disabled={busy} onClick={anotherFinding}>Another finding</button> : null}
          {saved ? <button type="button" className="primary-button" disabled={busy} onClick={() => void openSaved()}>Open in Recall</button>
            : <button type="button" className="primary-button" disabled={busy || !library || !notebookId || (!receipt && !draft.note.trim())} onClick={() => void save()}>
              {busy ? 'Saving…' : receipt?.status === 'unknown' || receipt?.status === 'pending' ? 'Check this save' : receipt ? 'Continue this save' : 'Save finding'}</button>}
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
