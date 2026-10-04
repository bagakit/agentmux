import { sessionPresentationById } from '../lib/session-presentation'
import * as Dialog from '@radix-ui/react-dialog'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bot, FileText, MessageCircle, Pencil, Pin, X, Zap } from 'lucide-react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useShallow } from 'zustand/react/shallow'
import { MOTE_QUICK_MODE_PATH, type MoteQuickDefaults } from '../../../shared/mote-quick-mode'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { readMoteQuickDefaults, saveMoteQuickDefaults, type SavedMoteQuickMode } from '../lib/mote-quick-mode'
import { moteConversationChoices, moteConversationLabel, useMoteDefaultConversation } from '../lib/mote-quick-preferences'
import { spatialCatalog } from '../lib/space-agent-control'
import { executorsForHost } from '../lib/executors'
import { fileNavigationSelection, useAppStore } from '../store'
import { MoteBehaviorAction } from './MoteBehaviorDialog'
import { SelectionField } from './SelectionField'
import { AgentExecutorPicker } from './AgentExecutorPicker'
import { resolveOverlayContainer } from './WindowOverlayHost'
import '../styles/mote-quick-mode.css'

export function MoteQuickMode({ scope, reference, onOpenPath, active }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined; active: boolean
  onOpenPath(path: string): Promise<unknown>
}) {
  const [editing, setEditing] = useState(false), invoker = useRef<HTMLElement | null>(null)
  const saved = scope.topic.quickMode, defaults = saved?.status === 'saved' ? saved.defaults : {}
  const resolved = useMoteDefaultConversation(scope.topic, scope.workspace.id, active)
  const executorFacts = useAppStore(useShallow(state => ({ config: state.config, detections: state.executorDetections, inventory: state.hostExecutorInventories[scope.workspace.hostId] })))
  const executorLabel = useMemo(() => executorsForHost(executorFacts.config, scope.workspace.hostId, executorFacts.detections, executorFacts.inventory)
    .find(item => item.id === defaults.executorId)?.label ?? defaults.executorId, [executorFacts, scope.workspace.hostId, defaults.executorId])
  const conversationLabel = useAppStore(state => defaults.conversation ? moteConversationLabel(state, defaults.conversation) : undefined)
  const edit = () => { invoker.current = document.activeElement as HTMLElement; setEditing(true) }
  return <section className="mote-quick-mode" aria-label="Quick mode">
    <div className="mote-details__section-actions"><span><Zap size={13} />Quick mode</span><MoteBehaviorAction label="Edit quick mode" onClick={edit}><Pencil size={14} /></MoteBehaviorAction></div>
    <button className="mote-quick-mode__row" type="button" onClick={edit}><Bot size={14} /><span>Executor for new chat</span><strong title={defaults.executorId}>{executorLabel ?? 'Choose Executor'}</strong></button>
    <button className="mote-quick-mode__row" type="button" onClick={edit}><MessageCircle size={14} /><span>Default conversation</span><strong title={defaults.conversation?.sessionId}>{conversationLabel ?? (defaults.conversation ? 'Saved conversation' : 'Choose conversation')}</strong>{defaults.conversation ? <Pin size={12} aria-label="Kept open" /> : null}</button>
    {resolved.issue ? <p role="status" className="mote-details__issue">{resolved.issue}</p> : null}
    {editing ? <MoteQuickModeDialog key={scope.workspace.hostId + scope.topic.id + scope.rootPath} scope={scope} reference={reference} onOpenPath={onOpenPath}
      onClose={() => setEditing(false)} returnFocus={() => invoker.current?.isConnected ? invoker.current : null} /> : null}
  </section>
}

