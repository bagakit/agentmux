import { TextInput } from '@agentmux/client-ui/input'
import { useDeferredValue, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ChevronsUpDown, Search } from 'lucide-react'
import type { Node } from 'jsonc-parser'
import { readJsonPreview } from '../lib/file-json-preview'
import { readDelimitedPreview } from '../lib/file-delimited-preview'
import { FilePreviewState } from './FilePreviewState'
import '../styles/file-data-preview.css'

const PAGE_SIZE = 50
const JSON_CHILD_PAGE = 100

function JsonEntry({ node, content, name, index, depth = 0 }: { node: Node; content: string; name?: string; index?: number; depth?: number }) {
  const [open, setOpen] = useState(depth === 0)
  const [limit, setLimit] = useState(JSON_CHILD_PAGE)
  const collection = node.type === 'object' || node.type === 'array'
  const key = index !== undefined ? <span className="json-count">[{index}] </span> : name === undefined ? null : <span className="json-key">{JSON.stringify(name)}<span className="json-punctuation">: </span></span>
  if (!collection) return <div className="json-entry json-entry--value">
    {key}<span className={`json-value json-value--${node.type}`}>{content.slice(node.offset, node.offset + node.length)}</span>
  </div>
  const array = node.type === 'array', entries = node.children ?? [], count = entries.length
  return <details className="json-entry" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{key}<span className="json-punctuation">{array ? '[' : '{'}</span>
      <span className="json-count">{count.toLocaleString()} {array ? count === 1 ? 'item' : 'items' : count === 1 ? 'key' : 'keys'}</span>
      <span className="json-punctuation">{array ? ']' : '}'}</span>
    </summary>
    {open ? <div className="json-children">
      {depth >= 40 ? <p className="file-data-preview__notice">Use Source to read deeper nesting.</p> : <>
        {entries.slice(0, limit).map((entry, index) => <JsonEntry key={entry.offset} node={array ? entry : entry.children![1]!} content={content}
          {...(array ? { index } : { name: String(entry.children![0]!.value) })} depth={depth + 1} />)}
        {count > limit ? <button className="small-button" onClick={() => setLimit(current => current + JSON_CHILD_PAGE)}>Show {Math.min(JSON_CHILD_PAGE, count - limit)} more</button> : null}
      </>}
    </div> : null}
  </details>
}

function JsonContent({ content, comments }: { content: string; comments: boolean }) {
  const parsed = useMemo(() => readJsonPreview(content, comments), [content, comments])
  if (parsed.status !== 'ready') return <FilePreviewState error={parsed.status === 'invalid'}
    title={parsed.status === 'too-large' ? 'Structured preview limit' : 'JSON needs attention'} detail={parsed.message} />
  return <section className="file-data-preview file-data-preview--json" aria-label="JSON preview">
    <div className="file-data-preview__bar"><span>{comments ? 'JSON with comments' : 'JSON'}</span><span>Read-only preview</span></div>
    <div className="json-content"><JsonEntry node={parsed.node} content={content} /></div>
  </section>
}

function DelimitedContent({ content, delimiter }: { content: string; delimiter: ',' | '\t' }) {
  const parsed = useMemo(() => readDelimitedPreview(content, delimiter), [content, delimiter])
  const [header, setHeader] = useState(true)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())
  const [page, setPage] = useState(0)
  const rows = useMemo(() => parsed.status === 'ready' ? parsed.rows.slice(header ? 1 : 0)
    .map((cells, index) => ({ cells, index: index + (header ? 2 : 1) }))
    .filter(row => !deferredQuery || row.cells.some(cell => cell.toLocaleLowerCase().includes(deferredQuery))) : [], [parsed, header, deferredQuery])
  if (parsed.status !== 'ready') return <FilePreviewState error={parsed.status === 'invalid'}
    title={parsed.status === 'too-large' ? 'Table preview limit' : 'Table needs attention'} detail={parsed.message} />
  if (!parsed.rows.length) return <FilePreviewState title="Empty table" detail="The file contains no data rows." />
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const activePage = Math.min(page, pageCount - 1)
  const start = activePage * PAGE_SIZE
  const labels = header ? parsed.rows[0]! : []
  return <section className="file-data-preview file-data-preview--table" aria-label={delimiter === '\t' ? 'TSV preview' : 'CSV preview'}>
    <div className="file-data-preview__bar">
      <label className="file-data-preview__search"><Search size={12} aria-hidden="true" /><TextInput aria-label="Filter table rows" placeholder="Filter rows" value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} /></label>
      <button className="small-button" aria-pressed={header} onClick={() => { setHeader(value => !value); setPage(0) }}><ChevronsUpDown size={12} />Header row</button>
    </div>
    <div className="file-data-preview__scroll" tabIndex={0} aria-label="Table content">
      {rows.length ? <table>
        <thead><tr><th className="file-data-preview__row-number" scope="col">#</th>{Array.from({ length: parsed.columns }, (_, index) => <th scope="col" key={index} title={labels[index]}><span className="file-data-preview__cell">{labels[index] || `Column ${index + 1}`}</span></th>)}</tr></thead>
        <tbody>{rows.slice(start, start + PAGE_SIZE).map(row => <tr key={row.index}>
          <th className="file-data-preview__row-number" scope="row">{row.index}</th>
          {Array.from({ length: parsed.columns }, (_, index) => <td key={index} data-empty={row.cells[index] === '' || row.cells[index] === undefined}><span className="file-data-preview__cell">{row.cells[index] ?? ''}</span></td>)}
        </tr>)}</tbody>
      </table> : <p className="file-data-preview__notice">No rows match “{query}”.</p>}
    </div>
    <footer className="file-data-preview__bar">
      <span>{rows.length.toLocaleString()} {rows.length === 1 ? 'row' : 'rows'} · {parsed.columns} columns{parsed.truncated ? ' · first 5,000 source rows' : ''}</span>
      <div className="file-preview__controls" role="group" aria-label="Table pages">
        <button className="icon-button" aria-label="Previous table page" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}><ChevronLeft size={13} /></button>
        <output>{activePage + 1} / {pageCount}</output>
        <button className="icon-button" aria-label="Next table page" disabled={activePage + 1 >= pageCount} onClick={() => setPage(activePage + 1)}><ChevronRight size={13} /></button>
      </div>
    </footer>
  </section>
}

export function FileDataPreview({ content, kind, comments = false }: { content: string; kind: 'json' | 'csv' | 'tsv'; comments?: boolean }) {
  return kind === 'json' ? <JsonContent content={content} comments={comments} />
    : <DelimitedContent content={content} delimiter={kind === 'tsv' ? '\t' : ','} />
}
