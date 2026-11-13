import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import {
  AGENT_BUILT_IN_DERIVED_ACTIONS, AGENT_DERIVED_ACTION_LIMITS, parseAgentDerivedActionFields,
  type AgentBuiltInDerivedActionId, type AgentDerivedAction, type AgentDerivedActionsConfig
} from '@agentmux/core/agent-derived-actions'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AppConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { configuredExecutors } from '../../lib/executors'
import { AgentExecutorPicker } from '../AgentExecutorPicker'
import { LiquidSelectionSurface } from '../LiquidSelectionSurface'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useResourceDrafts } from './use-resource-drafts'
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
  const [hidden, setHidden] = useState<{ value: readonly AgentBuiltInDerivedActionId[]; expected: readonly AgentBuiltInDerivedActionId[] }>(() => ({ value: saved.hidden ?? [], expected: saved.hidden ?? [] }))
  useEffect(() => {
    // Adopt a committed visibility unless this page has its own unsaved choice.
    setHidden(current => configValuesEqual(current.value, current.expected) ? { value: saved.hidden ?? [], expected: saved.hidden ?? [] } : { ...current, expected: saved.hidden ?? [] })
  }, [saved.hidden])
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
  const hiddenDirty = !configValuesEqual([...hidden.value].sort(), [...hidden.expected].sort())
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
    setHidden(current => ({ ...current, value: current.value.includes(id) ? current.value.filter(value => value !== id) : AGENT_BUILT_IN_DERIVED_ACTIONS.map(action => action.id).filter(value => value === id || current.value.includes(value)) }))
  }
  async function save() {
    const submitted = resource.beginSave(), visibility = hidden
    const actions = Object.values(submitted.value).map(action => ({ ...action, label: action.label.trim() }))
    const next: AgentDerivedActionsConfig = { ...(actions.length || saved.actions ? { actions } : {}), ...(visibility.value.length ? { hidden: [...visibility.value] } : {}) }
    const expected: AgentDerivedActionsConfig = { ...(saved.actions ? { actions: Object.values(submitted.expected) } : {}), ...(visibility.expected.length ? { hidden: [...visibility.expected] } : {}) }
    const committed = await saveState.run(() => onSave(next, expected))
    submitted.finish(committed ? Object.fromEntries(actions.map(action => [action.id, action])) : undefined)
    if (committed) setHidden(current => ({ value: current.value, expected: visibility.value }))
  }

  const row = (id: string, name: string, detail: string, Icon: typeof DerivedIcon, extra?: { hidden?: boolean; status?: string }) =>
    <button type="button" className="prompt-library__item derived-actions__item" key={id} data-derived-action-id={id} aria-pressed={selected === id}
      data-hidden={extra?.hidden || undefined} onClick={() => open(id)}>
      <span className="prompt-library__name"><Icon size={13} /><strong>{name}</strong>
        {extra?.status ? <span className="derived-actions__badge" data-status={extra.status}>{extra.status === 'invalid' ? 'Check' : extra.status === 'hidden' ? 'Hidden' : 'Unsaved'}</span> : null}
        {selected === id ? <SelectedIcon size={13} aria-label="Selected action" /> : null}</span>
      <span className="prompt-library__scope"><span>{detail}</span></span>
    </button>

  return <div className="settings-pane-stack prompt-workbench derived-actions" data-view={view}>
    <div className="settings-pane-toolbar prompt-workbench__toolbar">
      <span className="settings-resource-count">{AGENT_BUILT_IN_DERIVED_ACTIONS.length - hidden.value.length + drafts.length} in the Agent menu</span>
      <button type="button" className="small-button" onClick={() => add()} disabled={drafts.length >= AGENT_DERIVED_ACTION_LIMITS.actions}><AddIcon size={13} /> Add action</button>
    </div>
    <div className="prompt-workbench__body">
      <section className="prompt-library" aria-label="Derived actions">
        <div className="prompt-library__items">
          <LiquidSelectionSurface selected={selected} active={active} targetAttribute="data-derived-action-id" />
          <p className="derived-actions__section">Official</p>
          {AGENT_BUILT_IN_DERIVED_ACTIONS.map(action => row(action.id, action.label, action.description, OFFICIAL_ICONS[action.id],
            hidden.value.includes(action.id) ? { hidden: true, status: 'hidden' } : {}))}
          <p className="derived-actions__section">Yours</p>
          {drafts.map(draft => row(draft.id, nameOf(draft), draft.base === 'fork' ? 'Fork with an instruction' : 'New Agent with an instruction', DerivedIcon,
            problems.has(draft.id) ? { status: 'invalid' } : !configValuesEqual(draft, Object.hasOwn(resource.expected, draft.id) ? resource.expected[draft.id] : undefined) ? { status: 'unsaved' } : {}))}
          {!drafts.length ? <p className="settings-resource-empty">Turn something you often ask a second Agent to do into one menu action.</p> : null}
        </div>
      </section>
      {official ? <section className="prompt-settings-card prompt-editor" aria-label={`${official.label} options`} data-derived-editor={official.id}>
        <div className="prompt-editor__heading"><button type="button" className="small-button prompt-editor__back" onClick={() => setView('library')}><BackIcon size={13} /> Back to actions</button><span>Official · read only</span></div>
        <h3 className="derived-actions__title">{official.label}</h3>
        <p className="derived-actions__lead">{official.description}</p>
        <label className="derived-actions__toggle"><input type="checkbox" checked={!hidden.value.includes(official.id)} onChange={() => toggle(official.id)} />
          <span><strong>Show in the Agent menu</strong><small>Hiding never removes recovery options, such as Take over after a Session cannot resume.</small></span></label>
        {official.id === 'take-over' ? <div className="derived-actions__actions"><button type="button" className="small-button" onClick={() => add({ label: 'Take over with a note', base: 'new-agent', instruction: 'Continue the original work. Before you start, ' })}>
          <DerivedIcon size={13} /> Start your own from this</button></div> : null}
      </section> : custom ? <section className="prompt-settings-card prompt-editor" aria-label={`Edit ${nameOf(custom)}`} data-derived-editor={custom.id}>
        <div className="prompt-editor__heading"><button type="button" className="small-button prompt-editor__back" onClick={() => setView('library')}><BackIcon size={13} /> Back to actions</button><span>Yours</span>
          {problems.has(custom.id) ? <span className="prompt-editor__status" data-prompt-status="invalid">Needs attention</span> : null}</div>
        <div className="agent-settings-fields prompt-editor__fields">
          <label className="prompt-editor__name"><span>Name in the menu</span><TextInput ref={nameInput} value={custom.label} maxLength={AGENT_DERIVED_ACTION_LIMITS.label} placeholder="Review this work" onChange={event => update(custom.id, { label: event.target.value })} /></label>
          <fieldset className="derived-actions__base"><legend>Starts from</legend>{BASES.map(base => <label key={base.value}>
            <input type="radio" name={`${describedBy}-base`} value={base.value} checked={custom.base === base.value} onChange={() => update(custom.id, { base: base.value })} />
            <span><strong>{base.label}</strong><small>{base.detail}</small></span></label>)}</fieldset>
          <label className="prompt-editor__instruction"><span>Instruction</span>
            <ComposerTextarea value={custom.instruction} rows={7} aria-describedby={`${describedBy}-instruction`} placeholder="Review the changes and list concrete bugs. Do not edit files."
              onValueChange={value => update(custom.id, { instruction: value })} />
            <small id={`${describedBy}-instruction`} className={problems.has(custom.id) ? 'settings-inline-error' : ''}>{problems.get(custom.id) ?? (custom.base === 'fork'
              ? 'Sent first to the forked conversation, exactly as written.' : 'The new Agent also gets the original Session, its records and how to read them. The original keeps running.')}</small></label>
          {custom.base === 'new-agent' ? <div className="derived-actions__agent"><AgentExecutorPicker presentation="field" label="Default Agent" unsetLabel="Ask each time"
            executors={executors} selected={custom.executorId ?? null} onSelect={id => update(custom.id, id ? { executorId: id } : { executorId: '' })} />
            <small>Listed first when you start the action. You still choose before anything starts.</small></div> : null}
          <section className="prompt-usage derived-actions__preview" aria-label="Menu preview"><header>In the Agent menu <small>Read only</small></header>
            <div><span className="derived-actions__preview-item"><DerivedIcon size={13} />{nameOf(custom)}{custom.base === 'fork' ? '…' : ''}</span>
              <span>Right-click an Agent or open its More menu. It starts beside the original; nothing is sent to the original Agent.</span></div></section>
          <div className="prompt-editor__remove"><button type="button" className="small-button" onClick={() => remove(custom.id)}>{Object.hasOwn(resource.expected, custom.id)
            ? <><RemoveIcon size={13} /> Delete action</> : <><CancelIcon size={13} /> Cancel new action</>}</button></div>
        </div>
      </section> : null}
    </div>
    {!drafts.length ? <section className="derived-actions__starts" aria-label="Starting points"><p>Start from an example</p>
      <div>{STARTING_POINTS.map(start => <button type="button" key={start.label} className="small-button" onClick={() => add(start)}><DerivedIcon size={13} />{start.label}</button>)}</div></section> : null}
    <footer className="prompt-save-footer">
      <p className="prompt-save-summary" role="status">Saves your actions and which official actions appear.{dirty ? <> {drafts.filter(draft => !configValuesEqual(draft, Object.hasOwn(resource.expected, draft.id) ? resource.expected[draft.id] : undefined)).length + (hiddenDirty ? 1 : 0)} changed{deleted ? ` · ${deleted} pending ${deleted === 1 ? 'deletion' : 'deletions'}` : ''}.</> : null}</p>
      <SettingsSaveBar save={saveState} dirty={dirty} disabled={problems.size > 0} label="Save actions" onSave={() => void save()} />
    </footer>
  </div>
}
