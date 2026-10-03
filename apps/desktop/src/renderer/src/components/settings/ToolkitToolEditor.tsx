import { ArrowLeft, Code2, Folder, Play, Plus, Trash2, X } from 'lucide-react'
import { lazy, Suspense, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ToolkitAction, ToolkitToolDefinition, ToolkitToolFields, ToolkitInlineToolConfiguration } from '@agentmux/core/control'
import { TOOLKIT_ICON_IDS } from '../../../../shared/toolkit-preferences'
import { ToolkitIcon, toolkitIconLabels } from '../toolkit/ToolkitIcon'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'
import { SettingsSaveBar } from './SettingsSaveBar'
import { ConfirmationDialog } from '../ConfirmationDialog'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { toolkitDraftDirty, type ToolkitDraft, type useToolkitDrafts } from './use-toolkit-drafts'

const ScriptEditor = lazy(() => import('./ToolkitScriptEditor'))

export function ToolkitToolEditor({ id, entry, active, nameInput, save, onEdit, onSave, onRemove, onRun, onBack }: {
  id: string; entry: ToolkitDraft<ToolkitToolFields, ToolkitInlineToolConfiguration>; active: boolean; nameInput: RefObject<HTMLInputElement | null>
  save: ReturnType<ReturnType<typeof useToolkitDrafts>['saveFor']>
  onEdit(patch: Partial<ToolkitToolFields>): void; onSave(): void; onBack(): void
  onRemove(): Promise<boolean>; onRun(definition: ToolkitToolDefinition): Promise<string>
}) {
  const uid = useId()
  const picker = useRef<HTMLDetailsElement>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [runFeedback, setRunFeedback] = useState('')
  const [operationError, setOperationError] = useState('')
  const [actionId, setActionId] = useState<string | null>(null)
  const actionLabel = useRef<HTMLInputElement>(null)
  const focusAction = useRef(false)
  const dirty = toolkitDraftDirty(entry)
  const tool = entry.value
  const actions = tool.actions ?? []
  const action = actionId === null ? null : actions.find(item => item.id === actionId)
  const args = actionId === null ? tool.args : action?.args ?? []
  const invalid = !tool.name.trim() || !tool.workspacePath.trim() || !tool.script.trim() || actions.some(item => !item.label.trim() || !item.script.trim())
  useLayoutEffect(() => {
    if (!focusAction.current || !active || !actionLabel.current) return
    focusAction.current = false; actionLabel.current.focus()
  }, [actionId, active])
  function editScript(patch: Partial<Pick<ToolkitAction, 'label' | 'script' | 'args'>>) {
    if (actionId === null) onEdit(patch)
    else if (action) onEdit({ actions: actions.map(item => item.id === actionId ? { ...item, ...patch } : item) })
  }
  function chooseAction(next: string) { focusAction.current = true; setActionId(next) }
  function addAction() {
    if (actions.length >= 16) return
    const next = `action-${crypto.randomUUID()}`
    onEdit({ actions: [...actions, { id: next, label: '', script: "console.log('Action ready')\n", args: [] }] })
    chooseAction(next)
  }
  async function run() {
    if (!entry.expected || dirty || entry.saving || executing) return
    setExecuting(true); setOperationError(''); setRunFeedback('')
    try { setRunFeedback(await onRun(entry.expected)) }
    catch (cause) { setOperationError(presentError(cause)) }
    finally { setExecuting(false) }
  }
  async function remove() {
    setRemoving(true); setOperationError('')
    try { if (await onRemove()) setConfirmDelete(false) }
    catch (cause) { setOperationError(presentError(cause)); setConfirmDelete(false) }
    finally { setRemoving(false) }
  }
  return <section className="toolkit-editor" data-tool-editor={id} aria-label={`Edit ${tool.name.trim() || 'new tool'}`}>
    <header className="toolkit-editor__heading">
      <button type="button" className="small-button toolkit-editor__back" onClick={onBack}><ArrowLeft size={13} /> Back to tools</button>
      <span className="toolkit-editor__metadata"><span>Custom tool · JavaScript ESM</span><span className="toolkit-editor__status" data-dirty={dirty}>{entry.saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</span></span>
      <button type="button" className="small-button toolkit-editor__run" disabled={dirty || entry.saving || !entry.expected || !tool.enabled || executing || entry.missing} onClick={() => void run()}><Play size={13} /> {executing ? 'Starting…' : actionId === null ? 'Run' : 'Run main script'}</button>
    </header>
    {entry.missing ? <p className="settings-inline-error" role="status">The saved tool is no longer available. Your draft is kept.</p> : null}
    <div className="toolkit-editor__identity">
      <details ref={picker} className="toolkit-icon-picker" onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229 || !picker.current?.open) return
        event.preventDefault(); event.stopPropagation(); picker.current.open = false; picker.current.querySelector('summary')?.focus()
      }}>
        <summary aria-label="Choose tool icon"><ToolkitIcon icon={tool.icon} size={24} /></summary>
        <fieldset><legend>Tool icon</legend><div className="toolkit-icon-picker__grid">
          {TOOLKIT_ICON_IDS.map(icon => <label key={icon} data-selected={tool.icon === icon} title={toolkitIconLabels[icon]}>
            <input type="radio" name={`${uid}-icon`} value={icon} checked={tool.icon === icon} aria-label={toolkitIconLabels[icon]} onChange={() => onEdit({ icon })} />
            <ToolkitIcon icon={icon} size={18} aria-hidden="true" />
          </label>)}
        </div></fieldset>
      </details>
      <label className="toolkit-editor__name"><span>Name</span><input ref={nameInput} value={tool.name} onChange={event => onEdit({ name: event.target.value })} placeholder="Workspace summary" /></label>
    </div>
    <details className="toolkit-editor__result-actions">
      <summary>Result actions <span>· {actions.length || 'optional'}</span></summary>
      <p className="settings-hint">Buttons shown with a confirmed result. Each action runs its saved script in this tool’s fixed directory.</p>
      <div className="toolkit-action-list">
        {actions.map(item => <div className="toolkit-action-list__row" key={item.id}>
          <button type="button" aria-pressed={actionId === item.id} data-toolkit-edit-action={item.id} onClick={() => chooseAction(item.id)}><Code2 size={13} /><span>{item.label.trim() || 'Untitled action'}</span></button>
          <button type="button" className="small-button" aria-label={`Remove action ${item.label.trim() || 'Untitled action'}`} onClick={() => { onEdit({ actions: actions.filter(value => value.id !== item.id) }); if (actionId === item.id) setActionId(null) }}><X size={13} /></button>
        </div>)}
      </div>
      <button type="button" className="small-button" disabled={actions.length >= 16} onClick={addAction}><Plus size={13} /> Add action</button>
    </details>
    {actionId !== null ? <div className="toolkit-editor__action-heading">
      <button type="button" className="small-button" onClick={() => setActionId(null)}><ArrowLeft size={13} /> Main script</button>
      {action ? <label><span>Action button label</span><input ref={actionLabel} value={action.label} onChange={event => editScript({ label: event.target.value })} placeholder="Refresh identity" /></label> : <p className="settings-inline-error" role="status">This action is no longer in the current draft. Choose the main script or another action.</p>}
    </div> : null}
    <section className="toolkit-editor__script" aria-label={actionId === null ? 'JavaScript script' : 'Action JavaScript script'}>
      <header><span><Code2 size={13} /> {actionId === null ? 'Main script' : action?.label.trim() || 'Action script'}</span><span>JavaScript</span></header>
      {active && (actionId === null || action) ? <Suspense fallback={<p className="settings-hint">Opening script editor…</p>}><ScriptEditor key={JSON.stringify([id, actionId])} id={id} actionId={actionId} value={actionId === null ? tool.script : action!.script} onChange={script => editScript({ script })} /></Suspense> : null}
    </section>
    <p className="settings-hint">{actionId === null ? `${dirty ? 'Save before running. ' : ''}Runs as your local user. Saving and hovering do not run this script.` : 'Save the tool to publish this action. Run it from a confirmed result in the status bar.'}</p>
    <details className="toolkit-editor__scope"><summary>Local execution scope</summary><p>Your script can read and write local files, environment variables and the network. It uses your current user account; it is not sandboxed.</p></details>
    <div className="toolkit-editor__fields">
      <label><span><Folder size={13} /> Fixed working directory</span><input value={tool.workspacePath} onChange={event => onEdit({ workspacePath: event.target.value })} placeholder="Choose an absolute local directory" /><small>Does not follow the current Agent or focused workspace.</small></label>
      <label className="toolkit-editor__toggle"><span><strong>Show in status bar</strong><small>Hide the entry and prevent new runs when off. An existing run keeps its captured version.</small></span><input type="checkbox" checked={tool.enabled} onChange={event => onEdit({ enabled: event.target.checked })} /></label>
      <fieldset className="toolkit-settings__layout"><legend>Status bar appearance</legend><div className="toolkit-settings__choices">
        <LiquidSelectionSurface selected={tool.statusBar} active={active} targetAttribute="data-settings-target" />
        {(['icon', 'label'] as const).map(value => <label key={value} data-settings-target={value} data-selected={tool.statusBar === value}>
          <input type="radio" name={`${uid}-layout`} value={value} checked={tool.statusBar === value} onChange={() => onEdit({ statusBar: value })} />
          <ToolkitIcon icon={tool.icon} size={16} />{value === 'icon' ? 'Icon' : 'Icon and name'}
        </label>)}
      </div></fieldset>
      {actionId === null || action ? <details className="toolkit-editor__arguments"><summary>{actionId === null ? 'Arguments' : 'Action arguments'} <span>{args.length ? `· ${args.length}` : '· optional'}</span></summary>
        <p className="settings-hint">Each argument is a separate value. No shell expansion or interpolation.</p>
        {args.map((arg, index) => <label className="toolkit-argument" key={index}><span>Argument {index + 1}</span><input value={arg} onChange={event => editScript({ args: args.map((value, i) => i === index ? event.target.value : value) })} /><button type="button" className="small-button" aria-label={`Remove argument ${index + 1}`} onClick={() => editScript({ args: args.filter((_, i) => i !== index) })}><X size={13} /></button></label>)}
        <button type="button" className="small-button" disabled={args.length >= 32} onClick={() => editScript({ args: [...args, ''] })}><Plus size={13} /> Add argument</button>
      </details> : null}
    </div>
    {runFeedback ? <p className="settings-hint" role="status">{runFeedback}</p> : null}
    {operationError ? <p className="settings-inline-error" role="alert">{operationError}</p> : null}
    <footer className="toolkit-editor__footer">
      <button type="button" className="small-button" disabled={entry.saving || removing} onClick={() => entry.expected ? setConfirmDelete(true) : void remove()}>{entry.expected ? <><Trash2 size={13} /> Delete tool</> : <><X size={13} /> Cancel new tool</>}</button>
      <SettingsSaveBar save={save} dirty={dirty} disabled={invalid || entry.missing} label="Save tool" onSave={onSave} />
    </footer>
    <ConfirmationDialog open={confirmDelete} title="Delete this tool?" subject={tool.name} description="Remove the saved tool and its status bar entry. A running or unconfirmed execution prevents deletion." confirmLabel="Delete tool" busy={removing} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />
  </section>
}
