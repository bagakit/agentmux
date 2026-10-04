import type { ReactNode } from 'react'
import { FileQuestion } from 'lucide-react'

export function FilePreviewState({ title, detail, children, error = false }: {
  title: string; detail?: string; children?: ReactNode; error?: boolean
}) {
  return <div className="file-preview-state" role={error ? 'alert' : 'status'}>
    <FileQuestion className="file-preview-state__icon" size={24} aria-hidden="true" />
    <strong>{title}</strong>
    {detail ? <span>{detail}</span> : null}
    {children}
  </div>
}
