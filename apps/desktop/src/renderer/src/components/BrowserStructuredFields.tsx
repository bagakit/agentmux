import { useEffect, useRef, useState } from 'react'
import { BROWSER_RESULT_MAX_READ_BYTES, type BrowserResultArtifactChunk, type BrowserResultArtifactReference,
  type BrowserResultReadOptions } from '../../../shared/browser-result-artifact'
import type { BrowserStructuredFieldSummary, BrowserStructuredOutputReceipt } from '../../../shared/browser-structured-output'

export type BrowserStructuredResultReader = (reference: BrowserResultArtifactReference, options: BrowserResultReadOptions) => Promise<BrowserResultArtifactChunk>
type RawRead = { key: string; text: string; offset: number; returnedBytes: number; nextOffset: number | null; error?: string }

/** Saved field summaries only; opening raw JSON reads the existing artifact, never today's DOM. */
export function BrowserStructuredFields({ receipt, readResult }: {
  receipt: BrowserStructuredOutputReceipt
  readResult?: BrowserStructuredResultReader
}) {
  const reference = receipt.artifactStatus === 'available' ? receipt.artifact : undefined
  const key = reference ? JSON.stringify(reference) : ''
  const active = useRef<string | null>(key)
  const busy = useRef(false)
  const decoder = useRef<TextDecoder | null>(null)
  const [raw, setRaw] = useState<RawRead | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    active.current = key; busy.current = false; decoder.current = null
    setRaw(null); setLoading(false)
    return () => { active.current = null }
  }, [key])
  const current = raw?.key === key ? raw : null
  const load = async (offset: number) => {
    if (!reference || !readResult || busy.current || active.current !== key) return
    busy.current = true; setLoading(true)
    try {
      const chunk = await readResult(reference, { offset, maxBytes: BROWSER_RESULT_MAX_READ_BYTES })
      if (active.current !== key) return
      const returned = chunk.reference
      if (returned.kind !== reference.kind || returned.id !== reference.id || returned.workspaceId !== reference.workspaceId ||
        returned.browserId !== reference.browserId || returned.operationId !== reference.operationId || returned.navigationId !== reference.navigationId ||
        returned.format !== reference.format || returned.byteLength !== reference.byteLength || returned.capturedAt !== reference.capturedAt ||
        returned.maxReadBytes !== reference.maxReadBytes || chunk.encoding !== 'base64' || chunk.offset !== offset ||
        chunk.totalBytes !== reference.byteLength || chunk.returnedBytes < 1 || chunk.returnedBytes > BROWSER_RESULT_MAX_READ_BYTES ||
        chunk.offset + chunk.returnedBytes > chunk.totalBytes || chunk.nextOffset !==
          (chunk.offset + chunk.returnedBytes < chunk.totalBytes ? chunk.offset + chunk.returnedBytes : null)) {
        throw new Error('Result chunk does not match this recorded artifact or byte range.')
      }
      const bytes = Uint8Array.from(atob(chunk.data), char => char.charCodeAt(0))
      if (bytes.byteLength !== chunk.returnedBytes) throw new Error('Result chunk byte length could not be verified.')
      if (offset === 0) decoder.current = new TextDecoder()
      if (!decoder.current) throw new Error('Read the first result chunk before continuing.')
      const text = decoder.current.decode(bytes, { stream: chunk.nextOffset !== null })
      setRaw({ key, text, offset, returnedBytes: chunk.returnedBytes, nextOffset: chunk.nextOffset })
    } catch (error) {
      if (active.current === key) setRaw(value => ({ key, text: value?.key === key ? value.text : '',
        offset: value?.key === key ? value.offset : 0, returnedBytes: value?.key === key ? value.returnedBytes : 0,
        nextOffset: offset, error: error instanceof Error ? error.message : 'Recorded result could not be read.' }))
    } finally {
      if (active.current === key) { busy.current = false; setLoading(false) }
    }
  }
  return <div className="browser-structured-fields" aria-label="Recorded structured fields">
    <p className="browser-structured-fields__summary">{receipt.fields.filter(field => field.status === 'observed').length} / {receipt.fields.length} observed · {label(receipt.status)}</p>
    {receipt.warning ? <p role="status">{receipt.warning}</p> : null}
    {receipt.fields.some(field => field.preview !== undefined) ? <p className="browser-structured-fields__preview-note">
      {reference ? readResult ? 'Previews · full result in Recorded JSON' : 'Previews · full result is saved' : 'Previews · full values were not saved'}
    </p> : null}
    <dl className="browser-structured-fields__values">
      {receipt.fields.map(field => <div key={field.key} data-field-status={field.status}>
        <dt>{field.key}</dt><dd>{fieldValue(field, receipt.warning)}</dd>
      </div>)}
    </dl>
    <details><summary>Field sources</summary><dl className="browser-structured-fields__sources">
      {receipt.fields.map(field => <div key={field.key}><dt>{field.key}</dt><dd>
        {field.type} · {field.source.read}{field.source.attribute ? ` ${field.source.attribute}` : ''}<br /><code>{field.source.selector}</code>
      </dd></div>)}
    </dl><p>Document: {receipt.source.document}<br />{receipt.source.documentUrl ?? 'Document URL was not observed.'}</p></details>
    {reference && readResult ? <details key={key} onToggle={event => { if (event.currentTarget.open && !current) void load(0) }}>
      <summary>Recorded JSON</summary>
      {loading ? <p role="status">Reading recorded result…</p> : null}
      {current?.error ? <p role="status">{current.error} The recorded fields remain visible.</p> : null}
      {current && current.returnedBytes > 0 ? <>
        <p className="browser-structured-fields__range">Bytes {current.offset}–{current.offset + current.returnedBytes - 1} of {reference.byteLength}</p>
        <pre className="browser-structured-fields__raw" tabIndex={0} aria-label="Recorded JSON chunk">{current.text}</pre>
      </> : null}
      {current?.nextOffset !== null && current?.nextOffset !== undefined ? <button type="button" className="browser-rsi-button" disabled={loading}
        onClick={() => void load(current.nextOffset!)}>{current.error ? 'Retry result' : 'Read next chunk'}</button> : null}
    </details> : null}
  </div>
}

