import { mintObjectId } from '@agentmux/core/object-id'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ToolkitAction, ToolkitToolDefinition, ToolkitToolFields, ToolkitInlineToolConfiguration } from '@agentmux/core/control'
import { TOOLKIT_ICON_IDS } from '../../../../shared/toolkit-preferences'
import { ToolkitIcon, toolkitIconLabels } from '../toolkit/ToolkitIcon'
import { LiquidSelectionSurface } from '../LiquidSelectionSurface'
import { SettingsSaveBar } from './SettingsSaveBar'
import { ConfirmationDialog } from '../ConfirmationDialog'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { toolkitDraftDirty, type ToolkitDraft, type useToolkitDrafts } from './use-toolkit-drafts'

const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeActionStartIcon = semanticIconComponent('action.start')
const ThemeObjectSourceCodeIcon = semanticIconComponent('object.source-code')
const ThemeActionCancelIcon = semanticIconComponent('action.cancel')
const ThemeActionRemoveIcon = semanticIconComponent('action.remove')
const ThemeActionAddOperationIcon = semanticIconComponent('action.add-operation')
const ThemeObjectFolderIcon = semanticIconComponent('object.folder')
const ThemeActionAddArgumentIcon = semanticIconComponent('action.add-argument')
const ThemeActionRemoveArgumentIcon = semanticIconComponent('action.remove-argument')


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
  useEffect(() => { if (!active) setConfirmDelete(false) }, [active])
  const [removing, setRemoving] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [runFeedback, setRunFeedback] = useState('')
  const [operationError, setOperationError] = useState('')
  const [actionId, setActionId] = useState<string | null>(null)
  const [displayOpen, setDisplayOpen] = useState(false)
  const actionLabel = useRef<HTMLInputElement>(null)
  const focusAction = useRef(false)
  const dirty = toolkitDraftDirty(entry)
  const tool = entry.value
  const actions = tool.actions ?? []
  const action = actionId === null ? null : actions.find(item => item.id === actionId)
  const args = displayOpen ? tool.display?.args ?? [] : actionId === null ? tool.args : action?.args ?? []
  const scriptTitle = displayOpen ? 'Display script' : actionId === null ? 'Main script' : action?.label.trim() || 'Action script'
  const invalid = !tool.name.trim() || !tool.workspacePath.trim() || !tool.script.trim() || actions.some(item => !item.label.trim() || !item.script.trim()) || Boolean(tool.display && !tool.display.script.trim())
  useLayoutEffect(() => {
    if (!focusAction.current || !active || !actionLabel.current) return
    focusAction.current = false; actionLabel.current.focus()
  }, [actionId, active])
  function editScript(patch: Partial<Pick<ToolkitAction, 'label' | 'script' | 'args'>>) {
    if (displayOpen && tool.display) onEdit({ display: { ...tool.display, ...patch } })
    else if (actionId === null) onEdit(patch)
    else if (action) onEdit({ actions: actions.map(item => item.id === actionId ? { ...item, ...patch } : item) })
  }
  function chooseAction(next: string) { focusAction.current = true; setDisplayOpen(false); setActionId(next) }
  function addAction() {
    if (actions.length >= 16) return
    const next = mintObjectId()
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
      <button type="button" className="small-button toolkit-editor__back" onClick={onBack}><ThemeNavigationBackIcon size={13} /> Back to tools</button>
      <span className="toolkit-editor__metadata"><span>Custom tool · JavaScript ESM</span><span className="toolkit-editor__status" data-dirty={dirty}>{entry.saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</span></span>
      <button type="button" className="small-button toolkit-editor__run" disabled={dirty || entry.saving || !entry.expected || !tool.enabled || executing || entry.missing} onClick={() => void run()}><ThemeActionStartIcon size={13} /> {executing ? 'Starting…' : actionId === null ? 'Run' : 'Run main script'}</button>
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
      <label className="toolkit-editor__name"><span>Name</span><TextInput ref={nameInput} value={tool.name} onChange={event => onEdit({ name: event.target.value })} placeholder="Workspace summary" /></label>
    </div>
    <details className="toolkit-editor__result-actions">
      <summary>Result actions <span>· {actions.length || 'optional'}</span></summary>
      <p className="settings-hint">Buttons shown with a confirmed result. Each action runs its saved script in this tool’s fixed directory.</p>
      <div className="toolkit-action-list">
        {actions.map(item => <div className="toolkit-action-list__row" key={item.id}>
          <button type="button" aria-pressed={actionId === item.id} data-toolkit-edit-action={item.id} onClick={() => chooseAction(item.id)}><ThemeObjectSourceCodeIcon size={13} /><span>{item.label.trim() || 'Untitled action'}</span></button>
          <button type="button" className="small-button" aria-label={`Remove action ${item.label.trim() || 'Untitled action'}`} onClick={() => { onEdit({ actions: actions.filter(value => value.id !== item.id) }); if (actionId === item.id) setActionId(null) }}><ThemeActionRemoveIcon size={13} /></button>
        </div>)}
      </div>
      <button type="button" className="small-button" disabled={actions.length >= 16} onClick={addAction}><ThemeActionAddOperationIcon size={13} /> Add action</button>
    </details>
    {displayOpen || actionId !== null ? <div className="toolkit-editor__action-heading">
      <button type="button" className="small-button" onClick={() => { setActionId(null); setDisplayOpen(false) }}><ThemeNavigationBackIcon size={13} /> Main script</button>
      {displayOpen ? <p className="settings-hint">Runs once when the tool is displayed, including a hover that opens its panel. Refresh runs it again. Use a script that is safe to repeat.</p> : action ? <label><span>Action button label</span><TextInput ref={actionLabel} value={action.label} onChange={event => editScript({ label: event.target.value })} placeholder="Refresh identity" /></label> : <p className="settings-inline-error" role="status">This action is no longer in the current draft. Choose the main script or another action.</p>}
    </div> : null}
    <section className="toolkit-editor__script" aria-label={displayOpen ? 'Display JavaScript script' : actionId === null ? 'JavaScript script' : 'Action JavaScript script'}>
      <header><span><ThemeObjectSourceCodeIcon size={13} /> {scriptTitle}</span><span>JavaScript</span></header>
      {active && (displayOpen ? Boolean(tool.display) : actionId === null || action) ? <Suspense fallback={<p className="settings-hint">Opening script editor…</p>}><ScriptEditor key={JSON.stringify([id, displayOpen, actionId])} id={id} actionId={actionId} display={displayOpen} value={displayOpen ? tool.display!.script : actionId === null ? tool.script : action!.script} onChange={script => editScript({ script })} /></Suspense> : null}
    </section>
    <p className="settings-hint">{displayOpen ? 'Save to enable evaluation when displayed. This script runs as your local user with the same file and network access as the main script.' : actionId === null ? `${dirty ? 'Save before running. ' : ''}Runs as your local user. Saving and hovering do not run the main script.` : 'Save the tool to publish this action. Run it from a confirmed result in the status bar.'}</p>
    <details className="toolkit-editor__scope"><summary>Local execution scope</summary><p>Your script can read and write local files, environment variables and the network. It uses your current user account; it is not sandboxed.</p></details>
    <div className="toolkit-editor__fields">
      <label><span><ThemeObjectFolderIcon size={13} /> Fixed working directory</span><TextInput value={tool.workspacePath} onChange={event => onEdit({ workspacePath: event.target.value })} placeholder="Choose an absolute local directory" /><small>Does not follow the current Agent or focused workspace.</small></label>
      <label className="toolkit-editor__toggle"><span><strong>Show in status bar</strong><small>Hide the entry and prevent new runs when off. An existing run keeps its captured version.</small></span><input type="checkbox" checked={tool.enabled} onChange={event => onEdit({ enabled: event.target.checked })} /></label>
      <div className="toolkit-editor__display">
        <label className="toolkit-editor__toggle"><span><strong>Evaluate when displayed</strong><small>Run a separate display script when its panel opens. No background polling.</small></span><input type="checkbox" aria-label="Evaluate when displayed" checked={Boolean(tool.display)} onChange={event => { onEdit({ display: event.target.checked ? { script: "console.log('Display ready')\n", args: [] } : null }); if (!event.target.checked) setDisplayOpen(false) }} /></label>
        {tool.display ? <button type="button" className="small-button" aria-pressed={displayOpen} onClick={() => { setActionId(null); setDisplayOpen(true) }}><ThemeObjectSourceCodeIcon size={13} /> Edit display script</button> : null}
      </div>
      <fieldset className="toolkit-settings__layout"><legend>Status bar appearance</legend><div className="toolkit-settings__choices">
        <LiquidSelectionSurface selected={tool.statusBar} active={active} targetAttribute="data-settings-target" />
        {(['icon', 'label'] as const).map(value => <label key={value} data-settings-target={value} data-selected={tool.statusBar === value}>
          <input type="radio" name={`${uid}-layout`} value={value} checked={tool.statusBar === value} onChange={() => onEdit({ statusBar: value })} />
          <ToolkitIcon icon={tool.icon} size={16} />{value === 'icon' ? 'Icon' : 'Icon and name'}
        </label>)}
      </div></fieldset>
      {(displayOpen ? Boolean(tool.display) : actionId === null || action) ? <details className="toolkit-editor__arguments"><summary>{displayOpen ? 'Display arguments' : actionId === null ? 'Arguments' : 'Action arguments'} <span>{args.length ? `· ${args.length}` : '· optional'}</span></summary>
        <p className="settings-hint">Each argument is a separate value. No shell expansion or interpolation.</p>
        {args.map((arg, index) => <label className="toolkit-argument" key={index}><span>Argument {index + 1}</span><TextInput value={arg} onChange={event => editScript({ args: args.map((value, i) => i === index ? event.target.value : value) })} /><button type="button" className="small-button" aria-label={`Remove argument ${index + 1}`} onClick={() => editScript({ args: args.filter((_, i) => i !== index) })}><ThemeActionRemoveArgumentIcon size={13} /></button></label>)}
        <button type="button" className="small-button" disabled={args.length >= 32} onClick={() => editScript({ args: [...args, ''] })}><ThemeActionAddArgumentIcon size={13} /> Add argument</button>
      </details> : null}
    </div>
    {runFeedback ? <p className="settings-hint" role="status">{runFeedback}</p> : null}
    {operationError ? <p className="settings-inline-error" role="alert">{operationError}</p> : null}
    <footer className="toolkit-editor__footer">
      <button type="button" className="small-button" disabled={entry.saving || removing} onClick={() => entry.expected ? setConfirmDelete(true) : void remove()}>{entry.expected ? <><ThemeActionRemoveIcon size={13} /> Delete tool</> : <><ThemeActionCancelIcon size={13} /> Cancel new tool</>}</button>
      <SettingsSaveBar save={save} dirty={dirty} disabled={invalid || entry.missing} label="Save tool" onSave={onSave} />
    </footer>
    <ConfirmationDialog open={active && confirmDelete} title="Delete this tool?" subject={tool.name} description="Remove the saved tool and its status bar entry. A running or unconfirmed execution prevents deletion." confirmLabel="Delete tool" busy={removing} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />
  </section>
}
