import * as Dialog from '@radix-ui/react-dialog'
import { useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, FileText, MessageCircle, Plus, X } from 'lucide-react'
import type { FileDocument } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { MOTE_SOUL_PATH } from '../../../shared/scratch-topics'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { MOTE_BEHAVIOR_AXES, deriveMoteBehaviorCode, moteBehaviorRules, parseMoteBehaviorBlock, type MoteBehaviorDraft, type MoteBehaviorPreferences } from '../lib/mote-behavior'
import { readMoteMaterial, stageMoteBehaviorPreferences } from '../lib/mote-cooperation'
import { openMoteDiscussionDraft } from '../lib/mote-materials-actions'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { fileNavigationSelection, useAppStore } from '../store'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { resolveOverlayContainer, WindowOverlayPortal } from './WindowOverlayHost'

/** Familiar icon operations retain a visible tooltip and full accessible name. */
export function MoteBehaviorAction({ label, children, onClick, expanded }: {
  label: string; children: ReactNode; onClick(): void; expanded?: boolean
}) {
  const id = useId(), [anchor, setAnchor] = useState<DOMRect | null>(null)
  return <>
    <button type="button" className="icon-button mote-behavior-action" aria-label={label} aria-expanded={expanded}
      aria-describedby={anchor ? id : undefined} onClick={() => { setAnchor(null); onClick() }}
      onPointerEnter={event => setAnchor(event.currentTarget.getBoundingClientRect())} onPointerLeave={() => setAnchor(null)}
      onFocus={event => setAnchor(event.currentTarget.getBoundingClientRect())} onBlur={() => setAnchor(null)}>{children}</button>
    {anchor ? <WindowOverlayPortal layer="tooltip"><span id={id} role="tooltip" className="mote-behavior-tooltip"
      style={{ left: Math.max(12, Math.min(anchor.left, window.innerWidth - 220)), top: anchor.bottom + 6 }}>{label}</span></WindowOverlayPortal> : null}
  </>
}

