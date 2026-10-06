import { useEffect, useMemo, useRef, useState } from 'react'
import { useMarkdownCopyText, useMarkdownDiagramRenderer, type MarkdownDiagramInput } from '../platform.js'
import { SemanticIcon } from '../theme/icons.js'
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
  const copyOwner = useMemo(() => ({}), [code, language, copyText, readOnly])
  const latestCopyOwner = useRef(copyOwner); latestCopyOwner.current = copyOwner
  const mounted = useRef(true)
  const copyAction = useRef<{ owner: object; pending: boolean } | null>(null)
  const [copy, setCopy] = useState<{ owner: object; state: 'copying' | 'copied' | 'failed' } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; copyAction.current = null } }, [])
  const copyState = copy?.owner === copyOwner ? copy.state : 'idle'
  async function copyCode() {
    if (!copyText || !mounted.current || latestCopyOwner.current !== copyOwner || (copyAction.current?.owner === copyOwner && copyAction.current.pending)) return
    const action = { owner: copyOwner, pending: true }; copyAction.current = action
    const current = () => latestCopyOwner.current === copyOwner && copyAction.current === action
    let failed = false, accepted = false
    setCopy({ owner: copyOwner, state: 'copying' })
    try {
      accepted = await copyText(code, () => {
        failed = true
        action.pending = false
        if (current()) setCopy({ owner: copyOwner, state: 'failed' })
      }) === true
    } catch { failed = true }
    action.pending = false
    if (current()) setCopy({ owner: copyOwner, state: accepted && !failed ? 'copied' : 'failed' })
  }
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
      <button type="button" className="md-code-toolbar__copy" aria-label="Copy code" aria-disabled={copyState === 'copying' || undefined} aria-busy={copyState === 'copying' || undefined} onClick={() => { void copyCode() }}>
        <SemanticIcon name={copyState === 'copied' ? 'action.confirm' : copyState === 'failed' ? 'status.failed' : 'action.copy'} size={13} aria-hidden="true" />
        <span role="status" aria-live="polite">{copyState === 'copying' ? 'Copying…' : copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Retry copy' : 'Copy'}</span>
      </button>
    </div> : null}
    {inView && diagram && renderDiagram ? renderDiagram({ code, language: diagram as MarkdownDiagramInput['language'], visible: inView }) :
      <pre className="md-block-code" {...(language ? { 'data-language': language } : {})}>
        {ready?.html !== undefined ? <code dangerouslySetInnerHTML={{ __html: ready.html }} /> : <code>{code}</code>}
      </pre>}
    {ready?.message && <span className="md-math-error" role="status">{ready.message}</span>}
    {ready?.error && <span className="md-math-error" role="alert">{ready.error}</span>}
  </div>
}
