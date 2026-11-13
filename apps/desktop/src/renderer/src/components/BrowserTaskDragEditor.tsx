import { TextInput } from '@agentmux/client-ui/input'
import type { BrowserTaskStep } from '../../../shared/browser-task-assets'

/** Both declarations resolve from the same fresh page snapshot before any native input. */
export function BrowserTaskDragEditor({ step, index, onChange }: { step: BrowserTaskStep; index: number; onChange(step: BrowserTaskStep): void }) {
  return <span className="browser-task-drag">
    <small>Each end must match one element on the reviewed page.</small>
    {(['target', 'destination'] as const).map(endpoint => <span key={endpoint}>
      {(['role', 'name'] as const).map(field => <label key={field} className="browser-task-asset__field">
        <span>{endpoint === 'target' ? 'Source' : 'Drop target'} {field}</span>
        <TextInput aria-label={`Task step ${index + 1} ${endpoint === 'target' ? 'source' : 'destination'} ${field}`}
          maxLength={240} value={step[endpoint]?.[field] ?? ''} onChange={event => {
            const target = { role: '', name: '', ...step[endpoint], [field]: event.target.value, ordinal: 1, count: 1 }
            onChange({ ...step, [endpoint]: target, reviewed: false })
          }} />
      </label>)}
    </span>)}
  </span>
}