function fieldValue(field: BrowserStructuredFieldSummary, warning: string | undefined) {
  if (field.status === 'observed') return field.inline ? <code>{JSON.stringify(field.value)}</code> : <FieldPreview field={field} />
  if (field.status === 'type-error') return <>
    <span className="browser-structured-fields__state">Type mismatch</span>
    {field.actual !== undefined ? <code>{JSON.stringify(field.actual)}</code> : field.preview !== undefined ? <FieldPreview field={field} /> : null}
  </>
  return <><span className="browser-structured-fields__state">{label(field.status)}</span>
    {field.status === 'truncated' && field.preview !== undefined ? <FieldPreview field={field} /> : null}
    {field.detail && field.detail !== warning ? <span className="browser-structured-fields__detail">{field.detail}</span> : null}
  </>
}
function FieldPreview({ field }: { field: BrowserStructuredFieldSummary }) {
  const [open, setOpen] = useState(false)
  const text = `${field.preview ?? ''}${field.status === 'truncated' ? '…' : ''}`
  return <details className="browser-structured-fields__preview" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label={`Field preview: ${field.key}`}>
      {open ? <span className="browser-structured-fields__state">{field.status === 'truncated' ? 'Preview · observed portion only' : 'Preview'}</span> : <code>{text}</code>}
    </summary>
    {open ? <code>{text}</code> : null}
  </details>
}
function label(status: BrowserStructuredOutputReceipt['status'] | BrowserStructuredFieldSummary['status']) {
  const labels = { complete: 'Complete', partial: 'Partial', 'page-changed': 'Page changed', unavailable: 'Unavailable',
    missing: 'Missing', ambiguous: 'Multiple matches', truncated: 'Truncated', 'type-error': 'Type mismatch', observed: 'Observed' }
  return labels[status]
}
