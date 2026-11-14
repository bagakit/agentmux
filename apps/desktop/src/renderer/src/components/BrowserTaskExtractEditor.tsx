import { TextInput } from '@agentmux/client-ui/input'
import type { BrowserTaskCompletion, BrowserTaskStep } from '../../../shared/browser-task-assets'
import type { BrowserStructuredFieldRequest } from '@agentmux/browser/model/browser-structured-output'

/** Edits definitions only. Values are read later from the original operation's artifact. */
export function BrowserTaskExtractEditor({ step, criteria, busy, onChange, onCriteria }: {
  step: BrowserTaskStep
  criteria: BrowserTaskCompletion['criteria']
  busy: boolean
  onChange(step: BrowserTaskStep, criteria?: BrowserTaskCompletion['criteria']): void
  onCriteria(criteria: BrowserTaskCompletion['criteria']): void
}) {
  const request = step.extraction
  if (!request) return null
  const update = (fields: BrowserStructuredFieldRequest[]) => onChange({ ...step, reviewed: false, extraction: { ...request, fields } })
  return <fieldset className="browser-task-extract" disabled={busy} aria-label={`Extraction ${step.id}`}>
    <legend>Save selected fields</legend>
    <small>Only these fields become a recorded result. Private invocation values are not retained.</small>
    <label className="browser-task-asset__field"><span>Within CSS (optional)</span><TextInput
      aria-label={`Extraction ${step.id} within`} value={request.within ?? ''} maxLength={512} placeholder="Entire main document"
      onChange={event => onChange({ ...step, reviewed: false, extraction: { fields: request.fields, ...(event.target.value ? { within: event.target.value } : {}) } })} /></label>
    {request.fields.map((field, index) => {
      const condition = criteria.find(item => item.kind === 'field-equals' && item.stepId === step.id && item.key === field.key)
      const expected = condition?.kind === 'field-equals' ? condition.expected : undefined
      const replaceCondition = (value: string | number | boolean | undefined) => onCriteria([
        ...criteria.filter(item => item.kind !== 'field-equals' || item.stepId !== step.id || item.key !== field.key),
        ...(value === undefined ? [] : [{ kind: 'field-equals' as const, stepId: step.id, key: field.key, expected: value }])
      ])
      const changeField = (next: BrowserStructuredFieldRequest) => {
        const nextCriteria = next.key !== field.key || next.type !== field.type ? criteria.filter(item => item.kind !== 'field-equals' || item.stepId !== step.id || item.key !== field.key) : undefined
        onChange({ ...step, reviewed: false, extraction: { ...request, fields: request.fields.map((item, i) => i === index ? next : item) } }, nextCriteria)
      }
      return <div className="browser-task-extract__field" key={index}>
        <label className="browser-task-asset__field"><span>Field key</span><TextInput aria-label={`Extraction field ${index + 1} key`} maxLength={64} value={field.key}
          onChange={event => changeField({ ...field, key: event.target.value })} /></label>
        <label className="browser-task-asset__field"><span>Type</span><select aria-label={`Extraction field ${index + 1} type`} value={field.type}
          onChange={event => changeField({ ...field, type: event.target.value as BrowserStructuredFieldRequest['type'] })}>
          <option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option></select></label>
        <label className="browser-task-asset__field"><span>CSS selector</span><TextInput aria-label={`Extraction field ${index + 1} selector`} maxLength={512} value={field.source.selector}
          onChange={event => changeField({ ...field, source: { ...field.source, selector: event.target.value } })} /></label>
        <label className="browser-task-asset__field"><span>Read</span><select aria-label={`Extraction field ${index + 1} read`} value={field.source.read}
          onChange={event => changeField({ ...field, source: { selector: field.source.selector, read: event.target.value as BrowserStructuredFieldRequest['source']['read'], ...(event.target.value === 'attribute' ? { attribute: 'data-value' } : {}) } })}>
          <option value="text">Text</option><option value="value">Input value</option><option value="checked">Checked</option><option value="attribute">Attribute</option></select></label>
        {field.source.read === 'attribute' ? <label className="browser-task-asset__field"><span>Attribute</span><TextInput aria-label={`Extraction field ${index + 1} attribute`} value={field.source.attribute ?? ''} maxLength={64}
          onChange={event => changeField({ ...field, source: { ...field.source, attribute: event.target.value } })} /></label> : null}
        <label className="browser-task-asset__check"><input type="checkbox" aria-label={`Require extraction field ${index + 1}`} checked={expected !== undefined}
          onChange={event => replaceCondition(event.target.checked ? field.type === 'number' ? 0 : field.type === 'boolean' ? false : '' : undefined)} />Require value</label>
        {expected !== undefined ? <label className="browser-task-asset__field"><span>Equals</span>{field.type === 'boolean'
          ? <select aria-label={`Extraction field ${index + 1} expected`} value={String(expected)} onChange={event => replaceCondition(event.target.value === 'true')}><option value="false">False</option><option value="true">True</option></select>
          : <TextInput aria-label={`Extraction field ${index + 1} expected`} type={field.type === 'number' ? 'number' : 'text'} value={typeof expected === 'number' && !Number.isFinite(expected) ? '' : String(expected)}
            onChange={event => replaceCondition(field.type === 'number' ? event.target.value === '' ? NaN : Number(event.target.value) : event.target.value)} />}</label> : null}
        <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={() => onChange({ ...step, reviewed: false, extraction: { ...request, fields: request.fields.filter((_, i) => i !== index) } }, criteria.filter(item => item.kind !== 'field-equals' || item.stepId !== step.id || item.key !== field.key))}>Remove field {index + 1}</button>
      </div>
    })}
    <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={() => {
      let suffix = 1
      while (request.fields.some(field => field.key === `field${suffix}`)) suffix++
      update([...request.fields, { key: `field${suffix}`, type: 'string', source: { selector: '', read: 'text' } }])
    }}>Add field</button>
  </fieldset>
}
