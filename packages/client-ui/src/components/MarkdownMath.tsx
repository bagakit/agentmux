import { useEffect, useMemo, useState } from 'react'
import { useVisibleWork } from '../lib/use-visible-work.js'
import { requestMarkdownRender } from '../lib/markdown-render-job.js'
import type { MarkdownRenderResult } from '../lib/markdown-render.js'

/** A math expression, never a full TeX document or project build. */
export function MarkdownMath({ expression, source, display = false, visible = true }: { expression: string; source: string; display?: boolean; visible?: boolean }) {
  const { ref, visible: inView } = useVisibleWork<HTMLSpanElement>(visible)
  const owner = useMemo(() => ({}), [expression, display, inView])
  const [result, setResult] = useState<{ owner: object; value: MarkdownRenderResult } | null>(null)
  useEffect(() => {
    if (!inView) return
    const lifetime = new AbortController()
    void Promise.all([requestMarkdownRender({ kind: 'math', source: expression, display }, lifetime.signal), import('katex/dist/katex.min.css')]).then(([value]) => {
      if (!lifetime.signal.aborted) setResult({ owner, value })
    }).catch(error => { if (!lifetime.signal.aborted) setResult({ owner, value: { error: error instanceof Error ? error.message : 'Formula could not load.' } }) })
    return () => lifetime.abort()
  }, [owner, expression, display, inView])
  const ready = inView && result?.owner === owner ? result.value : null
  return <span ref={ref} className={`md-math${display ? ' md-math--display' : ''}`}>
    {ready?.html ? <span dangerouslySetInnerHTML={{ __html: ready.html }} /> : <code className="md-code">{source}</code>}
    {ready?.error && <span className="md-math-error" role="alert">{ready.error}</span>}
    {ready?.message && <span className="md-math-error" role="status">{ready.message}</span>}
  </span>
}
