import { PanelsTopLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'

/** Presentation only; an empty display does not establish an empty or ended Session. */
export function WorkbenchEmptyState({ title, detail, guidance, diagnostic, actions }: {
  title: string
  detail: string
  guidance?: string
  diagnostic?: string
  actions?: ReactNode
}) {
  return <FullPageLoadingSurface scope="region" phase="parked" eyebrow={title} title={title} detail={detail}
    className="workbench-empty-state" actions={actions}
    supplement={guidance ? <p className="full-page-loading__detail">{guidance}</p> : undefined}
    details={diagnostic ? { summary: 'View details', content: <p className="full-page-loading__detail">{diagnostic}</p> } : undefined}>
    <div className="full-page-loading__heading">
      <h1>{title}</h1>
      <span className="full-page-loading__mark" aria-hidden="true"><PanelsTopLeft size={18} /></span>
    </div>
    <p className="full-page-loading__detail">{detail}</p>
  </FullPageLoadingSurface>
}
