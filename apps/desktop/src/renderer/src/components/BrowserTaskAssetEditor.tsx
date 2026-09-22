import { useEffect, useState, type MouseEvent } from 'react'
import { CircleAlert, LocateFixed, Play, Plus, Save, Square, Trash2 } from 'lucide-react'
import type { BrowserDemonstrationDraft } from '../../../shared/browser-demonstration'
import type { BrowserTaskAsset, BrowserTaskAssetRun, BrowserTaskContent } from '../../../shared/browser-task-assets'

type ActionEvent = MouseEvent<HTMLButtonElement>
type Props = {
  asset: BrowserTaskAsset | null
  recording: BrowserDemonstrationDraft | null
  run?: BrowserTaskAssetRun | null
  warning?: string
  busy?: boolean
  onImport: (event: ActionEvent) => void
  onSaveDraft: (draft: BrowserTaskContent, event: ActionEvent) => Promise<void>
  onSaveVersion: (draft: BrowserTaskContent, event: ActionEvent) => Promise<void>
  onLocateStep: (stepId: string, event: ActionEvent) => void
  onRun: (input: { version: number; parameters: Record<string, string>; mode: 'run' | 'step'; runId?: string }, event: ActionEvent) => Promise<void>
  onStop: (runId: string, event: ActionEvent) => void
}

