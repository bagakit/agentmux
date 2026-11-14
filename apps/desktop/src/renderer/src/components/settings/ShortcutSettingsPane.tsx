import { mintObjectId } from '@agentmux/core/object-id'
import { SemanticIcon, semanticIconComponent } from '@agentmux/client-ui/icons'
import { PROMPT_REACTION_ICONS, PROMPT_REACTION_STARTERS, type PromptReactionIcon } from '@agentmux/core/prompt-reaction'
import { PromptReactionIconView } from '@agentmux/client-ui/components/ConversationReactionActions'
import { resolveComposerInputConfig } from '@agentmux/client-ui/composer-input-config'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core/provider-id'
import { Button } from '@agentmux/client-ui/components/Button'
import type { AppConfig, ComposerShortcut } from '../../../../shared/contracts'
import { COMPOSER_PROMPT_STATES } from '../../../../shared/composer-shortcut-library'
import { configValuesEqual } from '../../../../shared/config-edit'
import { SettingsSaveBar } from './SettingsSaveBar'
import { ComposerTextarea, NativeSelect, SearchInput, TextInput } from '@agentmux/client-ui/input'
import { agentProviderLabel } from '@agentmux/client-ui/components/AgentProviderIcon'
import { promptProblems, useGoalsPrompts } from './GoalsPromptDrafts'
import { LiquidSelectionSurface } from '../LiquidSelectionSurface'
import { describeAgentDisplayState } from '../../../../shared/agent-state-presentation'
import { SettingsConceptSummary } from './SettingsConceptSummary'
import './settings-prompts-editor.css'
import './settings-starting-points.css'

const ThemeActionCreatePromptIcon = semanticIconComponent('action.create-prompt')
const ThemeActionAddQuickRepliesIcon = semanticIconComponent('action.add-quick-replies')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeActionCancelIcon = semanticIconComponent('action.cancel')
const ThemeActionRemoveIcon = semanticIconComponent('action.remove')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')

type PromptScope = { kind: 'all' } | { kind: 'shared' } | { kind: 'provider'; providerId: string }

const promptStartingPoints = [
  { keyword: 'review', label: 'Review changes', body: 'Review the current changes. Find concrete bugs and regressions, cite the affected files and explain why each finding matters. State any gaps in verification.' },
  { keyword: 'recap', label: 'Summarize findings', body: 'Summarize the findings so far: the conclusion, supporting evidence, open questions and the next useful step. Link the relevant files or sources.' },
  { keyword: 'plan', label: 'Plan next steps', body: 'Read the current task and relevant project context. Propose a short sequence of concrete steps, with a clear way to verify the outcome of each step.' }
] as const

const promptName = (prompt: ComposerShortcut) => prompt.label.trim() || prompt.keyword.trim() || 'Untitled prompt'
const providerName = (prompt: ComposerShortcut) => prompt.providerId ? `${agentProviderLabel(prompt.providerId)} only` : 'Every Agent'
const stateName = (state: (typeof COMPOSER_PROMPT_STATES)[number]) => describeAgentDisplayState(state).label
const scopeIncludes = (scope: PromptScope, prompt: ComposerShortcut) => scope.kind === 'all' ||
  (scope.kind === 'shared' ? prompt.providerId === undefined : prompt.providerId === scope.providerId)

