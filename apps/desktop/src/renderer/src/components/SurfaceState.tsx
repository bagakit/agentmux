import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'

const DisclosureIcon = semanticIconComponent('navigation.disclosure')

export type SurfaceStateProps = Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children'> & {
  ref?: Ref<HTMLDivElement>
  layout?: 'surface' | 'inline'
  identity?: ReactNode
  eyebrow?: ReactNode
  title?: ReactNode
  description?: ReactNode
  activity?: ReactNode
  body?: ReactNode
  actions?: ReactNode
  details?: { summary: string; content: ReactNode } | undefined
}

/** Presentation only. Callers own facts, live announcements, targets and actions. */
export function SurfaceState({ layout = 'surface', identity, eyebrow, title, description,
  activity, body, actions, details, className, ...element }: SurfaceStateProps) {
  return <div {...element} className={`surface-state surface-state--${layout}${className ? ` ${className}` : ''}`}>
    <div className="surface-state__content">
      {identity != null ? <div className="surface-state__identity">{identity}</div> : null}
      {activity != null ? <div className="surface-state__activity">{activity}</div> : null}
      {eyebrow != null || title != null || description != null ? <div className="surface-state__heading">
        {eyebrow != null ? <div className="surface-state__eyebrow">{eyebrow}</div> : null}
        {title != null ? <h2 className="surface-state__title">{title}</h2> : null}
        {description != null ? <div className="surface-state__description">{description}</div> : null}
      </div> : null}
      {actions != null ? <div className="surface-state__actions">{actions}</div> : null}
      {body != null ? <div className="surface-state__body">{body}</div> : null}
      {details ? <details className="surface-state__details">
        <summary><DisclosureIcon size={12} aria-hidden="true" />{details.summary}</summary>
        {details.content}
      </details> : null}
    </div>
  </div>
}
