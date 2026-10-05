import { mintObjectId } from '@agentmux/core/object-id'
import { TextInput } from '@agentmux/client-ui/input'
import { useEffect, useState, type MouseEvent } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { BrowserTaskAssetRun, BrowserTaskBatchRun, BrowserTaskVersion } from '../../../shared/browser-task-assets'
import { browserTaskSegment } from '../../../shared/browser-task-path'

const ThemeActionRemoveIcon = semanticIconComponent('action.remove')
const ThemeActionAddItemIcon = semanticIconComponent('action.add-item')
const ThemeActionStopIcon = semanticIconComponent('action.stop')


type Props = {
  version: BrowserTaskVersion
  batch?: BrowserTaskBatchRun | null
  runs: BrowserTaskAssetRun[]
  busy: boolean
  onRun: (input: { version: number; batchId?: string; items: { id: string; parameters: Record<string, string> }[]; parameters: Record<string, string> }, event: MouseEvent<HTMLButtonElement>) => Promise<void>
  onStop: (batchId: string, event: MouseEvent<HTMLButtonElement>) => void
}

/** Ephemeral values accompany an invocation; the retained group contains only item/run identities. */
export function BrowserTaskBatchEditor({ version, batch, runs, busy, onRun, onStop }: Props) {
  const [startNew, setStartNew] = useState(false)
  const original = !startNew && batch?.version === version.version ? batch : null
  const [items, setItems] = useState<{ id: string; parameters: Record<string, string> }[]>(() => original?.items.map(item => ({ id: item.id, parameters: {} })) ?? [{ id: mintObjectId(), parameters: {} }])
  const [fresh, setFresh] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  useEffect(() => { setItems(original?.items.map(item => ({ id: item.id, parameters: {} })) ?? [{ id: mintObjectId(), parameters: {} }]); setFresh({}); setError(undefined) }, [version.version, original?.id])
  useEffect(() => { setStartNew(false) }, [version.version, batch?.id])
  const currentRun = runs.find(run => run.id === original?.items[original.nextItem]?.runId)
  const required = new Set(browserTaskSegment(version.steps, currentRun?.nextStep ?? 0).flatMap(step => step.parameterKey ? [step.parameterKey] : []))
  const secrets = version.parameters.filter(parameter => parameter.secret && required.has(parameter.key))
  const editable = !busy && (!original || original.status === 'ready' || original.status === 'waiting-human')
  const status = (value: BrowserTaskAssetRun['status']) => value === 'completed' ? 'steps completed' : value
  async function execute(event: MouseEvent<HTMLButtonElement>) {
    try {
      await onRun({ version: version.version, items: items.map(item => ({ id: item.id, parameters: { ...item.parameters } })), parameters: { ...fresh }, ...(original ? { batchId: original.id } : {}) }, event)
      setError(undefined)
    } catch (error) { setError(error instanceof Error ? error.message : 'Batch could not start. Existing item runs remain available.') }
    finally { setFresh({}) }
  }
  return <details className="browser-task-asset__parameters browser-task-batch" open={original ? true : undefined}>
    <summary>Batch · {original ? `${original.nextItem}/${original.items.length} · ${status(original.status)}` : `${items.length} item${items.length === 1 ? '' : 's'}`}</summary>
    <small>Each item uses this saved version. Unknown results or human checkpoints pause here. Values are supplied again; completed items stay completed. Steps completed are not verified outcomes.</small>
    {original?.warning ? <p className="browser-rsi-timeline__warning" role="status">{original.warning}</p> : null}
    {error ? <p className="browser-rsi-timeline__warning" role="status">{error}</p> : null}
    {items.map((item, index) => {
      const run = runs.find(run => run.id === original?.items[index]?.runId), completed = original && index < original.nextItem
      return <div key={item.id} className="browser-task-batch__item" data-task-batch-item={item.id}>
        <strong>Item {index + 1}{run ? ` · ${status(run.status)}` : ''}</strong>
        {run ? <small title={run.id}>Run {run.id.slice(0, 8)} · {run.operationIds.length} operation{run.operationIds.length === 1 ? '' : 's'} · outcomes in retained version results</small> : null}
        {run?.warning ? <small>{run.warning}</small> : null}
        {!completed ? version.parameters.filter(parameter => !parameter.secret).map(parameter => <label key={parameter.key} className="browser-task-asset__field"><span>{parameter.label}</span>
          <TextInput aria-label={`Batch item ${index + 1} ${parameter.label}`} autoComplete="off" maxLength={16_384} disabled={!editable}
            value={item.parameters[parameter.key] ?? ''} onChange={event => setItems(current => current.map(row => row.id === item.id ? { ...row, parameters: { ...row.parameters, [parameter.key]: event.target.value } } : row))} /></label>) : null}
        {!original ? <button type="button" className="browser-rsi-icon-button" aria-label={`Remove batch item ${index + 1}`} disabled={busy || items.length <= 1} onClick={() => setItems(current => current.filter(row => row.id !== item.id))}><ThemeActionRemoveIcon size={11} aria-hidden="true" /></button> : null}
      </div>
    })}
    {!original ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy || items.length >= 16} onClick={() => setItems(current => [...current, { id: mintObjectId(), parameters: {} }])}><ThemeActionAddItemIcon size={11} aria-hidden="true" />Add item</button> : null}
    {secrets.map(parameter => <label key={parameter.key} className="browser-task-asset__field"><span>{parameter.label} · fresh</span><TextInput type="password" autoComplete="off" aria-label={`Batch fresh ${parameter.label}`} maxLength={16_384} value={fresh[parameter.key] ?? ''} disabled={!editable} onChange={event => setFresh(current => ({ ...current, [parameter.key]: event.target.value }))} /></label>)}
    <footer className="browser-rsi-replay__actions"><button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={!editable} onClick={event => void execute(event)}>{original ? 'Return control and continue batch' : 'Run batch'}</button>
      {original && ['completed', 'interrupted', 'failed', 'stopped'].includes(original.status) ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy} onClick={() => setStartNew(true)}>New batch</button> : null}
      {original && ['ready', 'running', 'waiting-human'].includes(original.status) ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={event => onStop(original.id, event)}><ThemeActionStopIcon size={11} aria-hidden="true" />Stop batch</button> : null}</footer>
  </details>
}
