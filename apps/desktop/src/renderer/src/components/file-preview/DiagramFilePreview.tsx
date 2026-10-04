import { useEffect, useMemo, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'
import type { FileDiagramKind } from '../../../../shared/file-diagram'
import { api } from '../../lib/api'
import { APP_APPEARANCE_DATASET_KEY } from '../../lib/theme-contract'

/** One transient host job for the current source. Standalone files and Markdown use this consumer. */
export function DiagramFilePreview({ content, kind, path, visible = true, page, onPageCount }: {
  content: string; kind: FileDiagramKind; path?: string | undefined; visible?: boolean; page?: number; onPageCount?(count: number): void
}) {
  const { ref, visible: inView } = useVisibleWork<HTMLDivElement>(visible)
  const [attempt, setAttempt] = useState(0)
  const [, setAppearanceRevision] = useState(0)
  const theme = document.documentElement.dataset[APP_APPEARANCE_DATASET_KEY] === 'light' ? 'light' : 'dark'
  useEffect(() => {
    if (!inView) return
    const observer = new MutationObserver(() => setAppearanceRevision(value => value + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [`data-${APP_APPEARANCE_DATASET_KEY}`] })
    return () => observer.disconnect()
  }, [inView])
  const owner = useMemo(() => ({}), [content, kind, page, theme, inView, attempt])
  const [result, setResult] = useState<{ owner: object; source: string; kind: FileDiagramKind; page: number | undefined; attempt: number; url?: string; error?: string } | null>(null)
  useEffect(() => {
    if (!inView) return
    let current = true, url: string | undefined
    const id = crypto.randomUUID()
    void api.files.renderDiagram({ id, kind, content, theme, ...(page !== undefined ? { page } : {}) }).then(value => {
      if (!current || value.id !== id) return
      if (value.error) setResult({ owner, source: content, kind, page, attempt, error: value.error })
      else {
        url = URL.createObjectURL(new Blob([value.svg], { type: 'image/svg+xml' }))
        setResult({ owner, source: content, kind, page, attempt, url })
        if (value.pageCount !== undefined) onPageCount?.(value.pageCount)
      }
    }).catch(error => { if (current) setResult({ owner, source: content, kind, page, attempt, error: presentError(error) }) })
    return () => { current = false; void api.files.cancelDiagram(id).catch(() => {}); if (url) URL.revokeObjectURL(url) }
  }, [content, kind, page, theme, inView, attempt])
  const ready = inView && result?.owner === owner && result.source === content && result.kind === kind && result.page === page && result.attempt === attempt ? result : null
  return <div ref={ref} className="file-diagram-preview" data-diagram-kind={kind} style={{ minHeight: 80, overflow: 'auto' }}>
    {ready?.url ? <img src={ready.url} alt={`${path ?? kind} diagram`} style={{ display: 'block', maxWidth: '100%', margin: 'auto' }} /> : <>
      {ready?.error ? <div className="file-preview-state" role="alert"><strong>Diagram could not render</strong><span>{ready.error}</span>
        <button type="button" className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div> : <div role="status">{inView ? 'Rendering diagram…' : 'Diagram preview'}</div>}
      <pre className="md-block-code"><code>{content}</code></pre>
    </>}
  </div>
}
