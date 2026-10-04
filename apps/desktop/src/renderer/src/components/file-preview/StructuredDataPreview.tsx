import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { DATA_PREVIEW_MAX_COLUMNS } from '../../lib/file-data-preview'
import type { StructuredDataKind } from '../../lib/file-formats/data-parse'
import { requestStructuredPreview } from '../../lib/file-formats/data-structured-request'
import type { DataNode, DataRecord, StructuredPreview } from '../../lib/file-formats/data-model'
import { FilePreviewState } from '../FilePreviewState'
import '../../styles/file-data-preview.css'
import './StructuredDataPreview.css'

const PAGE_SIZE = 50

export function DataTree({ node, depth = 0 }: { node: DataNode; depth?: number }) {
  const [open, setOpen] = useState(depth === 0)
  const [limit, setLimit] = useState(100)
  const label = node.label !== undefined ? <span className="json-key">{node.label}<span className="json-punctuation">: </span></span> : null
  if (!node.children) return <div className="json-entry json-entry--value">{label}<span className={`json-value json-value--${node.type}`}>{node.text}</span></div>
  return <details className="json-entry" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}<span className="json-punctuation">{node.type}</span><span className="json-count">{node.children.length}{node.omitted ? '+' : ''} entries</span></summary>
    {open ? <div className="json-children">
      {depth >= 40 ? <p className="file-data-preview__notice">Use Source to read deeper nesting.</p> : node.children.slice(0, limit).map((child, index) => <DataTree key={index} node={child} depth={depth + 1} />)}
      {depth < 40 && node.children.length > limit ? <button className="small-button" onClick={() => setLimit(value => value + 100)}>Show more entries</button> : null}
      {node.omitted ? <p className="file-data-preview__notice">Some entries exceed the preview budget. The complete source remains editable.</p> : null}
    </div> : null}
  </details>
}

function textValue(node?: DataNode): string {
  if (!node) return '—'
  if (node.children) return `${node.type} · ${node.children.length}${node.omitted ? '+' : ''} entries`
  return node.text ?? ''
}

function RecordsTable({ records, allRecords }: { records: DataRecord[]; allRecords: DataRecord[] }) {
  const columns = useMemo(() => [...new Set(allRecords.flatMap(record => record.node?.type === 'object'
    ? record.node.children?.map(child => child.label ?? '') ?? [] : []))], [allRecords])
  const fields = columns.slice(0, DATA_PREVIEW_MAX_COLUMNS)
  const hasValues = allRecords.some(record => record.node && record.node.type !== 'object')
  return <>
    {columns.length > fields.length ? <p className="file-data-preview__notice">Only the first {DATA_PREVIEW_MAX_COLUMNS} fields are shown. Use Tree or Source for all fields.</p> : null}
    <table><thead><tr><th scope="col" className="file-data-preview__row-number">Line</th>
      {fields.map(field => <th scope="col" key={field}>{field}</th>)}{hasValues ? <th scope="col">Value</th> : null}<th scope="col">Status</th>
    </tr></thead><tbody>{records.map(record => <tr key={record.line}>
      <th scope="row" className="file-data-preview__row-number">{record.line}</th>
      {fields.map(field => <td key={field}><span className="file-data-preview__cell">{textValue(record.node?.children?.find(child => child.label === field))}</span></td>)}
      {hasValues ? <td><span className="file-data-preview__cell">{record.node?.type !== 'object' ? textValue(record.node) : '—'}</span></td> : null}
      <td><span className="file-data-preview__cell">{record.diagnostics.map(item => `Column ${item.column}: ${item.message}`).join(' ') || 'Valid'}</span></td>
    </tr>)}</tbody></table>
  </>
}

