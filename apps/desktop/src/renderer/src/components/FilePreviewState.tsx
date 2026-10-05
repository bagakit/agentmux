import type { ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'

const ThemeFileUnknownIcon = semanticIconComponent('file.unknown')


export function FilePreviewState({ title, detail, children, error = false }: {
  title: string; detail?: string; children?: ReactNode; error?: boolean
}) {
  return <div className="file-preview-state" role={error ? 'alert' : 'status'}>
    <ThemeFileUnknownIcon className="file-preview-state__icon" size={24} aria-hidden="true" />
    <strong>{title}</strong>
    {detail ? <span>{detail}</span> : null}
    {children}
  </div>
}
