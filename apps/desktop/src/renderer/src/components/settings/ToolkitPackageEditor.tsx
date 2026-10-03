import { ArrowLeft, Code2, Copy, Folder, Package, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import type { ToolkitPackageConfiguration, ToolkitPackageFields, ToolkitScript } from '@agentmux/core/control'
import { api } from '../../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { ToolkitIcon } from '../toolkit/ToolkitIcon'
import type { ToolkitPackageDescriptor } from '../toolkit/use-toolkit-packages'
import { ConfirmationDialog } from '../ConfirmationDialog'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'
import { SettingsSaveBar } from './SettingsSaveBar'
import { toolkitDraftDirty, type ToolkitDraft, type useToolkitDrafts } from './use-toolkit-drafts'

export function ToolkitPackageEditor({ id, entry, fact, active, pathInput, save, onEdit, onSave, onRemove, onRun, onBack, onRefresh }: {
  id: string; entry: ToolkitDraft<ToolkitPackageFields, ToolkitPackageConfiguration>; fact?: ToolkitPackageDescriptor | undefined
  active: boolean; pathInput: RefObject<HTMLInputElement | null>; save: ReturnType<ReturnType<typeof useToolkitDrafts>['saveFor']>
  onEdit(patch: Partial<ToolkitPackageFields>): void; onSave(): void; onRemove(): Promise<boolean>
  onRun(): Promise<string>; onBack(): void; onRefresh(): Promise<void>
}) {
  const uid = useId(), epoch = useRef(0)
  const [source, setSource] = useState<ToolkitScript | null>(null), [sourceOpen, setSourceOpen] = useState(false)
  const [sourceError, setSourceError] = useState(''), [operationError, setOperationError] = useState(''), [feedback, setFeedback] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false), [busy, setBusy] = useState(false)
  const tool = entry.value, dirty = toolkitDraftDirty(entry)
  const name = fact?.name ?? id, icon = fact?.icon ?? 'terminal'
  useEffect(() => { ++epoch.current; setSource(null); setSourceError(''); setSourceOpen(false) }, [id, entry.expected?.revision])
  useEffect(() => { if (!active) ++epoch.current }, [active])
  async function readSource() {
    if (!active || !entry.expected) return
    const generation = ++epoch.current
    try {
      const script = await api.toolkit.script(id)
      if (generation !== epoch.current) return
      if (script.toolId !== id) throw new Error('The source belongs to another tool.')
      setSource(script); setSourceError('')
    } catch (cause) { if (generation === epoch.current) setSourceError(presentError(cause)) }
  }
  async function refresh() { await onRefresh(); if (sourceOpen) await readSource() }
  async function operate(operation: () => Promise<string | void>) {
    if (busy) return
    setBusy(true); setOperationError(''); setFeedback('')
    try { const notice = await operation(); if (notice) setFeedback(notice) }
    catch (cause) { setOperationError(presentError(cause)) }
    finally { setBusy(false) }
  }
  return <section className="toolkit-editor toolkit-package" data-tool-editor={id} data-tool-package={id} aria-label={`Configure ${name}`}>
    <header className="toolkit-editor__heading">
      <button type="button" className="small-button toolkit-editor__back" onClick={onBack}><ArrowLeft size={13} /> Back to tools</button>
      <span className="toolkit-editor__metadata"><span>Custom · local extension</span><span className="toolkit-editor__status" data-dirty={dirty}>{entry.saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</span></span>
      <button type="button" className="small-button toolkit-editor__run" disabled={dirty || entry.saving || !entry.expected || !tool.enabled || busy || entry.missing} onClick={() => void operate(onRun)}><Play size={13} /> Run</button>
    </header>
    <div className="toolkit-package__identity"><span><ToolkitIcon icon={icon} size={24} /></span><div><h3>{entry.expected ? name : 'Install a local extension'}</h3><p>{entry.expected ? 'Loaded from your local package files' : 'Choose a directory containing manifest.json and its scripts.'}</p></div></div>
    {entry.missing ? <p className="settings-inline-error" role="status">This saved tool was removed. Your draft is kept.</p> : null}
    {fact?.reason ? <p className="settings-inline-error" role="status">{fact.reason} {fact.availability === 'unavailable' ? 'Configuration is kept. Existing executions remain in the status bar.' : ''}</p> : null}
    <div className="toolkit-editor__fields">
      <label><span><Package size={13} /> Package directory</span><input ref={pathInput} aria-label="Package directory" value={tool.packagePath} onChange={event => onEdit({ packagePath: event.target.value })} placeholder="Absolute local package directory" /><small>manifest.json supplies the name, icon, entry script and action buttons.</small></label>
    </div>
    {entry.expected ? <section className="toolkit-package__source" aria-label="Local package files">
      <header><span><Code2 size={14} /> Editable source files</span><button type="button" className="small-button" onClick={() => void refresh()}><RefreshCw size={13} /> Refresh files</button></header>
      <p>Edit files in this directory with your editor. Changes apply to the next explicit run; an existing execution keeps its captured files.</p>
      <code>{entry.expected.packagePath}/manifest.json</code>
      <div className="toolkit-package__source-actions"><button type="button" className="small-button" onClick={() => void operate(async () => { await api.ui.writeClipboardText(entry.expected!.packagePath); return 'Package directory copied.' })}><Copy size={13} /> Copy directory</button><button type="button" className="small-button" onClick={() => { setSourceOpen(value => !value); if (!sourceOpen) void readSource() }}><Code2 size={13} /> {sourceOpen ? 'Hide entry script' : 'View entry script'}</button></div>
      {sourceOpen && active ? <div className="toolkit-package__preview">{sourceError ? <p className="settings-inline-error" role="status">{sourceError}</p> : source ? <><code>{source.path}</code><textarea className="toolkit-result__script" aria-label="Current local entry script" value={source.text} readOnly /><small>Current file · read only here. Edit the file in your package directory.</small></> : <p className="settings-hint">Reading entry script…</p>}</div> : null}
    </section> : null}
    <div className="toolkit-editor__fields">
      <label><span><Folder size={13} /> Fixed working directory</span><input aria-label="Fixed working directory" value={tool.workspacePath} onChange={event => onEdit({ workspacePath: event.target.value })} placeholder="Absolute local working directory" /><small>Does not follow the current Agent or focused workspace.</small></label>
      <label className="toolkit-editor__toggle"><span><strong>Show in status bar</strong><small>Turning this off prevents new runs. Existing executions keep their captured version.</small></span><input type="checkbox" checked={tool.enabled} onChange={event => onEdit({ enabled: event.target.checked })} /></label>
      <fieldset className="toolkit-settings__layout"><legend>Status bar appearance</legend><div className="toolkit-settings__choices"><LiquidSelectionSurface selected={tool.statusBar} active={active} targetAttribute="data-settings-target" />{(['icon', 'label'] as const).map(value => <label key={value} data-settings-target={value} data-selected={tool.statusBar === value}><input type="radio" name={`${uid}-layout`} value={value} checked={tool.statusBar === value} onChange={() => onEdit({ statusBar: value })} /><ToolkitIcon icon={icon} size={16} />{value === 'icon' ? 'Icon' : 'Icon and name'}</label>)}</div></fieldset>
      <details className="toolkit-editor__arguments"><summary>Arguments <span>· {tool.args.length || 'optional'}</span></summary><p className="settings-hint">Separate values passed to the entry script. No shell expansion.</p>{tool.args.map((arg, index) => <label className="toolkit-argument" key={index}><span>Argument {index + 1}</span><input value={arg} onChange={event => onEdit({ args: tool.args.map((value, i) => i === index ? event.target.value : value) })} /><button type="button" className="small-button" aria-label={`Remove argument ${index + 1}`} onClick={() => onEdit({ args: tool.args.filter((_, i) => i !== index) })}><X size={13} /></button></label>)}<button type="button" className="small-button" disabled={tool.args.length >= 32} onClick={() => onEdit({ args: [...tool.args, ''] })}><Plus size={13} /> Add argument</button></details>
    </div>
    <p className="settings-hint">Saving, enabling and hovering do not execute the package. Scripts run as your local user with access to local files and the network.</p>
    {feedback ? <p className="settings-hint" role="status">{feedback}</p> : null}{operationError ? <p className="settings-inline-error" role="alert">{operationError}</p> : null}
    <footer className="toolkit-editor__footer"><button type="button" className="small-button" disabled={entry.saving || busy} onClick={() => entry.expected ? setConfirmDelete(true) : void onRemove()}>{entry.expected ? <><Trash2 size={13} /> Delete tool</> : <><X size={13} /> Cancel installation</>}</button><SettingsSaveBar save={save} dirty={dirty} disabled={!tool.packagePath.trim() || !tool.workspacePath.trim() || entry.missing} label={entry.expected ? 'Save preferences' : 'Install package'} onSave={onSave} /></footer>
    <ConfirmationDialog open={confirmDelete} title="Remove this tool?" subject={name} description="Remove its configuration and status bar entry. Your local package files are kept. An active or unconfirmed execution prevents removal." confirmLabel="Delete tool" busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={() => void operate(async () => { if (await onRemove()) setConfirmDelete(false) })} />
  </section>
}
