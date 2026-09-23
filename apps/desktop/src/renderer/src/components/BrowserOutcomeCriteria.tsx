import { useState, type MouseEvent } from 'react'
import type { BrowserOutcomeEvaluation, BrowserOutcomeFieldRunInput } from '../../../shared/browser-outcome-criteria'

type Props = {
  evaluation?: BrowserOutcomeEvaluation | null
  busy?: boolean
  historical?: boolean
  onVerify?: (event: MouseEvent<HTMLButtonElement>) => Promise<void>
  /** The Pane checks nativeEvent.isTrusted and calls the existing Main owner. */
  onRun: (input: BrowserOutcomeFieldRunInput, event: MouseEvent<HTMLButtonElement>) => Promise<void>
}
const labels = { passed: 'Satisfied', 'not-met': 'Not satisfied', unavailable: 'Verification unavailable' }

/** A single finite field condition inside existing Browser details, without another status rail. */
export function BrowserOutcomeCriteria({ evaluation, busy = false, historical = false, onVerify, onRun }: Props) {
  const [key, setKey] = useState('result')
  const [selector, setSelector] = useState('')
  const [type, setType] = useState<'string' | 'number' | 'boolean'>('string')
  const [expected, setExpected] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const run = async (event: MouseEvent<HTMLButtonElement>) => {
    if (busy || pending) return
    let value: string | number | boolean = expected
    try {
      if (!key.trim() || !selector.trim()) throw new Error('Enter a field key and CSS selector.')
      if (type !== 'string') {
        value = JSON.parse(expected)
        if (typeof value !== type || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Wrong value type')
      }
    } catch { setError('Use a CSS selector and a value of the declared type; number and boolean values use JSON.'); return }
    setPending(true); setError(undefined)
    try {
      await onRun({ request: { fields: [{ key, type, source: { selector, read: type === 'boolean' ? 'checked' : 'text' } }] },
        criteria: [{ kind: 'field-equals', key, expected: value }] }, event)
    } catch { setError('Verification could not be started. The Browser remains usable; inspect the operation and retry verification when access is restored.') }
    finally { setPending(false) }
  }
  return <details className="browser-task-asset browser-outcome-criteria">
    <summary>{historical ? 'Recorded check' : 'Completion condition'}{evaluation ? ` · ${labels[evaluation.status]}` : ''}</summary>
    <label className="browser-task-asset__field">Field key<input value={key} maxLength={128} onChange={event => setKey(event.target.value)} /></label>
    <label className="browser-task-asset__field">CSS selector<input value={selector} maxLength={512} onChange={event => setSelector(event.target.value)} /></label>
    <label className="browser-task-asset__field">Value type<select value={type} onChange={event => setType(event.target.value as typeof type)}>
      <option value="string">Text</option><option value="number">Number</option><option value="boolean">Checked</option>
    </select></label>
    <label className="browser-task-asset__field">Equals<input value={expected} maxLength={16384} onChange={event => setExpected(event.target.value)} /></label>
    <div className="browser-task-asset__run-actions"><button className="browser-rsi-replay__run" disabled={busy || pending} onClick={event => { void run(event) }}>
      {pending || busy ? 'Checking…' : 'Check current field'}
    </button></div>
    {error && <p role="status" className="browser-task-asset__progress">{error}</p>}
    {historical && <p className="browser-task-asset__progress">This belongs to an earlier operation or document. Check the current field for a fresh observation.</p>}
    {evaluation && onVerify && <button className="browser-rsi-replay__run" disabled={busy || pending} onClick={event => {
      if (busy || pending) return
      setPending(true); setError(undefined)
      void onVerify(event).catch(() => setError('Recorded evidence could not be verified. Existing Browser work remains.'))
        .finally(() => setPending(false))
    }}>Verify recorded evidence</button>}
    {evaluation && <div className="browser-task-asset__progress" role="status">
      <span>{labels[evaluation.status]}</span>
      {evaluation.warning && <p>{evaluation.warning}</p>}
      {evaluation.conditions.map((condition, index) => <p key={index}>{labels[condition.status]} · {condition.reason}</p>)}
    </div>}
  </details>
}
