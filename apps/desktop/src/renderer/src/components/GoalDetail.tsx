import { ArrowLeft, ArrowUpRight, MoreHorizontal, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { ComposerTextarea } from './ComposerTextarea'
import { GoalProperties } from './GoalProperties'
import { GoalExecution } from './GoalExecution'

export function GoalDetail({ demand, onClose, onOpenMote, onGrill, moteError, onRetryMote, draft = {}, onDraftChange, onDraftSaved }: { draft?: Partial<Record<'title' | 'description', string>>; onDraftChange?: (field: 'title' | 'description', value: string) => void; onDraftSaved?: (field: 'title' | 'description', value: string) => void; demand: DemandProjection; onClose: () => void; onOpenMote: () => void; onGrill: () => void; moteError: { message: string; mode: 'open' | 'grill' | 'grounding' } | null; onRetryMote: () => void }) {
  const updateDemand = useAppStore((state) => state.updateDemand)
  const deleteDemand = useAppStore((state) => state.deleteDemand)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const [title, setTitle] = useState(draft.title ?? demand.title)
  const [description, setDescription] = useState(draft.description ?? demand.description)
  const draftRef = useRef({ title: draft.title ?? demand.title, description: draft.description ?? demand.description })
  const [titleDirty, setTitleDirty] = useState(draft.title !== undefined)
  const [descriptionDirty, setDescriptionDirty] = useState(draft.description !== undefined)
  const failedPatch = useRef<Parameters<typeof updateDemand>[1]>({})
  const [saveError, setSaveError] = useState<string | null>(Object.keys(draft).length ? 'Review the retained draft and retry saving.' : null)
  const [executionOpen, setExecutionOpen] = useState(false)
  useLayoutEffect(() => { for (const field of [titleRef.current, descriptionRef.current]) if (field) { field.style.height = 'auto'; if (field.scrollHeight > 0) field.style.height = `${field.scrollHeight}px` } }, [title, description])
  useEffect(() => { if (!titleDirty) setTitle(demand.title) }, [demand.title, titleDirty])
  useEffect(() => { if (!descriptionDirty) setDescription(demand.description) }, [demand.description, descriptionDirty])
  async function update(patch: Parameters<typeof updateDemand>[1]) {
    try { await updateDemand(demand.id, patch); for (const key of Object.keys(patch) as Array<keyof typeof patch>) if (failedPatch.current[key] === patch[key]) delete failedPatch.current[key]; if (!Object.keys(failedPatch.current).length) setSaveError(null); if ('title' in patch && draftRef.current.title === patch.title) { setTitleDirty(false); onDraftSaved?.('title', patch.title!) }; if ('description' in patch && draftRef.current.description === patch.description) { setDescriptionDirty(false); onDraftSaved?.('description', patch.description!) } }
    catch (error) { failedPatch.current = { ...failedPatch.current, ...patch }; setSaveError(error instanceof Error ? error.message : String(error)) }
  }
  const timeline = [...(demand.activities ?? []).map((activity) => ({ id: activity.id, at: activity.createdAt, label: activity.kind, text: activity.message })), ...(demand.decisions ?? []).map((decision) => ({ id: decision.id, at: decision.createdAt, label: 'Decision', text: decision.decision }))].sort((left, right) => right.at - left.at)
  return <aside className="goals-detail" aria-label={`Goal workspace for ${demand.title}`}>
    <header className="goals-detail__toolbar"><button className="goals-button" type="button" onClick={onClose} aria-label="Back to goals"><ArrowLeft size={14} />Goals</button><span>{demand.projectName}</span><button type="button" className="goals-button" onClick={onOpenMote} aria-label={`Open Mote for ${demand.title}`}><ArrowUpRight size={13} />Mote</button><details className="goals-detail__menu"><summary aria-label="Goal actions"><MoreHorizontal size={15} /></summary><button type="button" onClick={() => { if (window.confirm(`Delete goal “${demand.title}”?`)) { deleteDemand(demand.id); onClose() } }}><Trash2 size={13} />Delete goal</button></details></header>
    <article className="goals-document">
      <ComposerTextarea ref={titleRef} className="goals-title" aria-label="Goal title" value={title} onValueChange={(value) => { draftRef.current.title = value; onDraftChange?.('title', value); setTitle(value); setTitleDirty(true) }} rows={1} onBlur={() => { if (titleDirty && title.trim()) void update({ title }) }} />
      <section className="goals-intent-body"><h2>Your intent</h2><ComposerTextarea ref={descriptionRef} aria-label="Goal description" value={description} onValueChange={(value) => { draftRef.current.description = value; onDraftChange?.('description', value); setDescription(value); setDescriptionDirty(true) }} onBlur={() => { if (descriptionDirty) void update({ description }) }} rows={Math.max(3, Math.min(14, description.split('\n').length + 1))} placeholder="Describe the outcome in your own words…" /></section>
      {saveError ? <div className="goals-service" role="status">Changes are not saved. Your draft is kept. <span>{saveError}</span><button type="button" className="goals-button" onClick={() => void update({ ...failedPatch.current, ...(titleDirty ? { title } : {}), ...(descriptionDirty ? { description } : {}) })}>Retry save</button></div> : null}
      <section className="goals-alignment" aria-label="Grill: align the goal"><div className="goals-section-heading"><h2>Grill <span>Align the goal</span></h2><span className="goals-caption">Not confirmed</span></div><p className="goals-muted">Turn your intent into a clear outcome and success criteria. Keep the important choices in the conversation.</p><button type="button" className="goals-button" onClick={onGrill}>Discuss the goal<ArrowUpRight size={13} /></button></section>
      <section className="goals-grounding" aria-label="Grounding: verify the result"><h2>Grounding <span>Verify the result</span></h2><p className="goals-muted">{demand.status === 'done' ? 'Marked done, but the result has not been verified against agreed criteria.' : 'No result has been submitted against agreed success criteria yet.'}</p></section>
      {moteError ? <div className="goals-service" role="status">{moteError.mode === 'open' ? 'Goal saved. The dedicated Mote workspace could not be opened.' : `Goal saved. Mote could not receive the ${moteError.mode === 'grill' ? 'discussion' : 'result review'} request; delivery is unconfirmed.`} <span>{moteError.message}</span><button type="button" className="goals-button" onClick={onRetryMote}>{moteError.mode === 'open' ? 'Retry opening Mote' : moteError.mode === 'grill' ? 'Retry discussion' : 'Retry result review'}</button></div> : null}
      <GoalProperties demand={demand} onUpdate={(patch) => void update(patch)} />
      <details className="goals-execution" onToggle={(event) => { if (event.target === event.currentTarget) setExecutionOpen(event.currentTarget.open) }}><summary>Execution{demand.sessionIds.length ? <span>{demand.sessionIds.length} linked</span> : null}</summary>
        {executionOpen ? <GoalExecution demand={demand} onUpdate={(patch) => void update(patch)} /> : null}
      </details>
      {timeline.length ? <details className="goals-activity"><summary>Activity<span>{timeline.length}</span></summary>{timeline.map((entry) => <div className="goals-activity__row" key={entry.id}><time dateTime={new Date(entry.at).toISOString()}>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(entry.at)}</time><span><b>{entry.label}</b> {entry.text}</span></div>)}</details> : null}
    </article>
  </aside>
}
