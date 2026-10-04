import { ComposerTextarea } from '@agentmux/client-ui/input'
import { useEffect, useRef, useState } from 'react'
import { Clock3, Pencil, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { FileDocument } from '@agentmux/core'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { prepareMoteIdeaDraft, prepareMoteIdeaSchedule, stageMoteIdeaFeedback, type MoteIdeaFeedback } from '../lib/mote-idea-request'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useLauncherState, type MoteIdeaDraft } from '../lib/launcher-state'
import { CalendarScheduleControl } from './CalendarScheduleControl'
import '../styles/mote-idea-controls.css'

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
  const [arrangement, setArrangement] = useState<Awaited<ReturnType<typeof prepareMoteIdeaSchedule>> | null>(null)
  const arranged = useRef<HTMLDivElement>(null)
  const request = useRef<HTMLDetailsElement>(null)
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
  async function prepareArrangement() {
    if (arrangement) { arranged.current?.querySelector<HTMLElement>('summary')?.focus(); return }
    if (pending) return
    const { input: capturedInput, material: capturedMaterial, reference: capturedReference } = current.current
    setPending(true); setIssue(null); setStatus(null)
    const stillCurrent = () => alive.current && current.current.input === capturedInput && current.current.material === capturedMaterial &&
      (current.current.reference === capturedReference || !!capturedReference && sameWorkbenchProjectionSelection(current.current.reference ?? null, capturedReference))
    try {
      const prepared = await prepareMoteIdeaSchedule(scope, capturedReference, capturedInput, capturedMaterial, stillCurrent)
      if (!stillCurrent()) throw new Error('Your later direction or selected source changed. Your inputs are kept; prepare the current request again.')
      setArrangement(prepared)
      if (request.current) request.current.open = false
    } catch (error) { if (alive.current) setIssue(presentError(error)) }
    finally { if (alive.current) setPending(false) }
  }
  return <>
    <details ref={request} className="mote-details__idea-request"><summary>Find a worthwhile idea</summary>
      <div className="mote-details__cooperation">
        <label>Your direction<ComposerTextarea aria-label="Idea direction" rows={3} placeholder="What would be useful to explore next?" value={input.direction}
          onValueChange={value => update({ ...input, direction: value })} /></label>
        <label className="mote-details__check"><input type="checkbox" checked={input.includeDiscussion} aria-label="Include exact discussion and linked Goals"
          onChange={event => update({ ...input, includeDiscussion: event.target.checked })} />Include this exact discussion and linked Goals</label>
        <p className="mote-details__hint">Uses the saved profile and selected note. Optionally include this discussion and its Goals.</p>
        <div className="mote-idea-controls__actions"><button type="button" className="icon-button" aria-label="Prepare idea request" title="Prepare idea request" disabled={pending || !input.direction.trim()} onClick={() => {
          if (pending) { setIssue('A context read is in progress. Your current inputs are kept.'); return }
          const { input: capturedInput, material: capturedMaterial, reference: capturedReference } = current.current
          finish(prepareMoteIdeaDraft(scope, reference, input, material, () => alive.current && current.current.input === capturedInput && current.current.material === capturedMaterial &&
            (current.current.reference === capturedReference || !!capturedReference && sameWorkbenchProjectionSelection(current.current.reference ?? null, capturedReference))),
            'Request prepared in a new Launcher. Review it, choose the Agent and model, then Start.')
        }}><Sparkles size={16} /></button><button type="button" className="icon-button" aria-label={arrangement ? 'Review sourced idea arrangement' : 'Arrange sourced ideas'} title={arrangement ? 'Review sourced idea arrangement' : 'Arrange sourced ideas'} disabled={pending || !input.direction.trim()} onClick={() => void prepareArrangement()}><Clock3 size={16} /></button><span>{pending ? 'Reading selected sources…' : 'One request, or an arrangement you choose.'}</span></div>
      </div>
    </details>
    {arrangement ? <div ref={arranged} className="mote-idea-controls__arrangement">
      <p className="mote-details__hint">Prepared sources · {arrangement.sources.length ? arrangement.sources.map(source => source.path.split('/').at(-1)).join(' · ') : 'No saved source confirmed'}</p>
      <CalendarScheduleControl target={arrangement.target} initialMessage={arrangement.message} initialMessageContext={arrangement.frozenContext}
        onMessageChange={direction => update({ ...current.current.input, direction })} />
    </div> : null}
    {material ? <details className="mote-details__idea-feedback"><summary>Tell Mote what helps</summary>
      <div className="mote-details__cooperation">
        <p className="mote-details__hint mote-details__source" title={material.revision}>Feedback on {material.path.split('/').at(-1)} · this saved revision</p>
        <div className="mote-idea-controls__actions" role="group" aria-label="Idea feedback response"><button type="button" className="icon-button" aria-label="Useful" title="Useful" aria-pressed={feedback.vote === 'useful'} onClick={() => updateFeedback({ ...feedback, vote: feedback.vote === 'useful' ? '' : 'useful' })}><ThumbsUp size={16} /></button><button type="button" className="icon-button" aria-label="Less useful" title="Less useful" aria-pressed={feedback.vote === 'less-useful'} onClick={() => updateFeedback({ ...feedback, vote: feedback.vote === 'less-useful' ? '' : 'less-useful' })}><ThumbsDown size={16} /></button></div>
        <label>Your feedback<ComposerTextarea aria-label="Idea feedback comment" rows={2} value={feedback.comment} onValueChange={value => updateFeedback({ ...feedback, comment: value })} /></label>
        <button type="button" className="icon-button" aria-label="Review feedback in SOUL" title="Review feedback in SOUL" onClick={() => {
          if (pending) { setIssue('The current action is still in progress. Your feedback is kept.'); return }
          const { input: capturedInput, material: capturedMaterial } = current.current
          finish(stageMoteIdeaFeedback(scope, material, feedback, onOpenPath, () => alive.current && current.current.input === capturedInput && current.current.material === capturedMaterial),
            'Feedback staged in the original SOUL. Review it and Save to use it in new Sessions.')
        }}><Pencil size={16} /></button>
        <p className="mote-details__hint">Keeps the original SOUL text and this note. Correct facts through the note's original editor.</p>
      </div>
    </details> : null}
    {status ? <p role="status" className="mote-details__hint">{status}</p> : null}
    {issue ? <p role="status" className="mote-details__issue">{issue}</p> : null}
    {persistenceIssue ? <p role="status" className="mote-details__issue">{persistenceIssue}</p> : null}
  </>
}
