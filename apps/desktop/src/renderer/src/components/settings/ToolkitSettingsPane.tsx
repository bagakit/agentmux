import { Activity, ArrowLeft, Check, Gauge, LockKeyhole, Plus, Search, Wrench, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ToolkitToolDefinition, ToolkitToolFields } from '@agentmux/core/control'
import type { PerformancePreferences } from '../../../../shared/toolkit-preferences'
import { ToolkitIcon } from '../toolkit/ToolkitIcon'
import type { SettingsNavigationRequest } from '../SettingsNavigation'
import { BuiltinPerformanceSettings } from './BuiltinPerformanceSettings'
import { ToolkitToolEditor } from './ToolkitToolEditor'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'
import { toolkitDraftDirty, toolkitFields, useToolkitDrafts, type ToolkitDraftWriter } from './use-toolkit-drafts'
import { accountUsageScript, createAccountUsageTool } from './account-usage-template'

function shortDirectory(path: string) {
  const segments = path.split(/[\\/]/u).filter(Boolean)
  return { parent: segments.length > 1 ? `${segments.length > 2 ? '…/' : '/'}${segments.at(-2)}/` : '', name: segments.at(-1) ?? path }
}

export function ToolkitSettingsPane({ performance, tools, toolId, navigationRequest, active, writer, onSave, onRemoveTool, onRunTool }: {
  performance: PerformancePreferences; tools: readonly ToolkitToolDefinition[]; toolId?: string | undefined
  navigationRequest?: SettingsNavigationRequest | undefined
  active: boolean; writer: ToolkitDraftWriter
  onSave(performance: PerformancePreferences, expected: PerformancePreferences): Promise<void>
  onRemoveTool(id: string, expected: ToolkitToolFields): Promise<void>
  onRunTool(definition: ToolkitToolDefinition): Promise<string>
}) {
  const resource = useToolkitDrafts(tools)
  const [selectedId, setSelectedId] = useState<string | null>(toolId ?? tools[0]?.id ?? null)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'library' | 'editor'>(toolId ? 'editor' : 'library')
  const [narrow, setNarrow] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  const library = useRef<HTMLDivElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const focusNewName = useRef(false)
  const focusBack = useRef(false)
  const entries = Object.entries(resource.entries)
  const selected = selectedId !== null && Object.hasOwn(resource.entries, selectedId) ? resource.entries[selectedId] : undefined
  const normalized = query.trim().toLowerCase()
  const visible = entries.filter(([,entry]) => `${entry.value.name} ${entry.value.workspacePath}`.toLowerCase().includes(normalized))
  const showPerformance = !normalized || 'performance official built-in resource use'.includes(normalized)
  useLayoutEffect(() => {
    const node = host.current
    if (!node || !active) return
    const update = () => { const width = node.getBoundingClientRect().width; setNarrow(width > 0 && width <= 660) }
    update()
    const observer = new ResizeObserver(update); observer.observe(node)
    return () => observer.disconnect()
  }, [active])
  useEffect(() => { if (toolId) { setTemplateOpen(false); setSelectedId(toolId); setView('editor'); setQuery('') } }, [toolId, navigationRequest])
  useEffect(() => {
    if (toolId === selectedId) return
    if (selectedId !== null && selectedId !== 'performance' && !Object.hasOwn(resource.entries, selectedId)) setSelectedId(null)
  }, [resource.entries, selectedId, toolId])
  useLayoutEffect(() => {
    if (!focusNewName.current || !nameInput.current) return
    nameInput.current.focus(); focusNewName.current = false
  }, [selectedId])
  useLayoutEffect(() => {
    if (!focusBack.current || view !== 'library') return
    const row = Array.from(library.current?.querySelectorAll<HTMLButtonElement>('[data-tool-id]') ?? []).find(item => item.dataset.toolId === selectedId)
    ;(row ?? searchInput.current)?.focus(); focusBack.current = false
  }, [selectedId, view, templateOpen])
  function open(id: string) { setTemplateOpen(false); setSelectedId(id); setView('editor') }
  function add(value?: ToolkitToolFields) {
    if (entries.length >= 128) return
    const id = `tool-${crypto.randomUUID()}`
    resource.add(id, value ?? { name: '', icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: '', script: "console.log('Hello from your toolkit')\n", args: [], actions: [] })
    focusNewName.current = true; setQuery(''); open(id)
  }
  function back() { focusBack.current = true; setView('library') }
  async function remove() {
    if (!selected || selectedId === null || selected.saving) return false
    if (selected.expected) await onRemoveTool(selectedId, toolkitFields(selected.expected))
    resource.forget(selectedId); setSelectedId(entries.find(([id]) => id !== selectedId)?.[0] ?? null); focusBack.current = true; setView('library'); return true
  }
  return <div ref={host} className="settings-pane-stack toolkit-workbench" data-view={view} data-creation-empty={!entries.length && !templateOpen && selectedId === null} data-starting-point={templateOpen}>
    <header className="settings-pane-toolbar toolkit-workbench__toolbar">
      <p className="toolkit-workbench__intro">Your scripts. Your actions.</p>
      <button type="button" className="small-button toolkit-workbench__starting" data-tool-template="account-usage" onClick={() => { setTemplateOpen(true); setView('editor') }}>Starting points</button>
      <button type="button" className="primary-button toolkit-workbench__create" disabled={entries.length >= 128} onClick={() => add()}><Plus size={13} /> New custom tool</button>
    </header>
    <div className="toolkit-workbench__body">
      <section className="toolkit-library" aria-label="Tool library">
        <label className="toolkit-library__search"><Search size={14} aria-hidden="true" /><input ref={searchInput} aria-label="Search tools" placeholder="Find a tool…" value={query} onChange={event => setQuery(event.target.value)} />{query ? <button type="button" aria-label="Clear tool search" onClick={() => { setQuery(''); searchInput.current?.focus() }}><X size={12} /></button> : null}</label>
        <div ref={library} className="toolkit-library__items">
          <LiquidSelectionSurface selected={templateOpen ? null : selectedId} active={active && (!narrow || view === 'library')} targetAttribute="data-tool-id" />
          <p className="toolkit-library__group">Custom</p>
          {visible.map(([id,entry]) => {
            const directory = shortDirectory(entry.value.workspacePath)
            return <button type="button" className="toolkit-library__item" key={id} data-tool-id={id} aria-pressed={!templateOpen && selectedId === id} onClick={() => open(id)}>
            <ToolkitIcon icon={entry.value.icon} size={17} /><span><strong>{entry.value.name.trim() || 'Untitled tool'}</strong><small>Custom · {entry.saving ? 'Saving…' : toolkitDraftDirty(entry) ? 'Unsaved' : 'Saved'}{entry.value.enabled ? '' : ' · Hidden'}</small><code title={entry.value.workspacePath}>{entry.value.workspacePath ? <><span className="toolkit-library__parent">{directory.parent}</span><span className="toolkit-library__directory">{directory.name}</span></> : 'Choose a fixed directory'}</code></span>{!templateOpen && selectedId === id ? <Check className="toolkit-library__selected" size={12} aria-label="Selected tool" /> : null}
          </button>})}
          {!visible.length ? <p className="settings-resource-empty">{entries.length ? 'No matching custom tools. Your drafts are kept.' : 'Create a tool with your own script and actions.'}</p> : null}
          {showPerformance ? <><p className="toolkit-library__group">Built-in</p><button type="button" className="toolkit-library__item" data-tool-id="performance" aria-pressed={!templateOpen && selectedId === 'performance'} onClick={() => open('performance')}><Activity size={17} /><span><strong>Performance</strong><small>Official · read-only script</small></span><LockKeyhole className="toolkit-library__official" size={12} aria-label="Official tool" /></button></> : null}
        </div>
      </section>
      <div className="toolkit-workbench__detail">
        <div hidden={templateOpen || selectedId !== 'performance'} inert={templateOpen || selectedId !== 'performance'}><button type="button" className="small-button toolkit-editor__back" onClick={back}><ArrowLeft size={13} /> Back to tools</button><BuiltinPerformanceSettings performance={performance} active={active && !templateOpen && selectedId === 'performance' && (!narrow || view === 'editor')} onSave={onSave} /></div>
        {templateOpen ? <section className="toolkit-editor toolkit-template" aria-label="Account usage template">
          <header className="toolkit-editor__heading"><button type="button" className="small-button toolkit-editor__back" onClick={back}><ArrowLeft size={13} /> Back to tools</button><span className="toolkit-editor__metadata">Starting point for a custom tool</span></header>
          <div className="toolkit-template__identity"><Gauge size={28} /><div><h3>Account usage</h3><p>Remaining limits, natural resets and reset cards — together in one snapshot.</p></div></div>
          <p className="settings-hint">Use this script as a starting point, or replace it completely. The name, icon, script, arguments and result actions are yours to change.</p>
          <p className="settings-hint">For this account query, choose a fixed directory, set Argument 1 to your query executable and Argument 2 to the exact account key.</p>
          <p className="settings-hint">Starts hidden and disabled. Creating and saving do not query accounts; enable it and run when you are ready.</p>
          <details className="toolkit-editor__scope"><summary>Review template source</summary><pre className="toolkit-template__source">{accountUsageScript}</pre></details>
          <div><button type="button" className="primary-button toolkit-template__adopt" disabled={entries.length >= 128} onClick={() => add(createAccountUsageTool())}><Plus size={13} /> Use this starting point</button></div>
        </section> : selectedId === 'performance' ? null : selected && selectedId !== null ? <ToolkitToolEditor key={selectedId} id={selectedId} entry={selected} active={active && (!narrow || view === 'editor')} nameInput={nameInput} save={resource.saveFor(selectedId)} onEdit={patch => resource.edit(selectedId, patch)} onSave={() => void resource.save(selectedId, writer)} onRemove={remove} onRun={onRunTool} onBack={back} /> : <section className="toolkit-workbench__empty"><Wrench size={28} /><h3>{toolId && toolId === selectedId ? 'This saved tool is unavailable.' : 'Make a tool your own.'}</h3><p>{toolId && toolId === selectedId ? 'The requested tool is not in the current configuration. No other tool has been substituted.' : 'Start with any script. Give it a name and icon, then add buttons to its results.'}</p>{!toolId || toolId !== selectedId ? <button type="button" className="primary-button toolkit-workbench__create" disabled={entries.length >= 128} onClick={() => add()}><Plus size={13} /> Create your first tool</button> : null}</section>}
      </div>
    </div>
  </div>
}
