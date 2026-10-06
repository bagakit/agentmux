import { useEffect, useMemo, useState } from 'react'
import { useMarkdownCopyText, useMarkdownDiagramRenderer, type MarkdownDiagramInput } from '../platform.js'
import { ContentCopyButton } from './ContentCopyButton.js'
import { useVisibleWork } from '../lib/use-visible-work.js'
import { requestMarkdownRender } from '../lib/markdown-render-job.js'
import type { MarkdownRenderResult } from '../lib/markdown-render.js'

export function MarkdownCodeBlock({ code, language, visible = true, readOnly = false }: { code: string; language?: string | null; visible?: boolean; readOnly?: boolean }) {
  const { ref, visible: inView } = useVisibleWork<HTMLDivElement>(visible)
  const renderDiagram = useMarkdownDiagramRenderer()
  const copyText = useMarkdownCopyText()
  const normalized = language?.trim().toLowerCase()
  const diagram = normalized === 'mermaid' || normalized === 'dot' || normalized === 'gv' || normalized === 'drawio' || normalized === 'plantuml' ? normalized : normalized === 'puml' ? 'plantuml' : null
  const owner = useMemo(() => ({}), [code, normalized, inView])
  const [result, setResult] = useState<{ owner: object; value: MarkdownRenderResult } | null>(null)
  useEffect(() => {
    if (!inView || !normalized || diagram) return
    const lifetime = new AbortController()
    void requestMarkdownRender({ kind: 'code', source: code, language: normalized }, lifetime.signal).then(value => {
      if (!lifetime.signal.aborted) setResult({ owner, value })
    }).catch(error => { if (!lifetime.signal.aborted) setResult({ owner, value: { error: error instanceof Error ? error.message : 'Code coloring could not load. Original source shown.' } }) })
    return () => lifetime.abort()
  }, [owner, code, normalized, diagram, inView])
  const ready = inView && result?.owner === owner ? result.value : null
  return <div ref={ref} className="md-code-container">
    {!diagram && !readOnly && copyText ? <div className="md-code-toolbar">
      <span className="md-code-toolbar__language" title={language?.trim() || 'Text'}>{language?.trim() || 'Text'}</span>
      <ContentCopyButton text={code} identity={language} label="Copy code" className="md-code-toolbar__copy" />
    </div> : null}
    {inView && diagram && renderDiagram ? renderDiagram({ code, language: diagram as MarkdownDiagramInput['language'], visible: inView }) :
      <pre className="md-block-code" {...(language ? { 'data-language': language } : {})}>
        {ready?.html !== undefined ? <code dangerouslySetInnerHTML={{ __html: ready.html }} /> : <code>{code}</code>}
      </pre>}
    {ready?.message && <span className="md-math-error" role="status">{ready.message}</span>}
    {ready?.error && <span className="md-math-error" role="alert">{ready.error}</span>}
  </div>
}
