import { useEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { MarkdownCodeBlock } from '@agentmux/client-ui/components/MarkdownCodeBlock'
import type { NotebookCell, NotebookMime, NotebookPreview, NotebookReply, NotebookRequest } from '../../lib/file-formats/data-notebook'
import { FilePreviewState } from '../FilePreviewState'
import { DataTree } from './StructuredDataPreview'
import { StaticMarkupPreview } from './StaticMarkupPreview'
import './NotebookFilePreview.css'

const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')


let nextJob = 0
function NotebookImage({ item, alt }: { item: NotebookMime; alt: string }) {
  const [failed, setFailed] = useState(false)
  return failed ? <span className="notebook-preview__notice">This image could not be decoded. The original output remains in Source.</span>
    : <img className="notebook-preview__image" src={`data:${item.mime};base64,${item.text ?? ''}`} alt={alt} onError={() => setFailed(true)} />
}

function NotebookMarkdown({ content, attachments = {} }: { content: string; attachments?: NotebookCell['attachments'] }) {
  return <AgentMarkdown content={content} documentMode visible renderImage={(href, alt) => {
    if (!href.startsWith('attachment:')) return <span className="notebook-preview__notice">Image reference unavailable in notebook preview: {alt || href}</span>
    let name = href.slice('attachment:'.length)
    try { name = decodeURIComponent(name) } catch { /* A malformed name stays an exact lookup, never a URL. */ }
    const bundle = Object.hasOwn(attachments, name) ? attachments[name] : undefined
    const image = bundle?.find(item => item.kind === 'image') ?? bundle?.find(item => item.kind === 'svg')
    if (!image) return <span className="notebook-preview__notice">Attachment unavailable: {alt || name}</span>
    return image.kind === 'svg' ? <StaticMarkupPreview content={image.text ?? ''} title={`Notebook attachment ${name}`} /> : <NotebookImage item={image} alt={alt || name} />
  }} />
}

function MimeOutput({ items }: { items: NotebookMime[] }) {
  const preferred = ['text/html', 'image/svg+xml', 'image/png', 'image/jpeg', 'text/markdown', 'application/json', 'text/plain']
  const initial = preferred.map(mime => items.findIndex(item => item.mime === mime && item.kind !== 'unsupported')).find(index => index !== -1) ?? 0
  const [selected, setSelected] = useState(initial)
  const item = items[selected] ?? items[0]
  if (!item) return <p className="notebook-preview__notice">This output has no representations.</p>
  return <div className="notebook-preview__mime">
    {items.length > 1 ? <label className="notebook-preview__mime-select">Output <select aria-label="Output representation" value={selected} onChange={event => setSelected(Number(event.target.value))}>{items.map((entry, index) => <option key={index} value={index}>{entry.mime}</option>)}</select></label> : <span className="notebook-preview__output-label">{item.mime}</span>}
    {item.notice ? <p className="notebook-preview__notice">{item.notice}</p> : null}
    {item.kind === 'html' || item.kind === 'svg' ? <StaticMarkupPreview content={item.text ?? ''} title={`Notebook ${item.mime} output`} />
      : item.kind === 'image' ? <NotebookImage key={`${selected}:${item.text}`} item={item} alt="Notebook output" />
      : item.kind === 'markdown' ? <NotebookMarkdown content={item.text ?? ''} />
      : item.kind === 'json' && item.node ? <div className="json-content"><DataTree node={item.node} /></div>
      : item.text ? <pre>{item.text}</pre> : null}
  </div>
}

function NotebookCells({ preview }: { preview: Extract<NotebookPreview, { status: 'ready' }> }) {
  return <div className="notebook-preview__cells" tabIndex={0} aria-label="Notebook cells">
    {preview.notice ? <p className="notebook-preview__notice">{preview.notice}</p> : null}
    {!preview.cells.length ? <FilePreviewState title="Empty notebook" detail="This notebook has no cells." /> : null}
    {preview.cells.map(cell => <section className={`notebook-preview__cell notebook-preview__cell--${cell.type === 'code' ? 'code' : 'text'}`} key={cell.index} aria-label={`Cell ${cell.index + 1}: ${cell.type}`}>
      <div className="notebook-preview__cell-bar"><span>Cell {cell.index + 1} · {cell.type}</span>{cell.type === 'code' ? <span>In [{cell.executionCount ?? ' '}]</span> : null}</div>
      {cell.diagnostics.map((message, index) => <p key={index} className="notebook-preview__notice">{message}</p>)}
      <div className="notebook-preview__source">{cell.type === 'markdown' ? <NotebookMarkdown content={cell.source} attachments={cell.attachments} />
        : cell.type === 'code' ? <MarkdownCodeBlock code={cell.source} {...(preview.language ? { language: preview.language } : {})} visible /> : <pre>{cell.source}</pre>}</div>
      {cell.outputs.map((output, index) => <div className="notebook-preview__output" key={index}>{output.type === 'text'
        ? <><span className="notebook-preview__output-label">{output.label}</span><pre>{output.text}</pre></> : <MimeOutput items={output.representations} />}</div>)}
    </section>)}
  </div>
}

/** Each visible File owns a real disposable Worker; no notebook parse runs in React. */
export function NotebookFilePreview({ content, visible = true, ownerKey = '' }: { content: string; visible?: boolean; ownerKey?: string }) {
  const [attempt, setAttempt] = useState(0)
  const request = useMemo(() => ({ content, visible, ownerKey, attempt }), [content, visible, ownerKey, attempt])
  const [result, setResult] = useState<{ request: typeof request; parsed: NotebookPreview } | null>(null)
  const [page, setPage] = useState(0)
  const wantedPage = useRef(0)
  const active = useRef<{ request: typeof request; worker: Worker; job: string } | null>(null)
  useEffect(() => {
    if (!visible) { setResult(null); return }
    let cancelled = false, worker: Worker | null = null
    wantedPage.current = 0; setPage(0)
    const timer = setTimeout(() => {
      try {
        worker = new Worker(new URL('../../lib/file-formats/data-notebook.worker.ts', import.meta.url), { type: 'module' })
        const job = `notebook-${++nextJob}`
        active.current = { request, worker, job }
        worker.onmessage = (event: MessageEvent<NotebookReply>) => {
          if (cancelled || event.data.job !== job) return
          if (event.data.page !== wantedPage.current) return
          const parsed = event.data.result
          if (parsed.status === 'ready' && parsed.page !== wantedPage.current) return
          setResult({ request, parsed })
        }
        worker.onerror = () => {
          if (cancelled) return
          worker?.terminate()
          active.current = null
          setResult({ request, parsed: { status: 'invalid', message: 'The notebook reader stopped. Retry preview or return to Source; the source is unchanged.' } })
        }
        const message: NotebookRequest = { type: 'open', job, content }
        worker.postMessage(message)
      } catch {
        worker?.terminate()
        if (!cancelled) setResult({ request, parsed: { status: 'invalid', message: 'The notebook worker could not start. Retry preview or return to Source.' } })
      }
    }, 0)
    return () => { cancelled = true; clearTimeout(timer); worker?.terminate(); if (active.current?.request === request) active.current = null }
  }, [request, visible, content])
  if (!visible) return null
  if (result?.request !== request) return <FilePreviewState title="Reading notebook" detail="Parsing cells in a separate worker. The source remains editable." />
  if (result.parsed.status !== 'ready') return <FilePreviewState error={result.parsed.status === 'invalid'} title={result.parsed.status === 'too-large' ? 'Notebook preview limit' : 'Notebook needs attention'} detail={result.parsed.message}><button className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry preview</button></FilePreviewState>
  const parsed = result.parsed
  const showPage = (index: number) => {
    if (active.current?.request !== request) return
    wantedPage.current = index; setPage(index)
    const message: NotebookRequest = { type: 'page', job: active.current.job, page: index }
    active.current.worker.postMessage(message)
  }
  return <section className="file-data-preview notebook-preview" aria-label="Notebook preview">
    <div className="file-data-preview__bar"><span>Notebook · Read-only preview{parsed.language ? ` · ${parsed.language}` : ''}</span><span>No kernel execution</span></div>
    {parsed.page === page ? <NotebookCells key={page} preview={parsed} /> : <FilePreviewState title="Reading cells" detail="Loading the selected notebook page." />}
    <footer className="file-data-preview__bar"><span>{parsed.cellCount.toLocaleString()} cells{parsed.previewCellCount < parsed.cellCount ? ' · preview limit reached' : ''}</span><div className="file-preview__controls" role="group" aria-label="Notebook pages">
      <button className="icon-button" aria-label="Previous notebook page" disabled={page === 0} onClick={() => showPage(page - 1)}><ThemeNavigationBackIcon size={13} /></button><output>{page + 1} / {parsed.pages}</output><button className="icon-button" aria-label="Next notebook page" disabled={page + 1 >= parsed.pages} onClick={() => showPage(page + 1)}><ThemeNavigationDisclosureIcon size={13} /></button>
    </div></footer>
  </section>
}
