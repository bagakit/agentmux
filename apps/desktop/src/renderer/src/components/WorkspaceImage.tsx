import { useEffect, useRef, useState } from 'react'
import { usePreviewObjectUrl, useWorkspaceFilePreview } from '../lib/use-workspace-file-preview'

/** Local Markdown image bytes use the same Main authority and resource fence as file media. */
export function WorkspaceImage({ workspaceId, path, alt, openFile, linked = false }: {
  workspaceId: string; path: string; alt: string; openFile: () => void; linked?: boolean
}) {
  const element = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [height, setHeight] = useState(linked ? 24 : 160)
  useEffect(() => {
    const target = element.current
    if (!target) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '160px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [])
  const { preview, failure, reload } = useWorkspaceFilePreview(workspaceId, path, visible)
  const url = usePreviewObjectUrl(preview?.kind === 'image' ? preview : null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const unavailable = failure || preview && preview.kind !== 'image' || url && failedUrl === url
  return <span ref={element} className="file-markdown-image" style={{ minHeight: height }}>
    {unavailable ? <span className="file-markdown-image__failure" role="status">
      <span>{alt || path}: {failure?.message ?? 'Image could not be decoded.'}</span>
      {!linked ? <><button className="small-button" onClick={() => { setFailedUrl(null); reload() }}>Retry</button>
      <button className="small-button" onClick={openFile}>Open file</button></> : null}
    </span> : url ? <img src={url} alt={alt} title={path} onLoad={event => setHeight(event.currentTarget.getBoundingClientRect().height)} onError={() => setFailedUrl(url)} />
      : visible ? <span className="file-markdown-image__loading" role="status">Loading {alt || path}…</span> : null}
  </span>
}
