import { useEffect, useRef, useState } from 'react'
import type { FileDocument } from '@agentmux/core'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { prepareMoteIdeaDraft, stageMoteIdeaFeedback, type MoteIdeaFeedback } from '../lib/mote-idea-request'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useLauncherState, type MoteIdeaDraft } from '../lib/launcher-state'

const EMPTY_IDEA_DRAFT: MoteIdeaDraft = { direction: '', includeDiscussion: false, feedback: {} }
/** Unsent view inputs use the original Launcher presentation owner, never a suggestion feed. */
export function MoteIdeaControls({ scope, reference, material, onOpenPath }: {
  scope: MoteWorkfaceScope; reference: WorkbenchProjectionSelection | null | undefined; material: FileDocument | null
  onOpenPath(path: string): Promise<unknown>
}) {
  const key = 'mote-idea:' + JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.topic.directoryPath, scope.rootPath])
  const input = useLauncherState(state => state.drafts[key]?.moteIdea ?? EMPTY_IDEA_DRAFT)
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const [pending, setPending] = useState(false), [issue, setIssue] = useState<string | null>(null), [status, setStatus] = useState<string | null>(null)
  const alive = useRef(true), current = useRef({ input, material, reference }); current.current = { input, material, reference }
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const update = (next: MoteIdeaDraft) => { useLauncherState.getState().setMoteIdeaDraft(key, next); current.current.input = next }
  const materialKey = material ? JSON.stringify([material.path, material.revision]) : ''
  const feedback = input.feedback[materialKey] ?? { vote: '', comment: '' }
  const updateFeedback = (next: MoteIdeaFeedback) => update({ ...input, feedback: { ...input.feedback, [materialKey]: next } })
  const finish = (promise: Promise<unknown>, success: string) => {
    setIssue(null); setStatus(null); setPending(true)
    void promise.then(() => { if (alive.current) setStatus(success) }).catch(error => { if (alive.current) setIssue(presentError(error)) })
      .finally(() => { if (alive.current) setPending(false) })
  }
  return <>
    <details className="mote-details__idea-request"><summary>Find a worthwhile idea</summary>
      <div className="mote-details__cooperation">
        <label>Your direction<textarea aria-label="Idea direction" rows={3} placeholder="What would be useful to explore next?" value={input.direction}
          onChange={event => update({ ...input, direction: event.target.value })} /></label>
        <label className="mote-details__check"><input type="checkbox" checked={input.includeDiscussion} aria-label="Include exact discussion and linked Goals"
          onChange={event => update({ ...input, includeDiscussion: event.target.checked })} />Include this exact discussion and linked Goals</label>
        <p className="mote-details__hint">Uses the saved profile and selected note. Optionally include this discussion and its Goals.</p>
        <button type="button" className="small-button" onClick={() => {
          if (pending) { setIssue('A context read is in progress. Your current inputs are kept.'); return }
          const { input: capturedInput, material: capturedMaterial, reference: capturedReference } = current.current
          finish(prepareMoteIdeaDraft(scope, reference, input, material, () => alive.current && current.current.input === capturedInput && current.current.material === capturedMaterial &&
            (current.current.reference === capturedReference || !!capturedReference && sameWorkbenchProjectionSelection(current.current.reference ?? null, capturedReference))),
            'Request prepared in a new Launcher. Review it, choose the Agent and model, then Start.')
        }}>{pending ? 'Reading selected context…' : 'Prepare idea request'}</button>
        <p className="mote-details__hint">Review and edit the prepared request in a new discussion before starting.</p>
      </div>
    </details>
    {material ? <details className="mote-details__idea-feedback"><summary>Tell Mote what helps</summary>
      <div className="mote-details__cooperation">
        <p className="mote-details__hint mote-details__source" title={material.revision}>Feedback on {material.path.split('/').at(-1)} · this saved revision</p>
        <label>Response<select aria-label="Idea feedback response" value={feedback.vote} onChange={event => updateFeedback({ ...feedback, vote: event.target.value as MoteIdeaFeedback['vote'] })}>
          <option value="">Write a comment or choose a response</option><option value="useful">Useful</option><option value="less-useful">Less useful</option></select></label>
        <label>Your feedback<textarea aria-label="Idea feedback comment" rows={2} value={feedback.comment} onChange={event => updateFeedback({ ...feedback, comment: event.target.value })} /></label>
        <button type="button" className="small-button" onClick={() => {
          if (pending) { setIssue('The current action is still in progress. Your feedback is kept.'); return }
          const { input: capturedInput, material: capturedMaterial } = current.current
          finish(stageMoteIdeaFeedback(scope, material, feedback, onOpenPath, () => alive.current && current.current.input === capturedInput && current.current.material === capturedMaterial),
            'Feedback staged in the original SOUL. Review it and Save to use it in new Sessions.')
        }}>Review feedback in SOUL</button>
        <p className="mote-details__hint">Keeps the original SOUL text and this note. Correct facts through the note's original editor.</p>
      </div>
    </details> : null}
    {status ? <p role="status" className="mote-details__hint">{status}</p> : null}
    {issue ? <p role="status" className="mote-details__issue">{issue}</p> : null}
    {persistenceIssue ? <p role="status" className="mote-details__issue">{persistenceIssue}</p> : null}
  </>
}