/** Local editing session; the original SOUL Editor is the only document and Save owner. */
export function MoteBehaviorDialog({ scope, reference, onOpenPath, onClose, returnFocus }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined
  onOpenPath(path: string): Promise<unknown>; onClose(): void; returnFocus(): HTMLElement | null
}) {
  const [draft, setDraft] = useState<MoteBehaviorDraft>({ custom: '' }), [saved, setSaved] = useState<FileDocument | null>(null)
  const [loading, setLoading] = useState(true), [issue, setIssue] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const [extra, setExtra] = useState<'custom' | 'trial' | null>(null), [question, setQuestion] = useState(''), [attempt, setAttempt] = useState(0)
  const form = useRef(draft); form.current = draft
  const trialInput = useRef<object>({})
  const edited = useRef(false), lifetime = useRef<object>({}), content = useRef<HTMLDivElement>(null)
  const id = useId(), code = deriveMoteBehaviorCode(draft), target = topicSpaceIconTarget(scope.workspace, scope.topic)
  const icon = useAppStore(state => state.spaceObjectIcons[target.key] ?? null)
  const update = (value: MoteBehaviorDraft) => { edited.current = true; form.current = value; setDraft(value) }
  useLayoutEffect(() => {
    const epoch = {}; lifetime.current = epoch
    const navigation = fileNavigationSelection(useAppStore.getState()); let changed = false
    const unsubscribe = useAppStore.subscribe(state => { if (fileNavigationSelection(state) !== navigation) changed = true })
    setLoading(true); setIssue(null)
    void readMoteMaterial(scope, scope.rootPath + '/' + MOTE_SOUL_PATH).then(observation => {
      if (lifetime.current !== epoch) return
      if (changed) throw new Error('Your selection changed while reading. Your choices are kept; reread the original SOUL.')
      const result = observation.result
      if (result.status !== 'read') throw new Error('The saved SOUL is unconfirmed. ' + (result.status === 'error' || result.status === 'unknown' ? result.message : result.status))
      setSaved(result.document)
      const parsed = parseMoteBehaviorBlock(result.document.content)
      if (parsed.status === 'unconfirmed') setIssue(parsed.message)
      else if (!edited.current) {
        const value = parsed.status === 'valid' ? parsed.preferences : { custom: '' }
        form.current = value; setDraft(value)
      }
    }).catch(cause => { if (lifetime.current === epoch) { setSaved(null); setIssue(presentError(cause)) } })
      .finally(() => { unsubscribe(); if (lifetime.current === epoch) setLoading(false) })
    return () => { lifetime.current = {}; unsubscribe() }
  }, [attempt])
  async function review() {
    if (busy) return
    if (!code) { setIssue('Choose one option in each of the four pairs.'); return }
    if (!saved) { setIssue('The saved SOUL is unconfirmed. Your choices are kept; reread it or inspect the original file.'); return }
    const epoch = lifetime.current, submitted = form.current, submittedTrial = trialInput.current
    const current = () => lifetime.current === epoch && form.current === submitted && trialInput.current === submittedTrial
    setBusy(true); setIssue(null)
    try {
      await stageMoteBehaviorPreferences(scope, submitted as MoteBehaviorPreferences, saved, onOpenPath, current, reference)
      if (current()) onClose()
    } catch (cause) { if (lifetime.current === epoch) setIssue(presentError(cause)) }
    finally { if (lifetime.current === epoch) setBusy(false) }
  }
  async function inspect() {
    const epoch = lifetime.current, submitted = form.current
    try {
      const opened = await onOpenPath(scope.rootPath + '/' + MOTE_SOUL_PATH)
      if (lifetime.current !== epoch || form.current !== submitted) return
      if (opened) onClose()
      else setIssue('The original SOUL Editor is unconfirmed. Your form is kept; retry opening it.')
    } catch (cause) { if (lifetime.current === epoch) setIssue(presentError(cause)) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="dialog-scrim mote-behavior-overlay" />
      <Dialog.Content ref={content} className="dialog-surface mote-behavior-dialog" aria-busy={busy}
        onOpenAutoFocus={event => { event.preventDefault(); content.current?.querySelector<HTMLInputElement>('input[type="radio"]')?.focus() }}
        onCloseAutoFocus={event => { event.preventDefault(); const node = returnFocus(), active = document.activeElement
          if (node?.isConnected && (active === document.body || active === node || !active?.isConnected || content.current?.contains(active))) node.focus({ preventScroll: true }) }}>
        <header className="mote-behavior-header"><div>
          <Dialog.Title>Behavior settings</Dialog.Title>
          <Dialog.Description>Choose how {scope.topic.title} works with you.</Dialog.Description>
        </div><MoteBehaviorAction label="Close behavior settings" onClick={onClose}><X size={16} /></MoteBehaviorAction></header>
        <div className="mote-behavior-body">
          <aside className="mote-behavior-preview" aria-label="Behavior preview">
            <div className="mote-behavior-identity"><div className="mote-behavior-avatar">
              <SpaceObjectIcon kind="mote" name={scope.topic.title} manualIcon={icon} avatarObjectKey={target.key}
                avatarWorkspaceId={scope.workspace.id} avatarTopicId={scope.topic.id} />
            </div><div><strong>{scope.topic.title}</strong><span className="mote-behavior-type">{code ? 'MBTI style · ' + code : 'Choose four preferences'}</span></div></div>
            {moteBehaviorRules(draft).length ? <ul>{moteBehaviorRules(draft).map(rule => <li key={rule}>{rule}</li>)}</ul> : null}
            <small>This preview summarizes your choices.</small>
          </aside>
          <div className="mote-behavior-controls">
            {MOTE_BEHAVIOR_AXES.map(axis => <fieldset className="mote-behavior-pair" key={axis.id}>
              <legend>{axis.label}</legend><div>{axis.choices.map((choice, index) => <label key={choice.value} data-selected={draft[axis.id] === choice.value}>
                <input type="radio" name={id + axis.id} value={choice.value} checked={draft[axis.id] === choice.value}
                  tabIndex={draft[axis.id] ? draft[axis.id] === choice.value ? 0 : -1 : index === 0 ? 0 : -1}
                  aria-label={axis.label + ': ' + choice.title} onChange={() => update({ ...form.current, [axis.id]: choice.value })}
                  onKeyDown={event => {
                    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
                    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index
                    update({ ...form.current, [axis.id]: axis.choices[next]!.value })
                    event.currentTarget.closest('fieldset')?.querySelectorAll<HTMLInputElement>('input')[next]?.focus()
                  }} />
                <span>{choice.title}</span><Check size={13} aria-hidden="true" />
              </label>)}</div>
            </fieldset>)}
            <div className="mote-behavior-tools">
              <MoteBehaviorAction label="Extra preferences" expanded={extra === 'custom'} onClick={() => setExtra(value => value === 'custom' ? null : 'custom')}><Plus size={16} /></MoteBehaviorAction>
              <MoteBehaviorAction label="Try a cooperation question" expanded={extra === 'trial'} onClick={() => setExtra(value => value === 'trial' ? null : 'trial')}><MessageCircle size={16} /></MoteBehaviorAction>
              <MoteBehaviorAction label="Open original SOUL file" onClick={() => void inspect()}><FileText size={16} /></MoteBehaviorAction>
            </div>
            {extra === 'custom' ? <label className="mote-behavior-extra">Extra preferences<textarea aria-label="Custom cooperation preferences" rows={3}
              value={draft.custom} onChange={event => update({ ...form.current, custom: event.target.value })} placeholder="What helps us work together?" /></label> : null}
            {extra === 'trial' ? <div className="mote-behavior-extra"><label>Try your own question<textarea aria-label="Cooperation trial question" rows={3} value={question}
              onChange={event => { trialInput.current = {}; setQuestion(event.target.value) }} placeholder="Bring a real question to a new discussion" /></label>
              <button type="button" className="small-button" onClick={() => {
                if (openMoteDiscussionDraft(scope, question, { reference })) onClose()
                else setIssue('The new Launcher is unconfirmed. Your question is kept; inspect the original Group and retry.')
              }}>Prepare new discussion</button>
              <p className="mote-details__hint">Uses saved settings. Edit the question in the new Launcher, then Start.</p>
            </div> : null}
            {loading ? <p role="status" className="mote-details__hint">Reading saved settings…</p> : null}
            {issue ? <div role="status" className="mote-details__issue">{issue}<button type="button" className="small-button" onClick={() => setAttempt(value => value + 1)}>Reread SOUL</button></div> : null}
          </div>
        </div>
        <footer className="mote-behavior-footer"><p>Review the draft in the original Editor, then Save there.</p><div>
          <button type="button" className="small-button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void review()}>{busy ? 'Preparing draft…' : 'Review changes'}</button>
        </div></footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
