import { TextInput } from '@agentmux/client-ui/input'
import type { BrowserTaskParameter, BrowserTaskStep } from '../../../shared/browser-task-assets'

type Props = { dialogTypes?: readonly import('@agentmux/core').AgentMuxBrowserDialogType[] | undefined; step: BrowserTaskStep; index: number; parameters: BrowserTaskParameter[]; onChange(step: BrowserTaskStep, parameters: BrowserTaskParameter[]): void }
export function newBrowserTaskParameter(parameters: BrowserTaskParameter[], prefix: string, label: string): BrowserTaskParameter {
  let suffix = 1
  while (parameters.some(parameter => parameter.key === `${prefix}${suffix}`)) suffix++
  return { key: `${prefix}${suffix}`, label, secret: true }
}

/** Definitions name fresh inputs; they never retain a chosen file or a prompt answer. */
export function BrowserTaskFileDialogEditor({ dialogTypes, step, index, parameters, onChange }: Props) {
  if (step.kind !== 'upload' && step.kind !== 'click') return null
  const update = (next: BrowserTaskStep, definitions = parameters) => onChange({ ...next, reviewed: false }, definitions)
  const addFile = () => {
    const parameter = newBrowserTaskParameter(parameters, 'file', 'Workspace file')
    update({ ...step, kind: 'upload', parameterKeys: [...(step.parameterKeys ?? []), parameter.key] }, [...parameters, parameter])
  }
  if (step.kind === 'upload') return <span className="browser-task-file-dialog">
    <small>Locate the actual file input. Supply Workspace paths again when this version runs.</small>
    {(step.parameterKeys ?? []).map((key, file) => <label key={file} className="browser-task-asset__field"><span>File {file + 1}</span>
      <select aria-label={`Task step ${index + 1} file ${file + 1} parameter`} value={key} onChange={event => update({ ...step, parameterKeys: step.parameterKeys!.map((value, position) => position === file ? event.target.value : value) })}>
        {parameters.map(parameter => <option key={parameter.key} value={parameter.key}>{parameter.label} · {parameter.key}</option>)}
      </select>
      {(step.parameterKeys?.length ?? 0) > 1 ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" aria-label={`Remove file ${file + 1} from task step ${index + 1}`} onClick={() => update({ ...step, parameterKeys: step.parameterKeys!.filter((_, position) => position !== file) })}>Remove</button> : null}
    </label>)}
    {(step.parameterKeys?.length ?? 0) < 4 ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={addFile}>Add file parameter</button> : null}
    {(['role', 'name'] as const).map(field => <label key={field} className="browser-task-asset__field"><span>Input {field}</span><TextInput
      aria-label={`Task step ${index + 1} input ${field}`} maxLength={240} value={step.target?.[field] ?? ''}
      onChange={event => update({ ...step, target: { role: '', name: '', ...step.target, [field]: event.target.value, ordinal: 1, count: 1 } })} /></label>)}
  </span>
  const dialog = step.dialog
  return <details className="browser-task-asset__parameters" open={dialog ? true : undefined}>
    <summary>Dialog after click{dialog ? ` · ${dialog.action} ${dialog.type}` : ' · optional'}</summary>
    <small>Answer one expected dialog during this click. This does not approve a human checkpoint.</small>
    <label className="browser-task-asset__field"><span>Expected dialog</span><select aria-label={`Task step ${index + 1} dialog type`} value={dialog?.type ?? ''} onChange={event => {
      const { dialog: previous, ...base } = step
      void previous
      const type = event.target.value as NonNullable<BrowserTaskStep['dialog']>['type'] | ''
      if (!type) return update(base)
      update({ ...base, dialog: { type, action: 'dismiss' } })
    }}><option value="">No dialog decision</option><option value="alert">Alert</option><option value="confirm">Confirm</option><option value="prompt">Prompt{dialogTypes && !dialogTypes.includes('prompt') ? ' · unavailable here' : ''}</option><option value="beforeunload">Leave page · keep page only</option></select></label>
    {dialog ? <label className="browser-task-asset__field"><span>Answer</span><select aria-label={`Task step ${index + 1} dialog answer`} value={dialog.action} onChange={event => {
      const action = event.target.value as 'accept' | 'dismiss'
      const parameter = action === 'accept' && dialog.type === 'prompt' ? newBrowserTaskParameter(parameters, 'prompt', 'Prompt answer') : undefined
      update({ ...step, dialog: { type: dialog.type, action, ...(parameter ? { promptParameterKey: parameter.key } : {}) } }, parameter ? [...parameters, parameter] : parameters)
    }}><option value="dismiss">{dialog.type === 'beforeunload' ? 'Keep the page' : 'Cancel / close'}</option>{dialog.type !== 'beforeunload' ? <option value="accept">OK</option> : null}</select></label> : null}
    {dialog?.type === 'prompt' && !dialogTypes?.includes('prompt') ? <small role="status">{dialogTypes ? 'Prompt dialogs are unavailable in this Browser host. Keep this declaration for a compatible host.' : 'Prompt availability is unconfirmed for this target. A real native prompt event is required to answer it.'}</small> : null}
    {dialog?.promptParameterKey ? <label className="browser-task-asset__field"><span>Fresh answer</span><select aria-label={`Task step ${index + 1} prompt parameter`} value={dialog.promptParameterKey} onChange={event => update({ ...step, dialog: { ...dialog, promptParameterKey: event.target.value } })}>
      {parameters.map(parameter => <option key={parameter.key} value={parameter.key}>{parameter.label} · {parameter.key}</option>)}
    </select></label> : null}
  </details>
}
