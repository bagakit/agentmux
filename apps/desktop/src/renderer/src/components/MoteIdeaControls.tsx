import { ComposerTextarea } from '@agentmux/client-ui/input'
import { useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FileDocument } from '@agentmux/core'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { prepareMoteIdeaDraft, prepareMoteIdeaSchedule, stageMoteIdeaFeedback, type MoteIdeaFeedback } from '../lib/mote-idea-request'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useLauncherState, type MoteIdeaDraft } from '../lib/launcher-state'
import { CalendarScheduleControl } from './CalendarScheduleControl'
import '../styles/mote-idea-controls.css'

const ThemeObjectIdeaIcon = semanticIconComponent('object.idea')
const ThemeObjectScheduleIcon = semanticIconComponent('object.schedule')
const ThemeActionApproveIcon = semanticIconComponent('action.approve')
const ThemeActionDisapproveIcon = semanticIconComponent('action.disapprove')
const ThemeActionEditIcon = semanticIconComponent('action.edit')


const EMPTY_IDEA_DRAFT: MoteIdeaDraft = { direction: '', includeDiscussion: false, feedback: {} }
const ideaDraftKey = (scope: MoteWorkfaceScope) => 'mote-idea:' + JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.topic.directoryPath, scope.rootPath])
/** Unsent view inputs use the original Launcher presentation owner, never a suggestion feed. */
export function MoteIdeaControls({ scope, reference, material, onOpenPath, active = true }: {
  scope: MoteWorkfaceScope; reference: WorkbenchProjectionSelection | null | undefined; material: FileDocument | null
  onOpenPath(path: string): Promise<unknown>
  active?: boolean
}) {
  const key = ideaDraftKey(scope)
  const input = useLauncherState(state => state.drafts[key]?.moteIdea ?? EMPTY_IDEA_DRAFT)
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const [pending, setPending] = useState(false), [issue, setIssue] = useState<string | null>(null), [status, setStatus] = useState<string | null>(null)
  const arrangement = input.arrangement
  const arranged = useRef<HTMLDivElement>(null)
  const request = useRef<HTMLDetailsElement>(null)
  const lifetime = useRef<object | null>(null), current = useRef({ input, material, reference }); current.current = { input, material, reference }
  // Only preparation belongs to the visible section. The original arrangement
  // and its last confirmed observations stay mounted across section changes.
  useEffect(() => {
    lifetime.current = active ? {} : null
    setPending(false)
    return () => { lifetime.current = null }
  }, [active])
  const update = (next: MoteIdeaDraft) => { useLauncherState.getState().setMoteIdeaDraft(key, next); current.current.input = next }
  const finish = (promise: Promise<unknown>, success: string, epoch: object) => {
    setIssue(null); setStatus(null); setPending(true)
    void promise.then(() => { if (lifetime.current === epoch) setStatus(success) }).catch(error => { if (lifetime.current === epoch) setIssue(presentError(error)) })
      .finally(() => { if (lifetime.current === epoch) setPending(false) })
  }
  async function prepareArrangement() {
    if (arrangement) { arranged.current?.querySelector<HTMLElement>('summary')?.focus(); return }
    const epoch = lifetime.current
    if (pending || !epoch) return
    const { input: capturedInput, material: capturedMaterial, reference: capturedReference } = current.current
    setPending(true); setIssue(null); setStatus(null)
    const stillCurrent = () => lifetime.current === epoch && current.current.input === capturedInput && current.current.material === capturedMaterial &&
      (current.current.reference === capturedReference || !!capturedReference && sameWorkbenchProjectionSelection(current.current.reference ?? null, capturedReference))
    try {
      const prepared = await prepareMoteIdeaSchedule(scope, capturedReference, capturedInput, capturedMaterial, stillCurrent)
      if (!stillCurrent()) throw new Error('Your later direction or selected source changed. Your inputs are kept; prepare the current request again.')
      update({ ...current.current.input, arrangement: prepared })
      if (request.current) request.current.open = false
    } catch (error) { if (lifetime.current === epoch) setIssue(presentError(error)) }
    finally { if (lifetime.current === epoch) setPending(false) }
  }
  return <>
    <details ref={request} className="mote-details__idea-request"><summary>Find a worthwhile idea</summary>
      <div className="mote-details__cooperation">
        <label>Your direction<ComposerTextarea aria-label="Idea direction" rows={3} placeholder="What would be useful to explore next?" value={input.direction}
          onValueChange={value => update({ ...input, direction: value })} /></label>
        <label className="mote-details__check"><input type="checkbox" checked={input.includeDiscussion} aria-label="Include exact discussion and linked Goals"
          onChange={event => update({ ...input, includeDiscussion: event.target.checked })} />Include this exact discussion and linked Goals</label>
        <p className="mote-details__hint">Uses the saved profile and selected note. Optionally include this discussion and its Goals.</p>
        <div className="mote-idea-controls__actions"><button type="button" className="small-button" aria-label="Prepare idea request" disabled={pending || !input.direction.trim()} onClick={() => {
          if (pending) { setIssue('A context read is in progress. Your current inputs are kept.'); return }
          const epoch = lifetime.current
          if (!epoch) return
          const { input: capturedInput, material: capturedMaterial, reference: capturedReference } = current.current
          finish(prepareMoteIdeaDraft(scope, reference, input, material, () => lifetime.current === epoch && current.current.input === capturedInput && current.current.material === capturedMaterial &&
            (current.current.reference === capturedReference || !!capturedReference && sameWorkbenchProjectionSelection(current.current.reference ?? null, capturedReference))),
            'Request prepared in a new Launcher. Review it, choose the Agent and model, then Start.', epoch)
        }}><ThemeObjectIdeaIcon size={14} />Prepare request</button><button type="button" className="small-button" aria-label={arrangement ? 'Review sourced idea arrangement' : 'Arrange sourced ideas'} disabled={pending || !input.direction.trim()} onClick={() => void prepareArrangement()}><ThemeObjectScheduleIcon size={14} />{arrangement ? 'Review arrangement' : 'Arrange ideas'}</button><span>{pending ? 'Reading selected sources…' : 'Review before starting.'}</span></div>
      </div>
    </details>
    {arrangement ? <div ref={arranged} className="mote-idea-controls__arrangement">
      <p className="mote-details__hint">Prepared sources · {arrangement.sources.length ? arrangement.sources.map(source => source.path.split('/').at(-1)).join(' · ') : 'No saved source confirmed'}</p>
      <CalendarScheduleControl target={arrangement.target} initialMessage={arrangement.message} initialMessageContext={arrangement.frozenContext}
        onMessageChange={direction => update({ ...current.current.input, direction })} presented={active} />
    </div> : null}
    {status ? <p role="status" className="mote-details__hint">{status}</p> : null}
    {issue ? <p role="status" className="mote-details__issue">{issue}</p> : null}
    {persistenceIssue ? <p role="status" className="mote-details__issue">{persistenceIssue}</p> : null}
  </>
}