/** An editable Client asset inside existing Browser details. Values never enter its draft or versions. */
export function BrowserTaskAssetEditor({ asset, recording, run, warning, busy = false, onImport, onSaveDraft, onSaveVersion, onLocateStep, onRun, onStop }: Props) {
  const [draft, setDraft] = useState<BrowserTaskContent | null>(asset?.draft ?? null)
  const [versionNumber, setVersionNumber] = useState(asset?.versions.at(-1)?.version ?? 0)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  useEffect(() => { setDraft(asset?.draft ?? null); setVersionNumber(asset?.versions.at(-1)?.version ?? 0) }, [asset?.id, asset?.revision])
  useEffect(() => { setValues({}); setError(undefined) }, [asset?.id])
  const version = asset?.versions.find(item => item.version === versionNumber)
  const continuing = Boolean(run && asset && run.assetId === asset.id && run.version === versionNumber && (run.status === 'ready' || run.status === 'waiting-human'))
  const pending = version?.steps.slice(continuing && run ? run.nextStep : 0) ?? []
  const checkpoint = pending.findIndex(step => step.kind === 'checkpoint')
  const segment = checkpoint >= 0 ? pending.slice(0, checkpoint) : pending
  const requiredKeys = new Set(segment.flatMap(step => step.kind === 'fill' && step.parameterKey ? [step.parameterKey] : []))
  const parameters = version?.parameters.filter(parameter => requiredKeys.has(parameter.key)) ?? []
  const canRun = Boolean(version && !busy && parameters.every(parameter => Boolean(values[parameter.key])))
  function change(next: BrowserTaskContent): void { setDraft(next); setError(undefined) }
  async function save(event: ActionEvent, asVersion: boolean): Promise<void> {
    if (!draft) return
    try { await (asVersion ? onSaveVersion : onSaveDraft)(draft, event); setError(undefined) }
    catch (error) { setError(error instanceof Error ? error.message : 'Task changes could not be saved. The local draft remains available.') }
  }
  async function execute(event: ActionEvent, mode: 'run' | 'step'): Promise<void> {
    if (!version) return
    try {
      await onRun({ version: version.version, parameters: { ...values }, mode, ...(continuing && run ? { runId: run.id } : {}) }, event)
      setError(undefined)
    } catch (error) { setError(error instanceof Error ? error.message : 'Task execution could not start. Inspect the page before retrying.') }
    finally {
      const secretKeys = new Set(version.parameters.filter(parameter => parameter.secret).map(parameter => parameter.key))
      setValues(current => Object.fromEntries(Object.entries(current).filter(([key]) => !secretKeys.has(key))))
    }
  }
  if (!asset) return recording || warning || error ? <section className="browser-task-asset-entry" aria-label="Editable Browser task asset">
    {recording ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet"
      disabled={busy || recording.status === 'recording'} onClick={onImport}><Plus size={11} aria-hidden="true" />Edit demonstration</button> : null}
    {[warning, error].filter(Boolean).map((message, index) => <p key={index} className="browser-rsi-timeline__warning" role="status"><CircleAlert size={12} aria-hidden="true" />{message}</p>)}
  </section> : null
  return <section className="browser-rsi-replay browser-task-asset" aria-label="Editable Browser task asset" data-task-asset-id={asset.id}>
    <header className="browser-rsi-replay__header"><strong>Task asset</strong>
      <small>{asset.id} · draft r{asset.revision}</small>
    </header>
    {warning || error ? <p className="browser-rsi-timeline__warning" role="status"><CircleAlert size={12} aria-hidden="true" />{warning ?? error}</p> : null}
    {draft ? <>
      <label className="browser-task-asset__field"><span>Name</span><input aria-label="Task asset name" maxLength={240} value={draft.name} onChange={event => change({ ...draft, name: event.target.value })} /></label>
      <ol className="browser-rsi-replay__steps">{draft.steps.length ? draft.steps.map((step, index) => <li key={step.id} className={!step.reviewed ? 'is-blocked' : undefined} data-task-step-id={step.id}>
        <span className="browser-rsi-replay__step-number">{index + 1}</span>
        <span><strong>{step.kind === 'checkpoint' ? step.label || 'Human checkpoint' : `${step.kind} · ${step.target?.name ?? (step.kind === 'navigate' ? step.url : 'Target needs location')}`}</strong>
          {step.warning && !step.reviewed ? <small>{step.warning}</small> : null}
          {step.kind !== 'checkpoint' ? <label className="browser-task-asset__check"><input type="checkbox" aria-label={`Review task step ${index + 1}`} checked={step.reviewed} disabled={step.kind !== 'navigate' && (!step.target || step.target.count !== 1)} onChange={event => change({ ...draft, steps: draft.steps.map(item => item.id === step.id ? { ...item, reviewed: event.target.checked } : item) })} />Reviewed</label> : <><small>Hands control to the person; never approves itself</small><input aria-label={`Checkpoint ${index + 1} label`} value={step.label ?? ''} maxLength={240} onChange={event => change({ ...draft, steps: draft.steps.map(item => item.id === step.id ? { ...item, label: event.target.value } : item) })} /></>}
        </span>
        <span className="browser-task-asset__step-actions">{step.kind !== 'checkpoint' ? <button type="button" className="browser-rsi-icon-button" aria-label={`Locate task step ${index + 1}`} onClick={event => onLocateStep(step.id, event)} disabled={busy}><LocateFixed size={11} aria-hidden="true" /></button> : null}<button type="button" className="browser-rsi-icon-button" aria-label={`Insert checkpoint after task step ${index + 1}`} disabled={busy || draft.steps.length >= 128} onClick={() => change({ ...draft, steps: [...draft.steps.slice(0, index + 1), { id: crypto.randomUUID(), kind: 'checkpoint', url: step.url, label: 'Human checkpoint', reviewed: true }, ...draft.steps.slice(index + 1)] })}><Plus size={11} aria-hidden="true" /></button><button type="button" className="browser-rsi-icon-button" aria-label={`Delete task step ${index + 1}`} disabled={busy} onClick={() => change({ ...draft, steps: draft.steps.filter(item => item.id !== step.id) })}><Trash2 size={11} aria-hidden="true" /></button></span>
      </li>) : <li className="browser-rsi-timeline__empty">No steps · deleted steps stay deleted</li>}</ol>
      <button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy || draft.steps.length >= 128} onClick={() => change({ ...draft, steps: [...draft.steps, { id: crypto.randomUUID(), kind: 'checkpoint', url: draft.url, label: 'Human checkpoint', reviewed: true }] })}><Plus size={11} aria-hidden="true" />Add checkpoint</button>
      {draft.parameters.length ? <details className="browser-task-asset__parameters"><summary>Parameter definitions · {draft.parameters.length}</summary>{draft.parameters.map((parameter, index) => <div key={index} className="browser-task-asset__parameter">
        <label className="browser-task-asset__field"><span>Key</span><input aria-label={`Parameter ${index + 1} key`} value={parameter.key} maxLength={64} onChange={event => change({ ...draft, parameters: draft.parameters.map((item, i) => i === index ? { ...item, key: event.target.value } : item), steps: draft.steps.map(step => step.parameterKey === parameter.key ? { ...step, parameterKey: event.target.value } : step) })} /></label>
        <label className="browser-task-asset__field"><span>Label</span><input aria-label={`Parameter ${index + 1} label`} value={parameter.label} maxLength={240} onChange={event => change({ ...draft, parameters: draft.parameters.map((item, i) => i === index ? { ...item, label: event.target.value } : item) })} /></label>
        <label className="browser-task-asset__check"><input type="checkbox" checked={parameter.secret} onChange={event => change({ ...draft, parameters: draft.parameters.map((item, i) => i === index ? { ...item, secret: event.target.checked } : item) })} />Secret · ask again</label>
      </div>)}</details> : null}
      <footer className="browser-rsi-replay__actions"><button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy} onClick={event => void save(event, false)}><Save size={11} aria-hidden="true" />Save draft</button><button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy || !draft.steps.length} onClick={event => void save(event, true)}>Save version</button></footer>
      {asset.versions.length ? <div className="browser-task-asset__version">
        <label className="browser-task-asset__field"><span>Run saved version</span><select aria-label="Task asset version" value={versionNumber} onChange={event => { setVersionNumber(Number(event.target.value)); setValues({}) }}>{asset.versions.map(item => <option key={item.version} value={item.version}>v{item.version} · {item.name}</option>)}</select></label>
        <details><summary>Preview v{versionNumber} · {version?.steps.length ?? 0} steps</summary><ol className="browser-rsi-replay__steps">{version?.steps.map((step, index) => <li key={step.id}><span>{index + 1}</span><span><strong>{step.label ?? step.target?.name ?? step.kind}</strong><small>{step.reviewed ? step.parameterKey ? `Fresh ${step.parameterKey}` : step.kind : 'Needs review'}</small></span></li>)}</ol></details>
        {parameters.map(parameter => <label key={parameter.key} className="browser-task-asset__field"><span>{parameter.label}</span><input type={parameter.secret ? 'password' : 'text'} autoComplete="off" aria-label={`Task parameter ${parameter.label}`} maxLength={16_384} value={values[parameter.key] ?? ''} onChange={event => setValues(current => ({ ...current, [parameter.key]: event.target.value }))} /></label>)}
        {run && run.assetId === asset.id ? <p className="browser-task-asset__progress" role="status">v{run.version} · {run.status} · next step {run.nextStep + 1}{run.warning ? ` · ${run.warning}` : ''}</p> : null}
        <footer className="browser-rsi-replay__actions"><button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={!canRun} onClick={event => void execute(event, 'step')}>Run next step</button><button type="button" className="browser-rsi-button browser-rsi-button--primary" disabled={!canRun} onClick={event => void execute(event, 'run')}><Play size={11} aria-hidden="true" />{continuing ? 'Return control and continue' : 'Run version'}</button>{run && (busy || run.status === 'ready' || run.status === 'waiting-human') ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={event => onStop(run.id, event)}><Square size={11} aria-hidden="true" />Stop task</button> : null}</footer>
      </div> : <p className="browser-rsi-replay__origin">Save a reviewed version before running. Editing the draft never changes an existing version.</p>}
    </> : null}
  </section>
}
