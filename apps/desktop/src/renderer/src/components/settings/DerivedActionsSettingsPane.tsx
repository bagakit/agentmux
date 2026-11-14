import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ComposerTextarea, Switch, TextInput } from '@agentmux/client-ui/input'
import {
  AGENT_BUILT_IN_DERIVED_ACTIONS, AGENT_DERIVED_ACTION_LIMITS, parseAgentDerivedActionFields,
  type AgentBuiltInDerivedActionId, type AgentDerivedAction, type AgentDerivedActionsConfig
} from '@agentmux/core/agent-derived-actions'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { AppConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { configuredExecutors } from '../../lib/executors'
import { AgentExecutorPicker } from '../AgentExecutorPicker'
import { LiquidSelectionSurface } from '../LiquidSelectionSurface'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useResourceDrafts } from './use-resource-drafts'
import { useSettingDraftRecord } from './use-setting-draft'
import '../../styles/settings-prompts.css'
import './settings-derived-actions.css'

const TakeOverIcon = semanticIconComponent('action.take-over')
const ForkIcon = semanticIconComponent('action.fork-conversation')
const PassOnIcon = semanticIconComponent('action.pass-on-experience')
const DerivedIcon = semanticIconComponent('action.derived-action')
const AddIcon = semanticIconComponent('action.create')
const RemoveIcon = semanticIconComponent('action.remove')
const CancelIcon = semanticIconComponent('action.cancel')
const BackIcon = semanticIconComponent('navigation.back')
const SelectedIcon = semanticIconComponent('status.selected')

const OFFICIAL_ICONS = { 'take-over': TakeOverIcon, fork: ForkIcon, 'pass-on-experience': PassOnIcon } as const
/** What starting each official action asks for. Behavior stays with each action's own owner. */
const OFFICIAL_FACTS: Record<AgentBuiltInDerivedActionId, readonly [string, string][]> = {
  'take-over': [['You choose', 'Which Agent continues; where it opens only when the original has no single location'], ['It reads', 'The original conversation, records and diagnostics'], ['Also offered', 'After a Session cannot resume, even when hidden here']],
  fork: [['You choose', 'A new Tab or a split beside the original'], ['Needs', 'A Provider that can fork its current conversation'], ['Keeps', 'The same Provider, folder and full conversation']],
  'pass-on-experience': [['You choose', 'The Agent that drafts it and the Mote or Topic that learns'], ['You review', 'The draft before anything is learned'], ['Keeps', 'The original Session and its work unchanged']]
}
function OfficialIcon({ id }: { id: AgentBuiltInDerivedActionId }) { const Icon = OFFICIAL_ICONS[id]; return <Icon size={13} /> }
const BASES = [
  { value: 'new-agent', label: 'A new Agent reads the original work', detail: 'Choose any Agent when you start it. It reads the original conversation and records first.' },
  { value: 'fork', label: 'Fork the current conversation', detail: 'The same Provider continues a copy of the conversation and receives this instruction first.' }
] as const
/** Unsaved examples; saving makes them ordinary actions the user owns. */
const STARTING_POINTS = [
  { label: 'Review this work', base: 'new-agent', instruction: 'Review the original Agent’s changes. Find concrete bugs and regressions, cite files and explain why each matters. Do not edit files.' },
  { label: 'Try another approach', base: 'fork', instruction: 'Set the current approach aside. Propose a different way to reach the same goal, then try it and compare the results.' },
  { label: 'Explain in plain words', base: 'new-agent', instruction: 'Read the original work and explain what was done, why, and what is left, in plain words for someone new to it.' }
] as const

type Draft = AgentDerivedAction
const nameOf = (action: Pick<Draft, 'label'>) => action.label.trim() || 'Untitled action'
function newId(label: string, taken: Set<string>) {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'action'
  let id = base, index = 2
  while (taken.has(id) || AGENT_BUILT_IN_DERIVED_ACTIONS.some(action => action.id === id)) id = `${base}-${index++}`
  return id
}

