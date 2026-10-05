import { TextInput } from '@agentmux/client-ui/input'
import { Activity, ArrowLeft, Check, LockKeyhole, Plus, Search, Smartphone, Wrench, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ToolkitToolConfiguration, ToolkitConfigurationFields } from '@agentmux/core/control'
import { DEFAULT_MOBILE_CONNECTION_PREFERENCES, MOBILE_CONNECTION_TOOL_ID, type MobileConnectionPreferences, type PerformancePreferences } from '../../../../shared/toolkit-preferences'
import { ToolkitIcon } from '../toolkit/ToolkitIcon'
import type { SettingsNavigationRequest } from '../SettingsNavigation'
import { BuiltinMobileConnectionSettings } from './BuiltinMobileConnectionSettings'
import { BuiltinPerformanceSettings } from './BuiltinPerformanceSettings'
import { ToolkitPackageEditor } from './ToolkitPackageEditor'
import { packageFact, toolkitIdentity, useToolkitPackages } from '../toolkit/use-toolkit-packages'
import { ToolkitToolEditor } from './ToolkitToolEditor'
import { LiquidSelectionSurface } from '../LiquidSelectionSurface'
import { isInlineDraft, isPackageDraft, toolkitDraftDirty, toolkitFields, useToolkitDrafts, type ToolkitDraftWriter } from './use-toolkit-drafts'

function shortDirectory(path: string) {
  const segments = path.split(/[\\/]/u).filter(Boolean)
  return { parent: segments.length > 1 ? `${segments.length > 2 ? '…/' : '/'}${segments.at(-2)}/` : '', name: segments.at(-1) ?? path }
}

