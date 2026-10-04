import { useEffect, useMemo, useState } from 'react'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'

/** A Worker owns each Graphviz computation, so leaving a preview really stops layout. */
export function DotFilePreview({ content, path, visible = true }: { content: string; path?: string | undefined; visible?: boolean }) {
  const { ref, visible: inView } = useVisibleWork<HTMLDivElement>(visible)
  const [attempt, setAttempt] = useState(0)
  const owner = useMemo(() => ({}), [content, inView, attempt])
  const [result, setResult] = useState<{ owner: object; content: string; attempt: number; url?: string; error?: string } | null>(null)
  useEffect(() => {
    if (!inView) return
    const id = crypto.randomUUID()
    let worker: Worker
    try { worker = new Worker(new URL('../../lib/file-formats/dot-worker.ts', import.meta.url), { type: 'module' }) }
    catch { setResult({ owner, content, attempt, error: 'The DOT worker could not start. Retry preview or return to Source.' }); return }
    let current = true, url: string | undefined
    worker.onmessage = (event: MessageEvent<{ id: string; svg: string; error?: string }>) => {
      if (!current || event.data.id !== id) return
      worker.terminate()
      if (event.data.error) setResult({ owner, content, attempt, error: event.data.error })
      else {
        try {
          url = URL.createObjectURL(new Blob([event.data.svg], { type: 'image/svg+xml' }))
          setResult({ owner, content, attempt, url })
        } catch { setResult({ owner, content, attempt, error: 'The DOT image could not load. Retry preview or return to Source.' }) }
      }
    }
    worker.onerror = () => { worker.terminate(); if (current) setResult({ owner, content, attempt, error: 'DOT renderer stopped. Retry preview.' }) }
    worker.postMessage({ id, content })
    return () => { current = false; worker.terminate(); if (url) URL.revokeObjectURL(url) }
  }, [content, inView, attempt])
  const ready = inView && result?.owner === owner && result.content === content && result.attempt === attempt ? result : null
  return <div ref={ref} className="file-diagram-preview" data-diagram-kind="dot" style={{ minHeight: 80, overflow: 'auto' }}>
    {ready?.url ? <img src={ready.url} alt={`${path ?? 'DOT'} diagram`} style={{ display: 'block', maxWidth: '100%', margin: 'auto' }} /> : <>
      {ready?.error ? <div className="file-preview-state" role="alert"><strong>DOT could not render</strong><span>{ready.error}</span>
        <button type="button" className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div> : <div role="status">{inView ? 'Rendering DOT…' : 'DOT preview'}</div>}
      <pre className="md-block-code"><code>{content}</code></pre>
    </>}
  </div>
}