/** One library: official actions you can show or hide, and your own actions you edit. Saving writes both together. */
export function DerivedActionsSettingsPane({ config, active, onSave }: {
  config: AppConfig
  active: boolean
  onSave(next: AgentDerivedActionsConfig, expected: AgentDerivedActionsConfig): Promise<void>
}) {
  const saved = config.agentDerivedActions ?? {}
  const resource = useResourceDrafts(useMemo(() => Object.fromEntries((saved.actions ?? []).map(action => [action.id, action])), [saved.actions]))
  // Visibility is one authored field: a clean draft follows committed changes, a dirty one keeps the
  // baseline it was edited from, so a concurrent change surfaces as a conflict instead of being overwritten.
  const savedHidden = useMemo(() => ({ hidden: [...(saved.hidden ?? [])].sort() as readonly AgentBuiltInDerivedActionId[] }), [saved.hidden])
  const visibility = useSettingDraftRecord(savedHidden, configValuesEqual)
  const hidden = { value: visibility.value.hidden, expected: visibility.expected.hidden }
  const drafts = Object.values(resource.value)
  const [selected, setSelected] = useState<string>(() => AGENT_BUILT_IN_DERIVED_ACTIONS[0].id)
  const [view, setView] = useState<'library' | 'editor'>('library')
  const nameInput = useRef<HTMLInputElement>(null)
  const focusName = useRef(false)
  const describedBy = useId()
  const saveState = useSettingsSave()
  const executors = configuredExecutors(config)
  const official = AGENT_BUILT_IN_DERIVED_ACTIONS.find(action => action.id === selected)
  const custom = Object.hasOwn(resource.value, selected) ? resource.value[selected] : undefined
  const problems = new Map(drafts.flatMap(draft => {
    try { parseAgentDerivedActionFields({ label: draft.label, base: draft.base, instruction: draft.instruction, ...(draft.executorId ? { executorId: draft.executorId } : {}) }); return [] }
    catch (error) { return [[draft.id, error instanceof Error ? error.message : String(error)] as const] }
  }))
  const hiddenDirty = visibility.dirty
  const dirty = resource.dirty || hiddenDirty
  const deleted = Object.keys(resource.expected).filter(id => !Object.hasOwn(resource.value, id)).length

  useEffect(() => {
    if (official || custom) return
    setSelected(AGENT_BUILT_IN_DERIVED_ACTIONS[0].id)
  }, [official, custom])
  useEffect(() => { if (focusName.current) { nameInput.current?.focus(); focusName.current = false } }, [selected])

  function open(id: string) { setSelected(id); setView('editor') }
  function add(start?: Pick<Draft, 'label' | 'base' | 'instruction'>) {
    const label = start?.label ?? ''
    const id = newId(label || 'action', new Set([...Object.keys(resource.value), ...Object.keys(resource.expected)]))
    resource.setValue(current => ({ ...current, [id]: { id, label, base: start?.base ?? 'new-agent', instruction: start?.instruction ?? '' } }))
    focusName.current = true
    open(id)
  }
  function update(id: string, patch: Partial<Draft>) {
    resource.setValue(current => {
      const next = { ...current[id]!, ...patch }
      // A fork continues its own Provider, so it never keeps a default Agent; "Ask each time" clears it.
      if (next.base === 'fork' || !next.executorId) delete next.executorId
      return { ...current, [id]: next }
    })
  }
  function remove(id: string) {
    resource.setValue(current => { const next = { ...current }; delete next[id]; return next })
    setView('library')
  }
  function toggle(id: AgentBuiltInDerivedActionId) {
    const current = visibility.value.hidden
    visibility.setField('hidden', current.includes(id) ? current.filter(value => value !== id) : AGENT_BUILT_IN_DERIVED_ACTIONS.map(action => action.id).filter(value => value === id || current.includes(value)).sort())
  }
  async function save() {
    const submitted = resource.beginSave(), shown = visibility.beginSave()
    const actions = Object.values(submitted.value).map(action => ({ ...action, label: action.label.trim() }))
    const next: AgentDerivedActionsConfig = { ...(actions.length || saved.actions ? { actions } : {}), ...(shown.value.hidden.length ? { hidden: [...shown.value.hidden] } : {}) }
    const expected: AgentDerivedActionsConfig = { ...(saved.actions ? { actions: Object.values(submitted.expected) } : {}), ...(shown.expected.hidden.length ? { hidden: [...shown.expected.hidden] } : {}) }
    const committed = await saveState.run(() => onSave(next, expected))
    submitted.finish(committed ? Object.fromEntries(actions.map(action => [action.id, action])) : undefined)
    shown.finish(committed)
  }

  const changedCount = drafts.filter(draft => !configValuesEqual(draft, Object.hasOwn(resource.expected, draft.id) ? resource.expected[draft.id] : undefined)).length + (hiddenDirty ? 1 : 0)
  const row = (id: string, name: string, detail: string, Icon: typeof DerivedIcon, extra?: { hidden?: boolean; status?: 'invalid' | 'hidden' | 'unsaved' }) =>
    <button type="button" className="prompt-library__item derived-actions__item" key={id} data-derived-action-id={id} aria-pressed={selected === id}
      data-hidden={extra?.hidden || undefined} onClick={() => open(id)}>
      <span className="prompt-library__name"><span className="derived-actions__glyph" aria-hidden="true"><Icon size={13} /></span><strong>{name}</strong>
        {extra?.status ? <span className="derived-actions__badge" data-status={extra.status}>{extra.status === 'invalid' ? 'Check' : extra.status === 'hidden' ? 'Hidden' : 'Unsaved'}</span> : null}
        {selected === id ? <SelectedIcon size={13} aria-label="Selected action" /> : null}</span>
      <span className="prompt-library__scope derived-actions__detail"><span>{detail}</span></span>
    </button>
  // A faithful miniature of the real derived group, so placement is visible before saving.
  const preview = (current: string) => <ol className="derived-actions__menu" aria-label="Agent menu preview">
    {[...AGENT_BUILT_IN_DERIVED_ACTIONS.filter(action => !hidden.value.includes(action.id)).map(action => ({ id: action.id, label: action.label + (action.id === 'fork' ? '…' : ''), Icon: OFFICIAL_ICONS[action.id] })),
      ...drafts.map(draft => ({ id: draft.id, label: nameOf(draft) + '…', Icon: DerivedIcon }))].map(item =>
      <li key={item.id} data-current={item.id === current || undefined}><item.Icon size={13} /><span>{item.label}</span></li>)}
    {official && hidden.value.includes(official.id) ? <li data-current="" data-absent=""><OfficialIcon id={official.id} /><span>{official.label} · hidden</span></li> : null}
  </ol>
  const identity = (Icon: typeof DerivedIcon, tag: string, title: ReactNode) => <div className="derived-actions__identity">
    <span className="derived-actions__tile" aria-hidden="true"><Icon size={18} /></span>
    <div>{title}<span className="derived-actions__tag">{tag}</span></div>
  </div>
  const back = <Button type="button" className="prompt-editor__back" onClick={() => setView('library')}><BackIcon size={13} /> Back to actions</Button>

  return <div className="settings-pane-stack prompt-workbench derived-actions" data-view={view}>
    <div className="settings-pane-toolbar prompt-workbench__toolbar">
      <span className="settings-resource-count">{AGENT_BUILT_IN_DERIVED_ACTIONS.length - hidden.value.length + drafts.length} in the Agent menu</span>
      <Button type="button" onClick={() => add()} disabled={drafts.length >= AGENT_DERIVED_ACTION_LIMITS.actions}><AddIcon size={13} /> Add action</Button>
    </div>
    <div className="prompt-workbench__body">
      <section className="prompt-library" aria-label="Derived actions">
        <div className="prompt-library__items">
          <LiquidSelectionSurface selected={selected} active={active} targetAttribute="data-derived-action-id" />
          <p className="derived-actions__section">Official <span>{AGENT_BUILT_IN_DERIVED_ACTIONS.length}</span></p>
          {AGENT_BUILT_IN_DERIVED_ACTIONS.map(action => row(action.id, action.label, action.description, OFFICIAL_ICONS[action.id],
            hidden.value.includes(action.id) ? { hidden: true, status: 'hidden' } : {}))}
          <p className="derived-actions__section">Yours <span>{drafts.length}</span></p>
          {drafts.map(draft => row(draft.id, nameOf(draft), draft.base === 'fork' ? 'Forks with your instruction' : 'New Agent with your instruction', DerivedIcon,
            problems.has(draft.id) ? { status: 'invalid' } : !configValuesEqual(draft, Object.hasOwn(resource.expected, draft.id) ? resource.expected[draft.id] : undefined) ? { status: 'unsaved' } : {}))}
          {!drafts.length ? <div className="derived-actions__empty"><p>Turn something you often ask a second Agent to do into one menu action.</p>
            <div>{STARTING_POINTS.map(start => <button type="button" key={start.label} className="derived-actions__start" onClick={() => add(start)}><DerivedIcon size={13} /><span>{start.label}</span></button>)}</div></div> : null}
        </div>
      </section>
      {official ? <section className="prompt-settings-card prompt-editor derived-actions__editor" aria-label={`${official.label} options`} data-derived-editor={official.id}>
        <div className="prompt-editor__heading">{back}</div>
        {identity(OFFICIAL_ICONS[official.id], 'Official', <h3 className="derived-actions__title">{official.label}</h3>)}
        <p className="derived-actions__lead">{official.description}</p>
        <label className="derived-actions__toggle"><Switch checked={!hidden.value.includes(official.id)} onChange={() => toggle(official.id)} />
          <span><strong>Show in the Agent menu</strong><small>Hiding only affects the menu. Recovery options, such as Take over after a Session cannot resume, stay available.</small></span></label>
        <dl className="derived-actions__facts">{OFFICIAL_FACTS[official.id].map(([term, detail]) => <div key={term}><dt>{term}</dt><dd>{detail}</dd></div>)}</dl>
        <section className="derived-actions__block" aria-label="Menu placement"><h4>In the Agent menu</h4>{preview(official.id)}</section>
        {official.id === 'take-over' ? <div className="derived-actions__actions"><Button type="button" onClick={() => add({ label: 'Take over with a note', base: 'new-agent', instruction: 'Continue the original work. Before you start, ' })}>
          <DerivedIcon size={13} /> Start your own from this</Button><small>Keeps the full original context; you add the instruction.</small></div> : null}
      </section> : custom ? <section className="prompt-settings-card prompt-editor derived-actions__editor" aria-label={`Edit ${nameOf(custom)}`} data-derived-editor={custom.id}>
        <div className="prompt-editor__heading">{back}
          {problems.has(custom.id) ? <span className="prompt-editor__status" data-prompt-status="invalid">Needs attention</span> : null}</div>
        <div className="prompt-editor__fields">
          {identity(DerivedIcon, 'Yours', <label className="prompt-editor__name derived-actions__name"><span>Name in the menu</span><TextInput ref={nameInput} value={custom.label} maxLength={AGENT_DERIVED_ACTION_LIMITS.label} placeholder="Review this work" onChange={event => update(custom.id, { label: event.target.value })} /></label>)}
          <fieldset className="derived-actions__base"><legend>Starts from</legend><div className="derived-actions__bases" role="radiogroup" aria-label="Starts from">{BASES.map(base => {
            const BaseIcon = base.value === 'fork' ? ForkIcon : TakeOverIcon
            return <label key={base.value} className="derived-actions__base-choice" data-selected={custom.base === base.value || undefined}>
              <input className="settings-choice-radio" type="radio" name={`${describedBy}-base`} value={base.value} checked={custom.base === base.value} onChange={() => update(custom.id, { base: base.value })} />
              <BaseIcon size={16} aria-hidden="true" /><span><strong>{base.label}</strong><small>{base.detail}</small></span>
              {custom.base === base.value ? <SelectedIcon size={13} className="derived-actions__base-check" /> : null}
            </label>
          })}</div></fieldset>
          <label className="prompt-editor__instruction"><span>Instruction</span>
            <ComposerTextarea variant="compact" value={custom.instruction} aria-describedby={`${describedBy}-instruction`} placeholder="Review the changes and list concrete bugs. Do not edit files."
              onValueChange={value => update(custom.id, { instruction: value })} />
            <small id={`${describedBy}-instruction`} className={problems.has(custom.id) ? 'settings-inline-error' : ''}>{problems.get(custom.id) ?? (custom.base === 'fork'
              ? 'Sent first to the forked conversation, exactly as written.' : 'The new Agent also gets the original Session, its records and how to read them. The original keeps running.')}</small></label>
          {custom.base === 'new-agent' ? <div className="derived-actions__agent"><span aria-hidden="true">Default Agent</span><AgentExecutorPicker presentation="field" label="Default Agent" unsetLabel="Ask each time"
            executors={executors} selected={custom.executorId ?? null} onSelect={id => update(custom.id, id ? { executorId: id } : { executorId: '' })} />
            <small>Listed first when you start the action. You still choose before anything starts.</small></div> : null}
          <section className="derived-actions__block" aria-label="Menu placement"><h4>In the Agent menu</h4>{preview(custom.id)}
            <small>It starts beside the original. Nothing is sent to the original Agent.</small></section>
          <div className="prompt-editor__remove"><Button type="button" onClick={() => remove(custom.id)}>{Object.hasOwn(resource.expected, custom.id)
            ? <><RemoveIcon size={13} /> Delete action</> : <><CancelIcon size={13} /> Cancel new action</>}</Button></div>
        </div>
      </section> : null}
    </div>
    <footer className="prompt-save-footer">
      {dirty ? <p className="prompt-save-summary" role="status">{`${changedCount} changed${deleted ? ` · ${deleted} pending ${deleted === 1 ? 'deletion' : 'deletions'}` : ''}`}</p> : null}
      <SettingsSaveBar save={saveState} dirty={dirty} resolution={{ useSaved: () => { resource.useSaved(); visibility.useSaved() }, keepMine: () => { resource.keepMine(); visibility.keepMine() } }} blocked={problems.size ? `${problems.size === 1 ? 'one action needs' : `${problems.size} actions need`} attention.` : undefined} label="Save actions" onSave={() => void save()} />
    </footer>
  </div>
}
