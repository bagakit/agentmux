import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { DiagramFilePreview } from './DiagramFilePreview'

export function DrawioFilePreview({ content, path, visible = true }: { content: string; path?: string; workspaceId?: string; visible?: boolean }) {
  const [page, setPage] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  useEffect(() => { setPage(0); setPageCount(1) }, [content])
  if (!visible) return null
  return <div className="file-rich-preview file-drawio-preview">
    {pageCount > 1 && <nav aria-label="Diagram pages" className="file-preview__controls file-drawio-preview__pages">
      <button type="button" className="icon-button" aria-label="Previous diagram page" disabled={page === 0} onClick={() => setPage(value => value - 1)}><ChevronLeft size={14} /></button>
      <output aria-live="polite" aria-label="Diagram page">{page + 1} / {pageCount}</output>
      <button type="button" className="icon-button" aria-label="Next diagram page" disabled={page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}><ChevronRight size={14} /></button>
    </nav>}
    <DiagramFilePreview content={content} kind="drawio" {...(path === undefined ? {} : { path })} visible={visible} page={page} onPageCount={setPageCount} />
  </div>
}