function StructuredContent({ parsed, kind }: { parsed: Extract<StructuredPreview, { status: 'ready' }>; kind: StructuredDataKind }) {
  const [mode, setMode] = useState<'tree' | 'table'>('tree')
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(parsed.records.length / PAGE_SIZE)), active = Math.min(page, pages - 1)
  const records = parsed.records.slice(active * PAGE_SIZE, (active + 1) * PAGE_SIZE)
  const [document, setDocument] = useState(0)
  const selected = parsed.records[Math.min(document, Math.max(0, parsed.records.length - 1))]
  const jsonl = kind === 'jsonl'
  return <section className="file-data-preview" aria-label={`${kind.toUpperCase()} preview`}>
    <div className="file-data-preview__bar"><span>{kind.toUpperCase()} · Read-only preview</span>
      {jsonl ? <div role="group" aria-label="Record view"><button className="small-button" aria-pressed={mode === 'tree'} onClick={() => setMode('tree')}>Tree</button><button className="small-button" aria-pressed={mode === 'table'} onClick={() => setMode('table')}>Table</button></div>
        : kind === 'yaml' && parsed.records.length > 1 ? <label>Document <select aria-label="YAML document" value={document} onChange={event => setDocument(Number(event.target.value))}>{parsed.records.map((item, index) => <option key={index} value={index}>{index + 1} · line {item.line}{item.diagnostics.length ? ' · needs attention' : ''}</option>)}</select></label> : null}
    </div>
    {parsed.diagnostics.length ? <div className="structured-preview__diagnostic" role="status">{parsed.diagnostics.length} {parsed.diagnostics.length === 1 ? 'issue' : 'issues'} · Source is unchanged.</div> : null}
    <div className={mode === 'table' && jsonl ? 'file-data-preview__scroll' : 'json-content'} tabIndex={0} aria-label="Structured content">
      {jsonl && mode === 'table' ? <RecordsTable records={records} allRecords={parsed.records} /> : (jsonl ? records : selected ? [selected] : []).map(record => <div className="structured-preview__record" key={record.line}>
        {jsonl ? <div className="structured-preview__line">Line {record.line}</div> : null}
        {record.diagnostics.map((item, index) => <p key={index} className="structured-preview__diagnostic">Line {item.line}, column {item.column}: {item.message}</p>)}
        {record.node ? <DataTree node={record.node} /> : null}
      </div>)}
      {!parsed.records.length ? <p className="file-data-preview__notice">No records in this document.</p> : null}
    </div>
    <footer className="file-data-preview__bar"><span>{parsed.records.length.toLocaleString()} {jsonl ? 'records' : 'documents'}{parsed.truncated ? ' · preview limit reached; use Source for the rest' : ''}</span>
      {jsonl ? <div className="file-preview__controls" role="group" aria-label="Record pages"><button className="icon-button" aria-label="Previous record page" disabled={active === 0} onClick={() => setPage(active - 1)}><ChevronLeft size={13} /></button><output>{active + 1} / {pages}</output><button className="icon-button" aria-label="Next record page" disabled={active + 1 >= pages} onClick={() => setPage(active + 1)}><ChevronRight size={13} /></button></div> : null}
    </footer>
  </section>
}

export function StructuredDataPreview({ content, kind, visible = true, ownerKey = '' }: { content: string; kind: StructuredDataKind; visible?: boolean; ownerKey?: string }) {
  const request = useMemo(() => ({ content, kind, ownerKey, visible }), [content, kind, ownerKey, visible])
  const [result, setResult] = useState<{ request: typeof request; parsed: StructuredPreview } | null>(null)
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const lifetime = new AbortController()
    // Admit work after paint; cleanup cancels queued work and prevents late imports/results publishing.
    const timer = setTimeout(() => { void requestStructuredPreview(kind, content, lifetime.signal).then(parsed => {
      if (!cancelled) setResult({ request, parsed })
    }, () => { if (!cancelled) setResult({ request, parsed: { status: 'invalid', message: 'Unable to read this preview. The complete source remains editable.' } }) }) }, 0)
    return () => { cancelled = true; lifetime.abort(); clearTimeout(timer) }
  }, [request, visible, kind, content])
  if (!visible) return null
  if (result?.request !== request) return <FilePreviewState title="Reading structured data" detail="The source remains editable." />
  if (result.parsed.status !== 'ready') return <FilePreviewState error={result.parsed.status === 'invalid'} title={result.parsed.status === 'too-large' ? 'Structured preview limit' : 'Data needs attention'} detail={result.parsed.message} />
  return <StructuredContent key={`${kind}:${ownerKey}`} parsed={result.parsed} kind={kind} />
}
