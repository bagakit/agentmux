import { TextInput } from '@agentmux/client-ui/input'
import type { BrowserTaskStep } from '../../../shared/browser-task-assets'

const kinds = ['tap', 'longPress', 'swipe', 'pinch'] as const
const labels = { tap: 'Tap', longPress: 'Long press', swipe: 'Swipe', pinch: 'Pinch' }
export const isBrowserTaskGesture = (kind: BrowserTaskStep['kind']): kind is typeof kinds[number] => kinds.some(value => value === kind)

/** Gesture declarations use the same reviewed semantic targets as native drag. */
export function BrowserTaskGestureEditor({ step, index, onChange }: { step: BrowserTaskStep; index: number; onChange(step: BrowserTaskStep): void }) {
  if (!isBrowserTaskGesture(step.kind)) return null
  const numeric = step.kind === 'longPress' ? 'durationMs' : step.kind === 'pinch' ? 'scale' : undefined
  return <span className="browser-task-gesture">
    <label className="browser-task-asset__field"><span>Gesture</span><select aria-label={`Task step ${index + 1} gesture`} value={step.kind} onChange={event => {
      const { durationMs: _duration, scale: _scale, destination: _destination, ...base } = step
      onChange({ ...base, kind: event.target.value as typeof kinds[number], reviewed: false })
    }}>{kinds.map(kind => <option key={kind} value={kind}>{labels[kind]}</option>)}</select></label>
    <small>Each target must match one element on the reviewed page.</small>
    {(step.kind === 'swipe' ? ['target', 'destination'] as const : ['target'] as const).map(endpoint => <span key={endpoint}>
      {(['role', 'name'] as const).map(field => <label key={field} className="browser-task-asset__field">
        <span>{endpoint === 'destination' ? 'End target' : step.kind === 'swipe' ? 'Source' : 'Target'} {field}</span>
        <TextInput aria-label={`Task step ${index + 1} ${endpoint} ${field}`} maxLength={240} value={step[endpoint]?.[field] ?? ''} onChange={event =>
          onChange({ ...step, [endpoint]: { role: '', name: '', ...step[endpoint], [field]: event.target.value, ordinal: 1, count: 1 }, reviewed: false })} />
      </label>)}
    </span>)}
    {numeric ? <label className="browser-task-asset__field"><span>{numeric === 'durationMs' ? 'Hold (ms)' : 'Scale'}</span>
      <TextInput type="number" aria-label={`Task step ${index + 1} ${numeric}`} value={step[numeric] ?? (numeric === 'durationMs' ? 600 : 2)} onChange={event => {
        const value = Number(event.target.value), { [numeric]: _value, ...base } = step
        onChange({ ...base, [numeric]: value, reviewed: false })
      }} /></label> : null}
  </span>
}