/** Search, selection and text input stay in this view; the retained Settings owner holds authored data. */
export function ShortcutSettingsPane({ config, active, onOpenGoals }: {
  config: AppConfig
  active: boolean
  onOpenGoals(): void
}) {
  const owner = useGoalsPrompts()
  const { resource, directory, saveState, update } = owner
  const drafts = Object.values(resource.value)
  const [selectedId, setSelectedId] = useState<string | null>(() => drafts[0]?.id ?? null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<PromptScope>({ kind: 'all' })
  const [usageOpen, setUsageOpen] = useState<Record<string, boolean>>({})
  const [view, setView] = useState<'library' | 'editor'>('library')
  const [recentDelete, setRecentDelete] = useState<{ prompt: ComposerShortcut } | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const library = useRef<HTMLDivElement>(null)
  const focusNewName = useRef(false)
  const focusCommonBody = useRef(false), promptEditor = useRef<HTMLElement>(null)
  const focusBack = useRef(false)
  const descriptionId = useId()
  const prompt = selectedId !== null && Object.hasOwn(resource.value, selectedId) ? resource.value[selectedId] : undefined
  const { command, keywords } = resolveComposerInputConfig(config.messageToolCompletion)
  const keyword = prompt?.keyword.trim() || 'keyword'
  const usageExamples = [command !== null ? `${command}${keyword}` : null, keywords ? keyword : null].filter(value => value !== null)
  const usageDescription = usageExamples.length
    ? `Type ${usageExamples.join(' or ')} to add your instruction to a draft instead of sending.`
    : 'Choose this prompt from the input toolbar to add your instruction to a draft instead of sending.'
  const normalizedQuery = query.trim().toLowerCase()
  const providerScopes = [...new Set([...drafts.flatMap(candidate => candidate.providerId === undefined ? [] : [candidate.providerId]),
    ...(scope.kind === 'provider' ? [scope.providerId] : [])])]
  const visible = drafts.filter((candidate) => scopeIncludes(scope, candidate) && [candidate.label, candidate.keyword, candidate.body, providerName(candidate), ...(candidate.states ?? [])]
    .join(' ').toLowerCase().includes(normalizedQuery))
  const problems = promptProblems(drafts)
  const problemsById = new Map<string, typeof problems>()
  for (const problem of problems) {
    const existing = problemsById.get(problem.id)
    if (existing) existing.push(problem)
    else problemsById.set(problem.id, [problem])
  }
  const errors = selectedId === null ? [] : problemsById.get(selectedId) ?? []
  const selectedChanged = prompt && !configValuesEqual(prompt, Object.hasOwn(resource.expected, prompt.id) ? resource.expected[prompt.id] : undefined)
  const promptStatus = errors.length ? 'invalid' : selectedChanged ? 'unsaved' : 'saved'
  const changedCount = drafts.filter((candidate) => !configValuesEqual(candidate, Object.hasOwn(resource.expected, candidate.id) ? resource.expected[candidate.id] : undefined)).length
  const deletedCount = Object.keys(resource.expected).filter((id) => !Object.hasOwn(resource.value, id)).length

  useEffect(() => {
    if (selectedId !== null && Object.hasOwn(resource.value, selectedId)) return
    setSelectedId(drafts[0]?.id ?? null)
  }, [resource.value, selectedId])
  useEffect(() => {
    if (focusCommonBody.current) {
      promptEditor.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
      focusCommonBody.current = false
      return
    }
    if (!focusNewName.current || !nameInput.current) return
    nameInput.current.focus()
    focusNewName.current = false
  }, [selectedId, view, scope])
  useLayoutEffect(() => {
    if (!focusBack.current || view !== 'library') return
    const row = Array.from(library.current?.querySelectorAll<HTMLButtonElement>('[data-prompt-id]') ?? [])
      .find((item) => item.dataset.promptId === selectedId)
    ;(row ?? searchInput.current)?.focus()
    focusBack.current = false
  }, [view, selectedId, scope, query])

  function bindProvider(id: string, providerId: string): void {
    resource.setValue((current) => {
      const { providerId: _dropped, ...rest } = current[id]!
      return { ...current, [id]: providerId ? { ...rest, providerId } : rest }
    })
  }
  function bindReaction(id: string, icon?: PromptReactionIcon): void {
    resource.setValue(current => {
      const { reactionIcon: _dropped, ...rest } = current[id]!
      return { ...current, [id]: icon ? { ...rest, reactionIcon: icon } : rest }
    })
  }
  function addReactionStarters(): void {
    const additions = PROMPT_REACTION_STARTERS.filter(starter => !drafts.some(candidate => candidate.id === starter.id || candidate.keyword === starter.keyword))
    if (!additions.length) return
    resource.setValue(current => ({ ...current, ...Object.fromEntries(additions.map(starter => [starter.id, { ...starter }])) }))
    setScope({ kind: 'shared' })
    setQuery('')
    open(additions[0]!.id)
  }
  function open(id: string): void {
    if (!focusNewName.current) focusCommonBody.current = true
    setSelectedId(id); setView('editor')
  }
  function add(startingPoint?: Pick<ComposerShortcut, 'keyword' | 'label' | 'body'>): void {
    const id = mintObjectId()
    resource.setValue((current) => ({ ...current, [id]: { id, keyword: '', label: '', body: '', ...startingPoint,
      ...(scope.kind === 'provider' ? { providerId: scope.providerId } : {}) } }))
    setQuery('')
    focusNewName.current = true
    open(id)
  }
  useEffect(() => {
    if (!owner.editRequest) return
    focusCommonBody.current = true
    setScope({ kind: 'all' }); setQuery(''); open(owner.editRequest.id)
  }, [owner.editRequest])
  function remove(id: string): void {
    owner.forgetAutoLabel(id)
    if (Object.hasOwn(resource.expected, id) && Object.hasOwn(resource.value, id)) setRecentDelete({ prompt: resource.value[id]! })
    if (selectedId === id) setSelectedId(drafts.find((candidate) => candidate.id !== id)?.id ?? null)
    resource.setValue((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    if (!Object.hasOwn(resource.expected, id)) owner.changeItems(owner.common.items.filter(ref => ref.kind !== 'prompt' || ref.id !== id))
    setView('library')
  }
  function undoDelete(): void {
    if (!recentDelete) return
    const restored = recentDelete.prompt
    resource.setValue((current) => Object.hasOwn(current, restored.id) ? current : { ...current, [restored.id]: restored })
    setRecentDelete(null)
    open(restored.id)
  }
  function back(): void {
    focusBack.current = true
    setView('library')
  }
  function showInLibrary(): void {
    setScope({ kind: 'all' })
    setQuery('')
    focusBack.current = true
    setView('library')
  }
  async function save(): Promise<void> {
    if (saveState.saving || resource.saving) return
    const deletionAtStart = recentDelete
    const submitted = { expected: resource.expected, value: resource.value }
    const committed = await owner.savePrompts()
    if (committed) setRecentDelete((current) => current === deletionAtStart && current && Object.hasOwn(submitted.expected, current.prompt.id) && !Object.hasOwn(submitted.value, current.prompt.id) ? null : current)
  }

  return (
    <div className="settings-pane-stack prompt-workbench" data-view={view} data-creation-empty={!drafts.length}>
      <div className="prompt-goals-link"><span>Manage Goals shortcuts, order and visibility in Goals settings.</span><Button type="button" onClick={onOpenGoals}>Goals common actions</Button></div>
      <div className="prompt-scope" role="group" aria-label="Prompt authoring scope">
        <button type="button" data-prompt-scope="all" aria-pressed={scope.kind === 'all'} onClick={() => setScope({ kind: 'all' })}>All prompts <span>{drafts.length}</span></button>
        <button type="button" data-prompt-scope="shared" aria-pressed={scope.kind === 'shared'} onClick={() => setScope({ kind: 'shared' })}>Shared <span>{drafts.filter(candidate => candidate.providerId === undefined).length}</span></button>
        {providerScopes.map(providerId => <button type="button" key={providerId} data-prompt-scope-provider={providerId}
          aria-pressed={scope.kind === 'provider' && scope.providerId === providerId} onClick={() => setScope({ kind: 'provider', providerId })}>
          {agentProviderLabel(providerId)} <span>{drafts.filter(candidate => candidate.providerId === providerId).length}</span>
        </button>)}
      </div>
      <div className="settings-pane-toolbar prompt-workbench__toolbar">
        <span className="settings-resource-count">{visible.length === drafts.length ? drafts.length : `${visible.length} of ${drafts.length}`} {drafts.length === 1 ? 'prompt' : 'prompts'}</span>
        <Button type="button" onClick={() => add()}><ThemeActionCreatePromptIcon size={13} /> Add prompt</Button>
        {PROMPT_REACTION_STARTERS.some(starter => !drafts.some(candidate => candidate.id === starter.id || candidate.keyword === starter.keyword)) ?
          <Button type="button" onClick={addReactionStarters}><ThemeActionAddQuickRepliesIcon size={13} /> Add quick replies</Button> : null}
      </div>
      <div className="prompt-workbench__body">
        <section className="prompt-library" aria-label="Prompt library">
          <SearchInput className="prompt-library__search" ref={searchInput} aria-label="Search prompts" clearLabel="Clear prompt search"
            placeholder="Find an instruction…" value={query} onValueChange={setQuery} />
          <div ref={library} className="prompt-library__items">
            <LiquidSelectionSurface selected={selectedId} active={active} targetAttribute="data-prompt-id" />
            {visible.map((candidate) => {
              const status = problemsById.has(candidate.id) ? 'invalid' :
                !configValuesEqual(candidate, Object.hasOwn(resource.expected, candidate.id) ? resource.expected[candidate.id] : undefined) ? 'unsaved' : undefined
              return (
              <button type="button" className="prompt-library__item" key={candidate.id} data-prompt-id={candidate.id} aria-pressed={selectedId === candidate.id} onClick={() => open(candidate.id)}>
                <span className="prompt-library__name">{candidate.reactionIcon ? <PromptReactionIconView icon={candidate.reactionIcon} size={13} /> : null}<strong>{promptName(candidate)}</strong>{status ? <span className="prompt-library__status" data-prompt-list-status={status} aria-label={status === 'invalid' ? 'Needs attention' : 'Unsaved changes'} title={status === 'invalid' ? 'Needs attention' : 'Unsaved changes'}><SemanticIcon name={`status.prompt-${status}`} size={4} /></span> : null}{selectedId === candidate.id ? <ThemeStatusSelectedIcon size={13} aria-label="Selected prompt" /> : null}</span>
                <span className="prompt-library__scope" title={`${providerName(candidate)} · ${candidate.states?.map(stateName).join(', ') || 'Draft shortcut'}${candidate.reactionIcon ? ' · Reply card' : ''}`}>
                  <code>{candidate.keyword.trim() ? command !== null ? `${command}${candidate.keyword.trim()}` : keywords ? candidate.keyword.trim() : 'Input toolbar' : 'No keyword yet'}</code>
                  <span>{providerName(candidate)}{candidate.states?.length ? ` · ${candidate.states.map(stateName).join(', ')}` : ''}{candidate.reactionIcon ? ' · Reply card' : ''}</span>
                </span>
              </button>
              )
            })}
          </div>
          {!visible.length ? <p className="settings-resource-empty">{drafts.length ? 'No prompts in this view. Your edits are kept.' : 'Keep the instructions you use often here. Add a prompt to get started.'}</p> : null}
        </section>
        {prompt ? <section ref={promptEditor} onFocus={() => setView('editor')} className="prompt-settings-card prompt-editor" data-prompt-editor={prompt.id} aria-label={`Edit ${promptName(prompt)}`}>
          <div className="prompt-editor__heading"><Button type="button" className="prompt-editor__back" onClick={back}><ThemeNavigationBackIcon size={13} /> Back to prompts</Button><span>{providerName(prompt)}</span><span className="prompt-editor__status" data-prompt-status={promptStatus}><SemanticIcon name={`status.prompt-${promptStatus}`} size={4} />{promptStatus === 'invalid' ? 'Needs attention' : promptStatus === 'unsaved' ? 'Unsaved' : 'Saved'}</span></div>
          {selectedChanged && Object.hasOwn(resource.expected, prompt.id) ? <Button type="button" className="prompt-editor__revert" disabled={saveState.saving} onClick={() => resource.setValue(current => ({ ...current, [prompt.id]: resource.expected[prompt.id]! }))}>Cancel edit</Button> : null}
          {!visible.some((candidate) => candidate.id === prompt.id) ? <p className="prompt-editor__filtered" role="status">This prompt is outside your search or scope. <Button type="button" onClick={showInLibrary}>Show in library</Button></p> : null}
          <div className="prompt-editor__fields">
            <label className="prompt-editor__name"><span>Name</span><TextInput ref={nameInput} value={prompt.label} onChange={(event) => update(prompt.id, { label: event.target.value })} placeholder="Explain simply" /></label>
            <label className="prompt-editor__instruction"><span>Prompt</span><ComposerTextarea variant="compact" aria-invalid={errors.some((error) => error.field === 'Prompt')} aria-describedby={`${descriptionId}-body`} value={prompt.body} onValueChange={(value) => update(prompt.id, { body: value })} placeholder="Explain what changed in plain words, then name the next useful step." /><small id={`${descriptionId}-body`} className={errors.some((error) => error.field === 'Prompt') ? 'settings-inline-error' : ''}>{errors.find((error) => error.field === 'Prompt')?.message ?? 'Your instruction, exactly as it will be used.'}</small></label>
            <div className="prompt-editor__reach">
              <label><span>Keyword</span><TextInput aria-describedby={`${descriptionId}-keyword`} aria-invalid={errors.some((error) => error.field === 'Keyword')} value={prompt.keyword} onChange={(event) => update(prompt.id, { keyword: event.target.value })} placeholder="eli5" /><small id={`${descriptionId}-keyword`} className={errors.some((error) => error.field === 'Keyword') ? 'settings-inline-error' : ''}>{errors.find((error) => error.field === 'Keyword')?.message ?? usageDescription}</small></label>
              <label><span>Provider scope</span><NativeSelect aria-label="Prompt Provider scope" aria-describedby={`${descriptionId}-provider`} value={prompt.providerId ?? ''} onChange={(event) => bindProvider(prompt.id, event.target.value)}><option value="">Every Agent</option>{BUILT_IN_AGENT_PROVIDER_IDS.map((id) => <option key={id} value={id}>{agentProviderLabel(id)}</option>)}{prompt.providerId && !BUILT_IN_AGENT_PROVIDER_IDS.some((id) => id === prompt.providerId) ? <option value={prompt.providerId}>{agentProviderLabel(prompt.providerId)}</option> : null}</NativeSelect><small id={`${descriptionId}-provider`}>Shared, or available to one Provider.</small></label>
            </div>
            <details className="prompt-editor__usage" open={Object.hasOwn(usageOpen, prompt.id) ? usageOpen[prompt.id] : false} onToggle={event => {
              const open = event.currentTarget.open
              setUsageOpen(current => current[prompt.id] === open ? current : { ...current, [prompt.id]: open })
            }}>
              <summary><span><strong>Where it appears</strong><small>{prompt.states?.length ? `${prompt.states.length} status ${prompt.states.length === 1 ? 'action' : 'actions'}` : 'Draft shortcut'}{prompt.reactionIcon ? ' · Quick reply' : ''}</small></span><ThemeNavigationDownIcon size={13} /></summary>
              <div className="prompt-editor__usage-fields">
            <fieldset className="prompt-state-settings prompt-reaction-settings"><legend>Quick reply on Agent messages</legend>
              <div className="prompt-reaction-settings__choices"><button type="button" className="small-button" aria-pressed={!prompt.reactionIcon} onClick={() => bindReaction(prompt.id)}>None</button>
                {PROMPT_REACTION_ICONS.map(icon => <button type="button" className="small-button" key={icon} aria-label={`Quick reply icon ${icon}`} aria-pressed={prompt.reactionIcon === icon} onClick={() => bindReaction(prompt.id, icon)}>
                  <PromptReactionIconView icon={icon} />{icon === 'check' ? 'Check' : icon === 'play' ? 'Play' : 'Explain'}</button>)}
              </div><small>Sends this saved instruction with the original reply reference. Never approves permission requests.</small>
              {prompt.reactionIcon ? <small>Agent lookup: <code>amux settings prompts inspect --keyword {prompt.keyword.trim() || 'code'}</code></small> : null}
            </fieldset>
            <fieldset className="prompt-state-settings"><legend>Available in Agent status when</legend><div className="prompt-state-settings__choices">{COMPOSER_PROMPT_STATES.map((state) => {
              const meaning = describeAgentDisplayState(state)
              return <label key={state}><input type="checkbox" value={state} aria-describedby={`${descriptionId}-state-${state}`} checked={prompt.states?.includes(state) ?? false} onChange={(event) => update(prompt.id, { states: event.target.checked ? [...(prompt.states ?? []), state] : (prompt.states ?? []).filter((candidate) => candidate !== state) })} /><span><strong>{meaning.label}</strong></span></label>
            })}</div><small>Each selection matches its exact state. Running does not include working. Visibility is separate from whether a message can be sent.</small>
              <details className="prompt-state-reference"><summary>What each state means</summary><dl>{COMPOSER_PROMPT_STATES.map(state => {
                const meaning = describeAgentDisplayState(state)
                return <div key={state}><dt>{meaning.label} <code>{state}</code></dt><dd id={`${descriptionId}-state-${state}`}>{meaning.description}</dd></div>
              })}</dl></details>
            </fieldset>
            <section className="prompt-usage" aria-label="Usage preview"><header>Usage preview <small>Read only</small></header><div><code>{usageExamples.length ? usageExamples.join(' · ') : 'Input toolbar'}</code><span>{usageDescription}</span></div>{prompt.states?.length ? <div><span className="prompt-usage__example">{promptName(prompt)}</span><span>Open the receiving Agent avatar at {prompt.states.map(stateName).join(', ')} to choose this user prompt. Click sends this instruction only; pending permission or question requests queue it. Your draft is kept.</span></div> : <p>Draft shortcut only. Select states to make this instruction available in the receiving Agent avatar. Pending permission or question requests queue it.</p>}</section>
              </div>
            </details>
            <div className="prompt-editor__remove"><Button type="button" onClick={() => remove(prompt.id)}>{Object.hasOwn(resource.expected, prompt.id) ? <><ThemeActionRemoveIcon size={13} /> Delete prompt</> : <><ThemeActionCancelIcon size={13} /> Cancel new prompt</>}</Button></div>
          </div>
        </section> : !drafts.length ? <section className="prompt-editor__empty settings-starting-points" aria-label="Prompt starting points">
          <SettingsConceptSummary icon="object.prompt" title="Keep a useful instruction close"
            description="Start with an example, edit its wording and save it as a reusable prompt." />
          <div className="settings-starting-points__list">{promptStartingPoints.map(startingPoint => <button type="button" key={startingPoint.keyword}
            className="settings-starting-points__item" data-prompt-starting-point={startingPoint.keyword} onClick={() => add(startingPoint)}>
            <span><strong>{startingPoint.label}</strong><code>{startingPoint.keyword}</code></span><small>{startingPoint.body}</small>
            <span className="settings-starting-points__action">Edit this prompt <ThemeActionCreatePromptIcon size={12} aria-hidden="true" /></span>
          </button>)}</div>
          <p className="settings-starting-points__note">Examples open as unsaved drafts. You choose when to save or send them.</p>
        </section> : <div className="prompt-editor__empty">Choose a prompt to edit its instruction and where it appears.</div>}
      </div>
      {problems.length ? <div className="prompt-validation" role="status"><strong>Check {problemsById.size} {problemsById.size === 1 ? 'prompt' : 'prompts'} before saving</strong>{problems.map((problem) => <button type="button" key={`${problem.id}-${problem.field}`} onClick={() => open(problem.id)}>{promptName(resource.value[problem.id]!)} · {problem.field}: {problem.message}</button>)}</div> : null}
      {recentDelete ? <div className="prompt-pending-delete" role="status"><span>Recently removed “{promptName(recentDelete.prompt)}”.</span><Button type="button" onClick={undoDelete}>Undo</Button></div> : null}
      <footer className="prompt-save-footer">
        <p className="prompt-save-summary" role="status">Saves the whole prompt library.{resource.dirty ? <> {changedCount} changed{deletedCount ? ` · ${deletedCount} pending ${deletedCount === 1 ? 'deletion' : 'deletions'}` : ''}.</> : null}{directory.dirty ? ' Also saves Goals common actions.' : null}</p>
        <SettingsSaveBar save={saveState} dirty={resource.dirty || directory.dirty} resolution={owner.promptsResolution} blocked={problems.length ? `${problems.length === 1 ? 'one prompt needs' : `${problems.length} prompts need`} attention.` : undefined} label="Save prompts" onSave={() => void save()} />
      </footer>
    </div>
  )
}
