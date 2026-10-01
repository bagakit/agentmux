import type { BrowserTaskStep } from '../../../shared/browser-task-assets'

type Props = { step: BrowserTaskStep; laterSteps: BrowserTaskStep[]; index: number; onChange: (step: BrowserTaskStep) => void }

/** The two forward paths are explicit and editable beside their condition. No expression editor. */
export function BrowserTaskBranchEditor({ step, laterSteps, index, onChange }: Props) {
  if (!step.branch) return <small>Condition declaration is unavailable</small>
  const branch = step.branch, condition = branch.condition
  const update = (next: typeof branch) => onChange({ ...step, branch: next, reviewed: false })
  return <div className="browser-task-branch">
    <label className="browser-task-asset__field"><span>If</span><select aria-label={`Condition ${index + 1} fact`} value={condition.kind}
      onChange={event => update({ ...branch, condition: event.target.value === 'page-url-is' ? { kind: 'page-url-is', url: step.url }
        : { kind: 'element-present', target: { role: 'button', name: '' } } })}>
      <option value="page-url-is">Page URL is</option><option value="element-present">Element is present</option>
    </select></label>
    {condition.kind === 'page-url-is' ? <input aria-label={`Condition ${index + 1} URL`} value={condition.url} maxLength={2048}
      onChange={event => update({ ...branch, condition: { ...condition, url: event.target.value } })} />
      : <><input placeholder="Role" aria-label={`Condition ${index + 1} role`} value={condition.target.role} maxLength={240}
        onChange={event => update({ ...branch, condition: { ...condition, target: { ...condition.target, role: event.target.value } } })} />
        <input placeholder="Name" aria-label={`Condition ${index + 1} name`} value={condition.target.name} maxLength={240}
          onChange={event => update({ ...branch, condition: { ...condition, target: { ...condition.target, name: event.target.value } } })} /></>}
    {(['onTrue', 'onFalse'] as const).map(key => <label key={key} className="browser-task-asset__field"><span>{key === 'onTrue' ? 'True' : 'False'}</span>
      <select aria-label={`Condition ${index + 1} ${key === 'onTrue' ? 'true' : 'false'} path`} value={branch[key] ?? ''}
        onChange={event => update({ ...branch, [key]: event.target.value || null })}>
        <option value="">Finish this path</option>{laterSteps.map((item, offset) => <option key={item.id} value={item.id}>{index + offset + 2} · {item.label || item.target?.name || item.kind}</option>)}
      </select></label>)}
    <small>Unknown stops here for inspection; it never chooses False.</small>
  </div>
}
