import { lazy, Suspense, useState } from 'react'
import { useAppStore } from '../store'
import { documentKey } from '../lib/workbench-tabs'
import { MONACO_THEME_ID } from '../lib/monaco-theme'
import { SelectionField } from './SelectionField'

const Diff = lazy(() => import('./ReadonlyDiffEditor').then(module => ({ default: module.ReadonlyDiffEditor })))

/** Read the same retained three-way conflict; resolution stays in the original file owner. */
export function NoteConflictReview({ tabId, regionId, workspaceId, path, active }: {
  tabId: string; regionId: string; workspaceId: string; path: string; active: boolean
}) {
  const key = documentKey(workspaceId, path), issue = useAppStore(state => state.documentIssues[key])
  const draft = useAppStore(state => state.documents[key]?.content), pending = useAppStore(state => state.documents[key]?.noteEditing?.input)
  const [open, setOpen] = useState(false), [pair, setPair] = useState<'incoming' | 'local' | 'both'>('both')
  if (issue?.kind !== 'changed' || !issue.noteMerge || draft === undefined) return null
  const merge = issue.noteMerge
  const proposed = merge.earlierInput ? merge.proposedContent : draft
  const original = pair === 'both' ? issue.observed.content : merge.baseContent
  const modified = pair === 'incoming' ? issue.observed.content : proposed
  return <details className="note-version-history" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Compare conflicting changes</summary>
    {open && active ? <div className="note-version-history__body">
      <p role="status">{merge.reason}</p>
      {merge.earlierInput ? <p>This comparison shows an earlier conflicting input. Later inputs are kept in the editor and the retained drafts.</p> : null}
      {issue.operationIssue ? <p role="status">{issue.operationIssue.message}</p> : null}
      <p>{merge.observedIsDraft ? 'The newer draft and your editor input are both kept.' : 'The saved file, original baseline and your local draft are all kept.'}</p>
      <SelectionField label="Compare Note versions" value={pair} onValueChange={value => setPair(value as typeof pair)} options={[
        { value: 'both', label: 'Incoming changes → your draft' },
        { value: 'incoming', label: 'Original baseline → incoming changes' },
        { value: 'local', label: 'Original baseline → your draft' }
      ]} />
      <div className="note-version-history__diff"><Suspense fallback={<p role="status">Opening comparison…</p>}>
        <Diff original={original} modified={modified} language="markdown" theme={MONACO_THEME_ID} wordWrap />
      </Suspense></div>
      <div className="note-version-history__heading">
        {pending ? <button type="button" className="note-text-button" onClick={() => void useAppStore.getState().retryNoteInput(tabId, regionId)}>Retry merging input</button> : null}
        <button type="button" className="note-text-button" onClick={() => void useAppStore.getState().reloadDocument(tabId, regionId)}>Use incoming; keep this draft</button>
        <p>Continue editing to resolve the difference, or explicitly overwrite from the file toolbar.</p>
      </div>
    </div> : null}
  </details>
}