function MoteQuickModeDialog({ scope, reference, onOpenPath, onClose, returnFocus }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined
  onOpenPath(path: string): Promise<unknown>; onClose(): void; returnFocus(): HTMLElement | null
}) {
  const [saved, setSaved] = useState<SavedMoteQuickMode | null>(null), [draft, setDraft] = useState<MoteQuickDefaults>(() => scope.topic.quickMode?.status === 'saved' ? scope.topic.quickMode.defaults : {})
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null), [attempt, setAttempt] = useState(0)
  const form = useRef(draft); form.current = draft
  const edited = useRef(false), lifetime = useRef<object>({}), content = useRef<HTMLDivElement>(null), id = useId()
  const facts = useAppStore(useShallow(state => ({ tabs: state.tabs, layouts: state.layouts, config: state.config, snapshots: state.scratchTopicSnapshots,
    bindings: state.spaceZoneBindings, categories: state.topicCategories, detections: state.executorDetections, inventory: state.hostExecutorInventories[scope.workspace.hostId] })))
  const ownAgentIds = useMemo(() => [...new Set(Object.values(facts.tabs).filter(tab => tab.workspaceId === scope.workspace.id)
    .flatMap(tab => Object.values(tab.regions).flatMap(region => region.kind === 'agent' ? [region.sessionId] : [])))], [facts.tabs, scope.workspace.id])
  const execution = useAppStore(useShallow(state => Object.fromEntries(ownAgentIds.map(id => {
    const session = sessionPresentationById(state.sessions).get(id)
    return [id, session ? JSON.stringify([session.hostId, session.control.hostId, session.control.kind === 'agent' ? session.control.agentSessionId : null]) : null]
  }))))
  const choices = useMemo(() => moteConversationChoices(useAppStore.getState(), scope.topic, scope.workspace.id,
    spatialCatalog(useAppStore.getState(), [scope.topic])), [facts.tabs, facts.layouts, facts.config, facts.snapshots, facts.bindings, facts.categories, execution, scope.topic, scope.workspace.id])
  const executors = executorsForHost(facts.config, scope.workspace.hostId, facts.detections, facts.inventory)
  const conversationLabels = useAppStore(useShallow(state => Object.fromEntries(choices.map(choice => [choice.sessionId,
    moteConversationLabel(state, choice) ?? choice.sessionId]))))
  useLayoutEffect(() => {
    const epoch = {}; lifetime.current = epoch
    const navigation = fileNavigationSelection(useAppStore.getState()); let moved = false
    const unsubscribe = useAppStore.subscribe(state => { if (fileNavigationSelection(state) !== navigation) moved = true })
    setLoading(true); setIssue(null)
    void readMoteQuickDefaults(scope).then(source => {
      if (lifetime.current !== epoch) return
      setSaved(source)
      if (moved) throw new Error('Your selection changed during the read. Your choices are kept; reread the settings.')
      if (source.issue) setIssue(source.issue)
      else if (!edited.current) { form.current = source.defaults; setDraft(source.defaults) }
    }).catch(cause => { if (lifetime.current === epoch) { setSaved(null); setIssue(presentError(cause)) } })
      .finally(() => { unsubscribe(); if (lifetime.current === epoch) setLoading(false) })
    return () => { lifetime.current = {}; unsubscribe() }
  }, [attempt])
  const update = (next: MoteQuickDefaults) => { edited.current = true; form.current = next; setDraft(next) }
  const selected = draft.conversation ? JSON.stringify(draft.conversation) : ''
  const hasSelected = choices.some(choice => JSON.stringify(choice) === selected)
  async function save() {
    if (busy || !saved) return
    const submitted = form.current, epoch = lifetime.current
    const current = () => lifetime.current === epoch && form.current === submitted
    setBusy(true); setIssue(null)
    try { await saveMoteQuickDefaults(scope, submitted, saved, onOpenPath, current, reference); if (current()) onClose() }
    catch (cause) { if (lifetime.current === epoch) setIssue(presentError(cause)) }
    finally { if (lifetime.current === epoch) setBusy(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal container={resolveOverlayContainer()}>
    <Dialog.Overlay className="dialog-scrim mote-behavior-overlay" />
    <Dialog.Content ref={content} className="dialog-surface mote-quick-mode-dialog" aria-busy={busy}
      onOpenAutoFocus={event => { event.preventDefault(); content.current?.querySelector<HTMLButtonElement>('.selection-field')?.focus() }}
      onCloseAutoFocus={event => { event.preventDefault(); const node = returnFocus(), active = document.activeElement
        if (node?.isConnected && (active === document.body || active === node || !active?.isConnected || content.current?.contains(active))) node.focus({ preventScroll: true }) }}>
      <header className="mote-behavior-header"><div><Dialog.Title>Quick mode</Dialog.Title><Dialog.Description>{scope.topic.title} · ready to continue</Dialog.Description></div><MoteBehaviorAction label="Close quick mode" onClick={onClose}><X size={16} /></MoteBehaviorAction></header>
      <div className="mote-quick-mode-dialog__body">
        <label htmlFor={id + '-agent'}><Bot size={16} /><span>Executor for new chat<small>Preselected for new conversations.</small></span></label>
        <AgentExecutorPicker presentation="field" id={id + '-agent'} label="Executor for new chat"
          selected={draft.executorId ?? null} executors={executors} unsetLabel="Use normal Launcher choice"
          onSelect={value => { const { executorId: _, ...rest } = form.current; update(value ? { ...rest, executorId: value } : rest) }} />
        <label htmlFor={id + '-conversation'}><Pin size={16} /><span>Default conversation<small>Opens first and stays in this Mote’s tab row.</small></span></label>
        <SelectionField id={id + '-conversation'} label="Default conversation" value={selected}
          onValueChange={value => { const { conversation: _, ...rest } = form.current; const choice = choices.find(choice => JSON.stringify(choice) === value); if (value && !choice) { setIssue('The chosen conversation is no longer confirmed. Your choices are kept.'); return } update(choice ? { ...rest, conversation: choice } : rest) }}
          options={[{ value: '', label: 'No fixed conversation' }, ...(selected && !hasSelected ? [{ value: selected, label: 'Saved location · unconfirmed' }] : []),
            ...choices.map(choice => ({ value: JSON.stringify(choice), label: `${conversationLabels[choice.sessionId]} · ${facts.config?.workspaces.find(item => item.id === choice.displayWorkspaceId)?.name ?? 'Workspace'} / ${1 + (facts.layouts[choice.displayWorkspaceId]?.groups.findIndex(group => group.id === choice.groupId) ?? -1)}` }))]} />
        {!choices.length ? <p className="mote-details__hint">Start an original conversation in this Mote, then choose it here.</p> : null}
        {loading ? <p role="status" className="mote-details__hint">Reading MOTE.md…</p> : null}
        {issue ? <div role="status" className="mote-details__issue">{issue}<button className="small-button" type="button" onClick={() => setAttempt(value => value + 1)}>Reread</button></div> : null}
      </div>
      <footer className="mote-quick-mode-dialog__footer"><button className="icon-button" type="button" title="Inspect MOTE.md" aria-label="Inspect MOTE.md" onClick={() => void onOpenPath(scope.rootPath + '/' + MOTE_QUICK_MODE_PATH).then(opened => { if (opened) onClose() }).catch(cause => setIssue(presentError(cause)))}><FileText size={15} /></button><span>Saving sends no message.</span><button type="button" className="small-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={loading || busy || !saved || Boolean(saved.issue)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></footer>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
