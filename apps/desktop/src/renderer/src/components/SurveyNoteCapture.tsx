import { InlineComposer } from '@agentmux/client-ui/components/InlineComposer'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { EMPTY_LAUNCHER_DRAFT, useLauncherState } from '../lib/launcher-state'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'

const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')


/** A shortcut to the original Note draft; the resource/file/block owners remain unchanged. */
export function SurveyNoteCapture({ reference, busy, onSave, onClose }: {
  reference: WorkbenchProjectionSelection
  busy: boolean
  onSave(content: string, launcherId: string): void
  onClose(): void
}) {
  const launcherId = `region:${reference.regionId}`
  const draft = useLauncherState(state => state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT)
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const setDraft = useLauncherState(state => state.setDraft)
  return <section className="survey-note-capture" aria-label="Note alongside this page">
    <header><strong>Quick note</strong><button type="button" className="survey-icon-button" aria-label="Close note draft" title="Keep draft and close" onClick={onClose}><ThemeActionCloseIcon size={14} /></button></header>
    <div className="composer survey-note-capture__input"><InlineComposer key={launcherId} aria-label="Survey note draft" value={draft.note}
      onValueChange={value => setDraft(launcherId, 'note', value)} disabled={false} autoFocus placeholder="Capture a thought…"
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing && !busy) { event.preventDefault(); onSave(draft.note, launcherId) } }} /></div>
    <footer><button type="button" className="small-button survey-note-capture__save" aria-label={busy ? 'Saving note' : 'Save & open note'} title="Save and open note (⌘ / Ctrl + Enter)" aria-keyshortcuts="Meta+Enter Control+Enter" disabled={busy} onClick={() => onSave(draft.note, launcherId)}>{busy ? 'Saving…' : 'Save & open'}<ThemeActionOpenExternalIcon size={13} /></button></footer>
    {persistenceIssue ? <p className="survey-relation-notice" role="status">{persistenceIssue}</p> : null}
  </section>
}
