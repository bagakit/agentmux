import { ArrowLeft, Check, Plus, Search, Trash2, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core/provider-id'
import type { AppConfig, ComposerShortcut } from '../../../../shared/contracts'
import { COMPOSER_PROMPT_STATES, resolveComposerShortcuts } from '../../../../shared/composer-shortcut-library'
import { configValuesEqual } from '../../../../shared/config-edit'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { ComposerTextarea } from '../ComposerTextarea'
import { agentProviderLabel } from '../AgentProviderIcon'
import { useResourceDrafts } from './use-resource-drafts'

const promptName = (prompt: ComposerShortcut) => prompt.label.trim() || prompt.keyword.trim() || 'Untitled prompt'
const providerName = (prompt: ComposerShortcut) => prompt.providerId ? `${agentProviderLabel(prompt.providerId)} only` : 'Every Agent'
const stateName = (state: string) => state.charAt(0).toUpperCase() + state.slice(1)

/** Selection belongs to the view; the complete authored library and its baseline stay in this Pane. */
export function ShortcutSettingsPane({ config, onSave }: {
  config: AppConfig
  onSave: (prompts: ComposerShortcut[], expected: ComposerShortcut[]) => Promise<void>
}) {
  const resource = useResourceDrafts(Object.fromEntries(resolveComposerShortcuts(config).map((prompt) => [prompt.id, prompt])))
  const drafts = Object.values(resource.value)
  const [selectedId, setSelectedId] = useState<string | null>(() => drafts[0]?.id ?? null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'library' | 'editor'>('library')
  const [recentDelete, setRecentDelete] = useState<{ prompt: ComposerShortcut } | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const library = useRef<HTMLDivElement>(null)
  const focusNewName = useRef(false)
  const focusBack = useRef(false)
  const descriptionId = useId()
  const saveState = useSettingsSave()
  const prompt = selectedId !== null && Object.hasOwn(resource.value, selectedId) ? resource.value[selectedId] : undefined
  const normalizedQuery = query.trim().toLowerCase()
  const visible = drafts.filter((candidate) => [candidate.label, candidate.keyword, candidate.body, providerName(candidate), ...(candidate.states ?? [])]
    .join(' ').toLowerCase().includes(normalizedQuery))
  const problems = drafts.flatMap((candidate) => {
    const keyword = candidate.keyword.trim()
    const errors: Array<{ id: string; field: 'Keyword' | 'Prompt'; message: string }> = []
    if (!keyword) errors.push({ id: candidate.id, field: 'Keyword', message: 'Add a keyword to reach this prompt.' })
    else if (drafts.some((other) => other.id !== candidate.id && other.keyword.trim() === keyword)) {
      errors.push({ id: candidate.id, field: 'Keyword', message: `“${keyword}” is already used by another prompt.` })
    }
    if (!candidate.body.trim()) errors.push({ id: candidate.id, field: 'Prompt', message: 'Write the instruction this prompt will use.' })
    return errors
  })
  const errors = problems.filter((problem) => problem.id === selectedId)
  const changedCount = drafts.filter((candidate) => !configValuesEqual(candidate, Object.hasOwn(resource.expected, candidate.id) ? resource.expected[candidate.id] : undefined)).length
  const deletedCount = Object.keys(resource.expected).filter((id) => !Object.hasOwn(resource.value, id)).length

  useEffect(() => {
    if (selectedId !== null && Object.hasOwn(resource.value, selectedId)) return
    setSelectedId(drafts[0]?.id ?? null)
  }, [resource.value, selectedId])
  useEffect(() => {
    if (!focusNewName.current || !nameInput.current) return
    nameInput.current.focus()
    focusNewName.current = false
  }, [selectedId])
  useLayoutEffect(() => {
    if (!focusBack.current || view !== 'library') return
    const row = Array.from(library.current?.querySelectorAll<HTMLButtonElement>('[data-prompt-id]') ?? [])
      .find((item) => item.dataset.promptId === selectedId)
    ;(row ?? searchInput.current)?.focus()
    focusBack.current = false
  }, [view, selectedId])

  function update(id: string, patch: Partial<ComposerShortcut>): void {
    resource.setValue((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }))
  }
  function bindProvider(id: string, providerId: string): void {
    resource.setValue((current) => {
      const { providerId: _dropped, ...rest } = current[id]!
      return { ...current, [id]: providerId ? { ...rest, providerId } : rest }
    })
  }
  function open(id: string): void { setSelectedId(id); setView('editor') }
  function add(): void {
    const id = `prompt-${crypto.randomUUID()}`
    resource.setValue((current) => ({ ...current, [id]: { id, keyword: '', label: '', body: '' } }))
    setQuery('')
    focusNewName.current = true
    open(id)
  }
  function remove(id: string): void {
    if (Object.hasOwn(resource.expected, id) && Object.hasOwn(resource.value, id)) setRecentDelete({ prompt: resource.value[id]! })
    resource.setValue((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
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
  async function save(): Promise<void> {
    const submitted = resource.beginSave()
    const deletionAtStart = recentDelete
    const normalized = Object.values(submitted.value).map((candidate) => ({
      ...candidate, keyword: candidate.keyword.trim(), label: candidate.label.trim() || candidate.keyword.trim(), body: candidate.body
    }))
    const committed = await saveState.run(() => onSave(normalized, Object.values(submitted.expected)))
    submitted.finish(committed ? Object.fromEntries(normalized.map((candidate) => [candidate.id, candidate])) : undefined)
    if (committed) setRecentDelete((current) => current === deletionAtStart && current && Object.hasOwn(submitted.expected, current.prompt.id) && !Object.hasOwn(submitted.value, current.prompt.id) ? null : current)
  }

  return (
    <div className="settings-pane-stack prompt-workbench" data-view={view}>
      <div className="settings-pane-toolbar prompt-workbench__toolbar">
        <span className="settings-resource-count">{drafts.length} {drafts.length === 1 ? 'prompt' : 'prompts'}</span>
        <button type="button" className="small-button" onClick={add}><Plus size={13} /> Add prompt</button>
      </div>
      <div className="prompt-workbench__body">
        <section className="prompt-library" aria-label="Prompt library">
          <label className="prompt-library__search"><Search size={14} aria-hidden="true" /><input ref={searchInput} aria-label="Search prompts" placeholder="Find an instruction…" value={query} onChange={(event) => setQuery(event.target.value)} />{query ? <button type="button" aria-label="Clear prompt search" onClick={() => { setQuery(''); searchInput.current?.focus() }}><X size={12} /></button> : null}</label>
          <div ref={library} className="prompt-library__items">
            {visible.map((candidate) => (
              <button type="button" className="prompt-library__item" key={candidate.id} data-prompt-id={candidate.id} aria-pressed={selectedId === candidate.id} onClick={() => open(candidate.id)}>
                <span className="prompt-library__name"><strong>{promptName(candidate)}</strong>{selectedId === candidate.id ? <Check size={13} aria-label="Selected prompt" /> : null}</span>
                <code>{candidate.keyword.trim() ? `/${candidate.keyword.trim()}` : 'No keyword yet'}</code>
                <span className="prompt-library__body">{candidate.body.trim().split('\n').find((line) => line.trim()) || 'Write an instruction…'}</span>
                <span className="prompt-library__scope">{providerName(candidate)} · {candidate.states?.length ? candidate.states.map(stateName).join(', ') : 'Draft shortcut'}</span>
                {problems.some((problem) => problem.id === candidate.id) ? <span className="prompt-library__invalid">Needs attention</span> : null}
              </button>
            ))}
          </div>
          {!visible.length ? <p className="settings-resource-empty">{drafts.length ? 'No matching prompts. Your edits are kept.' : 'Keep the instructions you use often here. Add a prompt to get started.'}</p> : null}
        </section>
        {prompt ? <section className="prompt-settings-card prompt-editor" data-prompt-editor={prompt.id} aria-label={`Edit ${promptName(prompt)}`}>
          <div className="prompt-editor__heading"><button type="button" className="small-button prompt-editor__back" onClick={back}><ArrowLeft size={13} /> Back to prompts</button><span>{providerName(prompt)}</span></div>
          {!visible.some((candidate) => candidate.id === prompt.id) ? <p className="prompt-editor__filtered" role="status">This prompt is outside your search. <button type="button" className="small-button" onClick={() => setQuery('')}>Show in library</button></p> : null}
          <div className="agent-settings-fields prompt-editor__fields">
            <label><span>Name</span><input ref={nameInput} value={prompt.label} onChange={(event) => update(prompt.id, { label: event.target.value })} placeholder="Explain simply" /></label>
            <label><span>Prompt</span><ComposerTextarea aria-invalid={errors.some((error) => error.field === 'Prompt')} aria-describedby={`${descriptionId}-body`} value={prompt.body} onValueChange={(value) => update(prompt.id, { body: value })} placeholder="Explain what changed in plain words, then name the next useful step." rows={7} /><small id={`${descriptionId}-body`} className={errors.some((error) => error.field === 'Prompt') ? 'settings-inline-error' : ''}>{errors.find((error) => error.field === 'Prompt')?.message ?? 'Your instruction, exactly as it will be used.'}</small></label>
            <div className="prompt-editor__reach">
              <label><span>Keyword</span><input aria-invalid={errors.some((error) => error.field === 'Keyword')} value={prompt.keyword} onChange={(event) => update(prompt.id, { keyword: event.target.value })} placeholder="eli5" /><small className={errors.some((error) => error.field === 'Keyword') ? 'settings-inline-error' : ''}>{errors.find((error) => error.field === 'Keyword')?.message ?? 'Use /keyword or the bare word to expand your draft.'}</small></label>
              <label><span>Agent</span><select value={prompt.providerId ?? ''} onChange={(event) => bindProvider(prompt.id, event.target.value)}><option value="">Every Agent</option>{BUILT_IN_AGENT_PROVIDER_IDS.map((id) => <option key={id} value={id}>{agentProviderLabel(id)}</option>)}{prompt.providerId && !BUILT_IN_AGENT_PROVIDER_IDS.some((id) => id === prompt.providerId) ? <option value={prompt.providerId}>{agentProviderLabel(prompt.providerId)}</option> : null}</select><small>Where this instruction is available.</small></label>
            </div>
            <fieldset className="prompt-state-settings"><legend>Show a button when</legend><div className="prompt-state-settings__choices">{COMPOSER_PROMPT_STATES.map((state) => <label key={state}><input type="checkbox" value={state} checked={prompt.states?.includes(state) ?? false} onChange={(event) => update(prompt.id, { states: event.target.checked ? [...(prompt.states ?? []), state] : (prompt.states ?? []).filter((candidate) => candidate !== state) })} /><span>{stateName(state)}</span></label>)}</div></fieldset>
            <section className="prompt-usage" aria-label="Usage preview"><header>Usage preview <small>Read only</small></header><div><code>/{prompt.keyword.trim() || 'keyword'}</code><span>Type / or its bare keyword to add your instruction to a draft instead of sending.</span></div>{prompt.states?.length ? <div><span className="prompt-usage__example">{promptName(prompt)}</span><span>Button at {prompt.states.map(stateName).join(', ')}. Click sends this instruction; pending questions queue it.</span></div> : <p>Draft shortcut only. Select states to show one-click buttons that send the prompt; pending questions queue it.</p>}</section>
            <div className="prompt-editor__remove"><button type="button" className="small-button" onClick={() => remove(prompt.id)}>{Object.hasOwn(resource.expected, prompt.id) ? <><Trash2 size={13} /> Delete prompt</> : <><X size={13} /> Cancel new prompt</>}</button></div>
          </div>
        </section> : <div className="prompt-editor__empty">Choose a prompt to edit its instruction and where it appears.</div>}
      </div>
      {problems.length ? <div className="prompt-validation" role="status"><strong>Check {new Set(problems.map((problem) => problem.id)).size} {new Set(problems.map((problem) => problem.id)).size === 1 ? 'prompt' : 'prompts'} before saving</strong>{problems.map((problem) => <button type="button" key={`${problem.id}-${problem.field}`} onClick={() => open(problem.id)}>{promptName(resource.value[problem.id]!)} · {problem.field}: {problem.message}</button>)}</div> : null}
      {recentDelete ? <div className="prompt-pending-delete" role="status"><span>Recently removed “{promptName(recentDelete.prompt)}”.</span><button type="button" className="small-button" onClick={undoDelete}>Undo</button></div> : null}
      <footer className="prompt-save-footer">
        <p className="prompt-save-summary" role="status">Save prompts updates the whole library. {changedCount} changed · {deletedCount} pending {deletedCount === 1 ? 'deletion' : 'deletions'}.</p>
        <SettingsSaveBar save={saveState} dirty={resource.dirty} disabled={problems.length > 0} label="Save prompts" onSave={() => void save()} />
      </footer>
    </div>
  )
}
