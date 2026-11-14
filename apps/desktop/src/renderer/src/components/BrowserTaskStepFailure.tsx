import type { BrowserTaskStep } from '../../../shared/browser-task-assets'
import { BROWSER_TASK_MAX_RETRIES } from '../../../shared/browser-task-path'

type Props = { step: BrowserTaskStep; laterSteps: BrowserTaskStep[]; index: number; onChange: (step: BrowserTaskStep) => void }

const WAIT_LABEL = { 'element-present': 'until present', 'url-is': 'until URL is' } as const
const ASSERT_LABEL = { 'element-present': 'is present', 'element-absent': 'is absent', 'url-is': 'URL is', 'text-present': 'text present' } as const
const element = (target: { role: string; name: string }) => `${target.role} "${target.name}"`

/** One readable line per step: what it does and its key parameter, never a raw kind alone. */
export function browserTaskStepSummary(step: BrowserTaskStep): string {
  if (step.kind === 'extract') return `Extract · ${step.extraction?.fields.map(field => field.key).join(', ') || 'Fields need definition'}`
  if (step.kind === 'wait' && step.wait) {
    const subject = step.wait.kind === 'url-is' ? step.wait.url : element(step.wait.target)
    return `Wait ${WAIT_LABEL[step.wait.kind]} · ${subject} · ${(step.timeoutMs ?? 0) / 1000} s`
  }
  if (step.kind === 'assert' && step.assert) {
    const fact = step.assert
    const subject = fact.kind === 'url-is' ? fact.url : fact.kind === 'text-present' ? `"${fact.text}"` : element(fact.target)
    return `Assert ${ASSERT_LABEL[fact.kind]} · ${subject}`
  }
  if (step.kind === 'subflow' && step.subflow) return `${step.subflow.iteration === 'each' ? 'Each item' : 'Call once'} · ${step.subflow.target.kind === 'local' ? `saved v${step.subflow.target.version}` : 'local version needed'}`
  const target = step.target?.name ?? 'Target needs location'
  if (step.kind === 'upload') return `Upload · ${target} · ${(step.parameterKeys ?? []).join(', ') || 'Fresh files needed'}`
  if (step.kind === 'click' && step.dialog) return `Click · ${target} · ${step.dialog.action} ${step.dialog.type}`
  if (step.kind === 'drag') return `Drag · ${target} → ${step.destination?.name ?? 'Drop target needs location'}`
  if (step.kind === 'swipe') return `Swipe · ${target} → ${step.destination?.name ?? 'End target needs location'}`
  if (step.kind === 'tap') return `Tap · ${target}`
  if (step.kind === 'longPress') return `Long press · ${target} · ${step.durationMs ?? 600} ms`
  if (step.kind === 'pinch') return `Pinch · ${target} · ${step.scale ?? 2}×`
  if (step.kind === 'press') return `Press ${step.key ?? 'key'} · ${target}`
  if (step.kind === 'hover') return `Hover · ${target}`
  if (step.kind === 'scroll') return `Scroll to · ${target}`
  return `${step.kind} · ${step.kind === 'navigate' ? step.url : target}`
}

/** Compact failure handling for a page step. Retries apply only to known script failures. */
export function BrowserTaskStepFailureEditor({ step, laterSteps, index, onChange }: Props) {
  const onFail = step.onFail ?? 'stop'
  const value = typeof onFail === 'object' ? `goto:${onFail.goto}` : onFail
  const update = (next: { onFail: BrowserTaskStep['onFail']; retry: BrowserTaskStep['retry'] }) => {
    const { onFail: _onFail, retry: _retry, ...rest } = step
    void _onFail; void _retry
    onChange({ ...rest, ...(next.onFail && next.onFail !== 'stop' ? { onFail: next.onFail } : {}), ...(next.retry ? { retry: next.retry } : {}) })
  }
  return <span className="browser-task-step-failure">
    <label className="browser-task-asset__field"><span>On failure</span>
      <select aria-label={`Task step ${index + 1} on failure`} value={value}
        onChange={event => update({ retry: step.retry, onFail: event.target.value === 'stop' || event.target.value === 'continue' ? event.target.value : { goto: event.target.value.slice(5) } })}>
        <option value="stop">Stop the run</option><option value="continue">Continue, record failure</option>
        {laterSteps.map((item, offset) => <option key={item.id} value={`goto:${item.id}`}>Go to {index + offset + 2} · {item.label || item.target?.name || item.kind}</option>)}
      </select></label>
    <label className="browser-task-asset__field"><span>Retry</span>
      <select aria-label={`Task step ${index + 1} retries`} value={step.retry ?? 0} onChange={event => update({ onFail: step.onFail, retry: Number(event.target.value) })}>
        {Array.from({ length: BROWSER_TASK_MAX_RETRIES + 1 }, (_, count) => <option key={count} value={count}>{count ? `${count}×` : 'None'}</option>)}
      </select></label>
  </span>
}
