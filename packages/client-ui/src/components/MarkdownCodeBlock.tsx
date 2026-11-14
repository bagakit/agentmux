import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMarkdownCopyText, useMarkdownDiagramRenderer, type MarkdownDiagramInput } from '../platform.js'
import { ContentCopyButton } from './ContentCopyButton.js'
import { useVisibleWork } from '../lib/use-visible-work.js'
import { requestMarkdownRender } from '../lib/markdown-render-job.js'
import type { MarkdownRenderResult } from '../lib/markdown-render.js'
import { useHorizontalReading } from '../lib/use-horizontal-reading.js'
import { useConversationReadingSelection } from '../lib/use-conversation-reading-selection.js'

/** Ordinary Markdown and Note code nodes share the host's supported diagram dialects. */
export function markdownDiagramLanguage(language?: string | null): MarkdownDiagramInput['language'] | null {
  const normalized = language?.trim().toLowerCase()
  return normalized === 'mermaid' || normalized === 'dot' || normalized === 'gv' || normalized === 'drawio' || normalized === 'plantuml' ? normalized : normalized === 'puml' ? 'plantuml' : null
}

export function MarkdownCodeBlock({ code, language, visible = true, readOnly = false }: { code: string; language?: string | null; visible?: boolean; readOnly?: boolean }) {
  const { ref, visible: inView } = useVisibleWork<HTMLDivElement>(visible)
  const renderDiagram = useMarkdownDiagramRenderer()
  const copyText = useMarkdownCopyText()
  const normalized = language?.trim().toLowerCase()
  const diagram = markdownDiagramLanguage(language)
  const owner = useMemo(() => ({}), [code, normalized])
  const [result, setResult] = useState<{ owner: object; value: MarkdownRenderResult } | null>(null)
  const completed = result?.owner === owner && result.value.error === undefined
  useEffect(() => {
    if (!inView || !normalized || diagram || completed) return
    const lifetime = new AbortController()
    void requestMarkdownRender({ kind: 'code', source: code, language: normalized }, lifetime.signal).then(value => {
      if (!lifetime.signal.aborted) setResult({ owner, value })
    }).catch(error => { if (!lifetime.signal.aborted) setResult({ owner, value: { error: error instanceof Error ? error.message : 'Code coloring could not load. Original source shown.' } }) })
    return () => lifetime.abort()
  }, [owner, code, normalized, diagram, inView, completed])
  const candidate = result?.owner === owner ? result.value : null
  const codeNode = useRef<HTMLElement>(null)
  const committed = useRef<{ owner: object; html: string | undefined } | null>(null)
  // Recheck real selection endpoints before a concurrent token commit, even if
  // selectionchange has not yet reached the owner document's listener.
  useConversationReadingSelection(ref, candidate ?? owner, inView && Boolean(normalized) && !diagram, () => {})
  let selected = false
  const selection = codeNode.current?.ownerDocument.defaultView?.getSelection()
  if (committed.current?.owner === owner && codeNode.current && selection && !selection.isCollapsed) {
    for (let index = 0; index < selection.rangeCount; index++) {
      try { selected ||= selection.getRangeAt(index).intersectsNode(codeNode.current) } catch { selected = true }
    }
  }
  const nextHtml = candidate?.html
  const html = selected ? committed.current!.html : nextHtml
  const markup = useMemo(() => html === undefined ? undefined : { __html: html }, [html])
  useLayoutEffect(() => { committed.current = { owner, html } })
  const reading = useHorizontalReading<HTMLPreElement>(inView, html ?? code)
  return <div ref={ref} className="md-code-container" data-reading-find-boundary={diagram && renderDiagram && visible && !readOnly ? true : undefined}>
    {!diagram && !readOnly && copyText ? <div className="md-code-toolbar">
      <span className="md-code-toolbar__language" title={language?.trim() || 'Text'}>{language?.trim() || 'Text'}</span>
      <ContentCopyButton text={code} identity={language} label="Copy code" className="md-code-toolbar__copy" />
    </div> : null}
    {inView && diagram && renderDiagram ? renderDiagram({ code, language: diagram, visible: inView }) :
      <pre className="md-block-code md-horizontal-reading" {...reading} aria-label={reading.tabIndex === 0 ? 'Scrollable code' : undefined} {...(language ? { 'data-language': language } : {})}>
        {markup ? <code ref={codeNode} dangerouslySetInnerHTML={markup} /> : <code ref={codeNode}>{code}</code>}
      </pre>}
    {candidate?.message && <span className="md-math-error" role="status">{candidate.message}</span>}
    {candidate?.error && <span className="md-math-error" role="alert">{candidate.error}</span>}
  </div>
}