/** Feedback belongs to the exact saved note being read, using the same original draft owner. */
export function MoteIdeaFeedbackControl({ scope, material, onOpenPath }: {
  scope: MoteWorkfaceScope; material: FileDocument; onOpenPath(path: string): Promise<unknown>
}) {
  const key = ideaDraftKey(scope)
  const input = useLauncherState(state => state.drafts[key]?.moteIdea ?? EMPTY_IDEA_DRAFT)
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const materialKey = JSON.stringify([material.path, material.revision])
  const feedback = input.feedback[materialKey] ?? { vote: '', comment: '' }
  const updateFeedback = (next: MoteIdeaFeedback) => {
    const held = useLauncherState.getState().drafts[key]?.moteIdea ?? EMPTY_IDEA_DRAFT
    useLauncherState.getState().setMoteIdeaDraft(key, { ...held, feedback: { ...held.feedback, [materialKey]: next } })
  }
  const [pending, setPending] = useState(false), [issue, setIssue] = useState<string | null>(null), [status, setStatus] = useState<string | null>(null)
  const alive = useRef(true), current = useRef({ input, material }); current.current = { input, material }
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  function review() {
    if (pending) { setIssue('The current action is still in progress. Your feedback is kept.'); return }
    const { input: capturedInput, material: capturedMaterial } = current.current
    setPending(true); setIssue(null); setStatus(null)
    void stageMoteIdeaFeedback(scope, material, feedback, onOpenPath,
      () => alive.current && current.current.input === capturedInput && current.current.material === capturedMaterial)
      .then(() => { if (alive.current) setStatus('Feedback staged in the original SOUL. Review it and Save to use it in new Sessions.') })
      .catch(error => { if (alive.current) setIssue(presentError(error)) })
      .finally(() => { if (alive.current) setPending(false) })
  }
  return <>
    <details className="mote-details__idea-feedback"><summary>Tell Mote what helps</summary>
      <div className="mote-details__cooperation">
        <p className="mote-details__hint mote-details__source" title={material.revision}>Feedback on {material.path.split('/').at(-1)} · this saved revision</p>
        <div className="mote-idea-controls__actions" role="group" aria-label="Idea feedback response"><button type="button" className="icon-button" aria-label="Useful" title="Useful" aria-pressed={feedback.vote === 'useful'} onClick={() => updateFeedback({ ...feedback, vote: feedback.vote === 'useful' ? '' : 'useful' })}><ThemeActionApproveIcon size={16} /></button><button type="button" className="icon-button" aria-label="Less useful" title="Less useful" aria-pressed={feedback.vote === 'less-useful'} onClick={() => updateFeedback({ ...feedback, vote: feedback.vote === 'less-useful' ? '' : 'less-useful' })}><ThemeActionDisapproveIcon size={16} /></button></div>
        <label>Your feedback<ComposerTextarea aria-label="Idea feedback comment" rows={2} value={feedback.comment} onValueChange={value => updateFeedback({ ...feedback, comment: value })} /></label>
        <button type="button" className="small-button" aria-label="Review feedback in SOUL" onClick={review}><ThemeActionEditIcon size={14} />{pending ? 'Preparing feedback…' : 'Review in SOUL'}</button>
        <p className="mote-details__hint">Keeps the original SOUL text and this note. Correct facts through the note's original editor.</p>
      </div>
    </details>
    {status ? <p role="status" className="mote-details__hint">{status}</p> : null}
    {issue ? <p role="status" className="mote-details__issue">{issue}</p> : null}
    {persistenceIssue ? <p role="status" className="mote-details__issue">{persistenceIssue}</p> : null}
  </>
}
