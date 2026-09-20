import { useEffect, useState } from 'react'
import type { BrowserOperation, BrowserOperationStep } from '../../../shared/browser-operation'
import type { BrowserStepEvidenceRead } from '../../../shared/browser-step-evidence'
import { api } from '../lib/api'

/** Reads saved facts for the selected step; never takes a new snapshot of today's page. */
export function BrowserStepEvidence({ operation, step }: { operation: BrowserOperation; step: BrowserOperationStep }) {
  const [read, setRead] = useState<BrowserStepEvidenceRead | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setLoading(true)
    setRead(null)
    setSelected(null)
    void api.browser.getStepEvidence(operation.id, step.sequence).then(value => {
      if (!current) return
      if (value.operationId !== operation.id || value.sequence !== step.sequence ||
          value.items.some(item => item.reference.browserId !== operation.browserId ||
            item.reference.operationId !== operation.id || item.reference.sequence !== step.sequence)) {
        throw new Error('Evidence belongs to another step.')
      }
      setRead(value)
    }).catch(() => {
      if (current) setRead({ operationId: operation.id, sequence: step.sequence, items: [], status: 'unavailable',
        warning: 'Recorded evidence could not be read. The step remains visible; retry to restore its evidence.' })
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [operation.id, operation.browserId, step.sequence, step.finishedAt, retry])

  const item = read?.items.find(value => value.reference.id === selected) ??
    read?.items.find(value => step.status === 'failed' && value.content.kind === 'diagnostic') ?? read?.items[0]
  return <section className="browser-step-evidence" aria-label={`Evidence for step ${step.sequence}`}>
    <header><strong>{step.label}</strong><span>{step.status}</span></header>
    {step.target ? <p className="browser-step-evidence__target">{step.target.role} · {step.target.name}</p> : null}
    {loading ? <p role="status">Reading recorded evidence…</p> : null}
    {read?.warning ? <p className="browser-step-evidence__warning" role="status">{read.warning}</p> : null}
    {!loading && read?.status === 'not-recorded' ? <p>No evidence was recorded for this step.</p> : null}
    {!loading && read?.status === 'unavailable' ? <button type="button" className="browser-rsi-button" onClick={() => setRetry(value => value + 1)}>Retry evidence</button> : null}
    {read && read.items.length > 1 ? <nav aria-label="Recorded evidence">
      {read.items.map(value => <button type="button" key={value.reference.id} aria-pressed={item?.reference.id === value.reference.id}
        onClick={() => setSelected(value.reference.id)}>{label(value.content.kind)}</button>)}
    </nav> : null}
    {item ? <>
      <p className="browser-step-evidence__time"><time dateTime={new Date(item.reference.capturedAt).toISOString()}>{new Date(item.reference.capturedAt).toLocaleString()}</time> · {label(item.content.kind)}</p>
      {item.content.kind === 'page' ? <>
        <pre>{item.content.text}</pre>
        {item.content.truncated ? <p>Recorded page excerpt is truncated.</p> : null}
      </> : item.content.kind === 'screenshot' ? <>
        <a href={item.content.image.dataUrl} download={`browser-step-${step.sequence}.png`} aria-label="Save recorded screenshot">
          <img src={item.content.image.dataUrl} alt={`Recorded screenshot for step ${step.sequence}`} />
        </a>
      </> : <><p>{item.content.message}</p><p>{item.content.nextAction}</p></>}
      <details><summary>Source</summary><dl>
        <dt>Operation</dt><dd>{item.reference.operationId}</dd>
        <dt>Step</dt><dd>{item.reference.sequence}</dd>
        <dt>Browser</dt><dd>{item.reference.browserId}</dd>
        <dt>Navigation</dt><dd>{item.reference.navigationId}</dd>
      </dl></details>
    </> : null}
  </section>
}

function label(kind: 'page' | 'screenshot' | 'diagnostic'): string {
  return kind === 'page' ? 'Page' : kind === 'screenshot' ? 'Screenshot' : 'Diagnostics'
}
