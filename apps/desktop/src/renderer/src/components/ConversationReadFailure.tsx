import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import type { ServiceNoticeItem } from '../lib/use-service-notices'

/** Each entry belongs to an existing read owner; presentation never combines its outcome. */
export type ConversationReadIssue = {
  id: string
  label: string
  reasons: readonly string[]
  loading: boolean
  retryLabel: string
  retry(): void
}

export function ConversationReadFailure({ scope, issues, full = false, visible }: {
  scope: string
  issues: readonly ConversationReadIssue[]
  full?: boolean
  visible: boolean
}) {
  const title = 'Conversation reading interrupted'
  const retrying = issues.every(issue => issue.loading)
  const retry = <button type="button" className="small-button" aria-label="Retry reading"
    disabled={retrying || !visible} aria-busy={issues.some(issue => issue.loading) || undefined}
    onMouseDown={event => event.preventDefault()} onClick={() => {
      for (const issue of issues) if (!issue.loading) issue.retry()
    }}>{retrying ? 'Retrying…' : 'Retry reading'}</button>
  const details = <div className="conversation-read-issues">
    {issues.map(issue => <section className="conversation-read-issues__source" key={issue.id}
      aria-label={issue.label} aria-busy={issue.loading || undefined}>
      <strong>{issue.label}</strong>
      {issue.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
      <button type="button" className="small-button" disabled={issue.loading || !visible}
        aria-label={issue.retryLabel} onMouseDown={event => event.preventDefault()} onClick={issue.retry}>
        {issue.loading ? 'Retrying…' : issue.retryLabel}
      </button>
    </section>)}
  </div>
  if (full) return <FullPageLoadingSurface scope="region" phase="failed" eyebrow="Conversation reading"
    className="activity-feed__empty-reading activity-feed__reading-failure-surface" title={title}
    detail="Conversation records are unavailable right now. Your Session, draft and available controls are kept."
    actions={retry} details={{ summary: 'Reading details', content: details }} />
  const notices: ServiceNoticeItem[] = issues.map(issue => ({ id: issue.id, cause: issue.id,
    notice: { kind: 'indeterminate', notice: { step: issue.label, mode: issue.reasons.join('\n'), restore: issue.retryLabel } } }))
  return <ServiceNoticeDisclosure scope={scope} notices={notices} visible={visible}
    title={title} persistentTitle className="activity-feed__reading-service" inlineActions={retry}>
    <p className="conversation-read-issues__kept">Loaded messages, your reading position and draft are kept. This read failure does not confirm the Agent’s availability.</p>
    {details}
  </ServiceNoticeDisclosure>
}