export function ToolkitSettingsPane({ performance, mobileConnection = DEFAULT_MOBILE_CONNECTION_PREFERENCES, tools, toolId, navigationRequest, active, writer, onSave, onSaveMobileConnection, onRemoveTool, onRunTool }: {
  mobileConnection?: MobileConnectionPreferences
  onSaveMobileConnection?(value: MobileConnectionPreferences, expected: MobileConnectionPreferences): Promise<void>
  performance: PerformancePreferences; tools: readonly ToolkitToolConfiguration[]; toolId?: string | undefined
  navigationRequest?: SettingsNavigationRequest | undefined
  active: boolean; writer: ToolkitDraftWriter
  onSave(performance: PerformancePreferences, expected: PerformancePreferences): Promise<void>
  onRemoveTool(id: string, expected: ToolkitConfigurationFields): Promise<void>
  onRunTool(id: string): Promise<string>
}) {
  const resource = useToolkitDrafts(tools)
  const metadata = useToolkitPackages(tools, active)
  const [selectedId, setSelectedId] = useState<string | null>(toolId ?? tools[0]?.id ?? null)
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
  const identityFor = (id: string, entry: typeof resource.entries[string]) => 'kind' in entry.value ? { id, name: entry.expected ? toolkitIdentity(entry.expected, metadata.packages).name : 'New local extension', icon: entry.expected ? toolkitIdentity(entry.expected, metadata.packages).icon : 'terminal' } : { id, name: entry.value.name.trim() || 'Untitled tool', icon: entry.value.icon }
  const visible = entries.filter(([id,entry]) => `${identityFor(id, entry).name} ${entry.value.workspacePath} ${'kind' in entry.value ? entry.value.packagePath : ''}`.toLowerCase().includes(normalized))
  const showMobileConnection = !normalized || '手机连接 phone mobile connection device official built-in 手机 设备 在线 授权'.includes(normalized)
  const showPerformance = !normalized || 'performance official built-in resource use'.includes(normalized)
  useLayoutEffect(() => {
    const node = host.current
    if (!node || !active) return
    const update = () => { const width = node.getBoundingClientRect().width; setNarrow(width > 0 && width <= 660) }
    update()
    const observer = new ResizeObserver(update); observer.observe(node)
    return () => observer.disconnect()
  }, [active])
  useEffect(() => { if (toolId) { setSelectedId(toolId); setView('editor'); setQuery('') } }, [toolId, navigationRequest])
  useEffect(() => {
    if (toolId === selectedId) return
    if (selectedId !== null && selectedId !== 'performance' && selectedId !== MOBILE_CONNECTION_TOOL_ID && !Object.hasOwn(resource.entries, selectedId)) setSelectedId(null)
  }, [resource.entries, selectedId, toolId])
  useLayoutEffect(() => {
    if (!focusNewName.current || !nameInput.current) return
    nameInput.current.focus(); focusNewName.current = false
  }, [selectedId])
  useLayoutEffect(() => {
    if (!focusBack.current || view !== 'library') return
    const row = Array.from(library.current?.querySelectorAll<HTMLButtonElement>('[data-tool-id]') ?? []).find(item => item.dataset.toolId === selectedId)
    ;(row ?? searchInput.current)?.focus(); focusBack.current = false
  }, [selectedId, view])
  function open(id: string) { setSelectedId(id); setView('editor') }
  function add() {
    if (entries.length >= 128) return
    const id = `tool-${crypto.randomUUID()}`
    resource.add(id, { name: '', icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: '', script: "console.log('Hello from your toolkit')\n", args: [], actions: [] })
    focusNewName.current = true; setQuery(''); open(id)
  }
  function install() {
    if (entries.length >= 128) return
    const id = `tool-${crypto.randomUUID()}`
    resource.add(id, { kind: 'package', packagePath: '', enabled: true, statusBar: 'icon', workspacePath: '', args: [] })
    focusNewName.current = true; setQuery(''); open(id)
  }
  function back() { focusBack.current = true; setView('library') }
  async function remove() {
    if (!selected || selectedId === null || selected.saving) return false
    if (selected.expected) await onRemoveTool(selectedId, toolkitFields(selected.expected))
    resource.forget(selectedId); setSelectedId(entries.find(([id]) => id !== selectedId)?.[0] ?? null); focusBack.current = true; setView('library'); return true
  }
  return <div ref={host} className="settings-pane-stack toolkit-workbench" data-view={view} data-creation-empty={!entries.length && selectedId === null}>
    <header className="settings-pane-toolbar toolkit-workbench__toolbar">
      <p className="toolkit-workbench__intro">Your scripts. Your actions.</p>
      <button type="button" className="small-button" disabled={entries.length >= 128} onClick={install}><Plus size={13} /> Install package</button>
      <button type="button" className="primary-button toolkit-workbench__create" disabled={entries.length >= 128} onClick={() => add()}><Plus size={13} /> New custom tool</button>
    </header>
    {metadata.error ? <p className="settings-inline-error" role="status">Package files could not be read: {metadata.error} Your configuration and drafts are kept. <button type="button" className="small-button" onClick={() => void metadata.refresh()}>Refresh files</button></p> : null}
    <div className="toolkit-workbench__body">
      <section className="toolkit-library" aria-label="Toolkit Library">
        <label className="toolkit-library__search"><Search size={14} aria-hidden="true" /><TextInput ref={searchInput} aria-label="Search tools" placeholder="Find a tool…" value={query} onChange={event => setQuery(event.target.value)} />{query ? <button type="button" aria-label="Clear tool search" onClick={() => { setQuery(''); searchInput.current?.focus() }}><X size={12} /></button> : null}</label>
        <div ref={library} className="toolkit-library__items">
          <LiquidSelectionSurface selected={selectedId} active={active && (!narrow || view === 'library')} targetAttribute="data-tool-id" />
          <p className="toolkit-library__group">Custom</p>
          {visible.map(([id,entry]) => {
            const identity = identityFor(id, entry), path = 'kind' in entry.value ? entry.value.packagePath : entry.value.workspacePath
            const directory = shortDirectory(path), fact = entry.expected ? packageFact(entry.expected, metadata.packages) : undefined
            return <button type="button" className="toolkit-library__item" key={id} data-tool-id={id} aria-pressed={selectedId === id} onClick={() => open(id)}>
            <ToolkitIcon icon={identity.icon} size={17} /><span><strong>{identity.name}</strong><small>{'kind' in entry.value ? 'Custom · local package' : 'Custom · script'} · {entry.saving ? 'Saving…' : toolkitDraftDirty(entry) ? 'Unsaved' : 'Saved'}{entry.value.enabled ? '' : ' · Hidden'}{fact?.availability === 'unavailable' ? ' · Source unavailable' : ''}</small><code title={path}>{path ? <><span className="toolkit-library__parent">{directory.parent}</span><span className="toolkit-library__directory">{directory.name}</span></> : 'Choose a local directory'}</code></span>{selectedId === id ? <Check className="toolkit-library__selected" size={12} aria-label="Selected tool" /> : null}
          </button>})}
          {!visible.length ? <p className="settings-resource-empty">{entries.length ? 'No matching custom tools. Your drafts are kept.' : 'Create a tool with your own script and actions.'}</p> : null}
          {showPerformance || showMobileConnection ? <p className="toolkit-library__group">Built-in</p> : null}
          {showPerformance ? <><button type="button" className="toolkit-library__item" data-tool-id="performance" aria-pressed={selectedId === 'performance'} onClick={() => open('performance')}><Activity size={17} /><span><strong>Performance</strong><small>Official · read-only script</small></span><LockKeyhole className="toolkit-library__official" size={12} aria-label="Official tool" /></button></> : null}
          {showMobileConnection ? <button type="button" className="toolkit-library__item" data-tool-id={MOBILE_CONNECTION_TOOL_ID} aria-pressed={selectedId === MOBILE_CONNECTION_TOOL_ID} onClick={() => open(MOBILE_CONNECTION_TOOL_ID)}><Smartphone size={17} /><span><strong>手机连接</strong><small>Official · 连接与设备状态</small></span><LockKeyhole className="toolkit-library__official" size={12} aria-label="Official tool" /></button> : null}
        </div>
      </section>
      <div className="toolkit-workbench__detail">
        <div hidden={selectedId !== 'performance'} inert={selectedId !== 'performance'}><button type="button" className="small-button toolkit-editor__back" onClick={back}><ArrowLeft size={13} /> Back to tools</button><BuiltinPerformanceSettings performance={performance} active={active && selectedId === 'performance' && (!narrow || view === 'editor')} onSave={onSave} /></div>
        <div hidden={selectedId !== MOBILE_CONNECTION_TOOL_ID} inert={selectedId !== MOBILE_CONNECTION_TOOL_ID}><button type="button" className="small-button toolkit-editor__back" onClick={back}><ArrowLeft size={13} /> Back to tools</button><BuiltinMobileConnectionSettings preferences={mobileConnection} active={active && selectedId === MOBILE_CONNECTION_TOOL_ID && (!narrow || view === 'editor')} onSave={async (value, expected) => { if (!onSaveMobileConnection) throw new Error('手机连接显示配置尚未加载，草稿保留。'); await onSaveMobileConnection(value, expected) }} /></div>
        {selectedId === 'performance' || selectedId === MOBILE_CONNECTION_TOOL_ID ? null : selected && selectedId !== null ? isPackageDraft(selected) ? <ToolkitPackageEditor key={selectedId} id={selectedId} entry={selected} fact={selected.expected ? packageFact(selected.expected, metadata.packages) : undefined} active={active && (!narrow || view === 'editor')} pathInput={nameInput} save={resource.saveFor(selectedId)} onEdit={patch => resource.edit(selectedId, patch)} onSave={() => void resource.save(selectedId, writer)} onRemove={remove} onRun={() => onRunTool(selectedId)} onBack={back} onRefresh={metadata.refresh} /> : isInlineDraft(selected) ? <ToolkitToolEditor key={selectedId} id={selectedId} entry={selected} active={active && (!narrow || view === 'editor')} nameInput={nameInput} save={resource.saveFor(selectedId)} onEdit={patch => resource.edit(selectedId, patch)} onSave={() => void resource.save(selectedId, writer)} onRemove={remove} onRun={definition => onRunTool(definition.id)} onBack={back} /> : null : <section className="toolkit-workbench__empty"><Wrench size={28} /><h3>{toolId && toolId === selectedId ? 'This saved tool is unavailable.' : 'Make a tool your own.'}</h3><p>{toolId && toolId === selectedId ? 'The requested tool is not in the current configuration. No other tool has been substituted.' : 'Start with any script. Give it a name and icon, then add buttons to its results.'}</p>{!toolId || toolId !== selectedId ? <button type="button" className="primary-button toolkit-workbench__create" disabled={entries.length >= 128} onClick={() => add()}><Plus size={13} /> Create your first tool</button> : null}</section>}
      </div>
    </div>
  </div>
}
