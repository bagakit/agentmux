import type { HTMLAttributes, ReactNode } from 'react'
import { SemanticIcon } from '../theme/semantic-icon.js'

const statusIcons = {
  info: 'status.info',
  success: 'status.completed',
  warning: 'status.warning',
  error: 'status.failed',
  unknown: 'status.unknown'
} as const

export type NoticeTone = keyof typeof statusIcons

type NoticeSurfaceProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'aside' | 'article'
  density?: 'regular' | 'compact'
  appearance?: 'framed' | 'row'
}

/** Framing only. The caller owns the label, announcement, actions and lifetime. */
export function NoticeSurface({ as: Tag = 'div', density = 'regular', appearance = 'framed', className, ...attributes }: NoticeSurfaceProps) {
  return <Tag {...attributes} className={className ? `ui-notice ${className}` : 'ui-notice'}
    data-notice-density={density} data-notice-appearance={appearance} />
}

export function NoticeIcon({ tone, size = 16 }: { tone: NoticeTone; size?: number }) {
  return <span className="ui-notice__icon" data-notice-tone={tone} aria-hidden="true">
    <SemanticIcon name={statusIcons[tone]} size={size} />
  </span>
}

/** An inline notice with an optional heading and the original caller-owned actions. */
export function Notice({ tone = 'info', heading, actions, children, messageRole, ...attributes }: NoticeSurfaceProps & {
  tone?: NoticeTone
  heading?: ReactNode
  actions?: ReactNode
  messageRole?: 'status' | 'alert'
}) {
  return <NoticeSurface {...attributes}>
    <div className="ui-notice__layout">
      <div className="ui-notice__message">
        <NoticeIcon tone={tone} />
        <div className="ui-notice__copy" role={messageRole}>
          {heading ? <strong className="ui-notice__heading">{heading}</strong> : null}
          {children}
        </div>
      </div>
      {actions ? <div className="ui-notice__actions">{actions}</div> : null}
    </div>
  </NoticeSurface>
}
