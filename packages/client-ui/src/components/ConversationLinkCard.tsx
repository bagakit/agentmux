import type { OpenHttpLink } from './AgentMarkdown.js'
import { ContentCopyButton } from './ContentCopyButton.js'
import { SemanticIcon } from '../theme/icons.js'

/** A reading projection of an already-classified link. It never acquires a page. */
export function ConversationLinkCard({ url, href, label, open }: { url: string; href: string; label: string; open: OpenHttpLink }) {
  const target = new URL(url)
  const authored = Boolean(label.trim() && label.trim() !== href && label.trim() !== url)
  const title = authored ? label : target.host
  return <div className="md-link-card" data-reading-find-block>
    <button type="button" className="md-link md-link-card__open" title={url} aria-label={`Open ${title}`} onClick={event => open(url, {
      metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, clientX: event.clientX, clientY: event.clientY
    })}>
      <span className="md-link-card__mark" aria-hidden="true"><SemanticIcon name="object.browser" size={18} /></span>
      <span className="md-link-card__text"><span className="md-link-card__title" data-reading-find-exclude={authored ? undefined : true}>{title}</span>
        <span className="md-link-card__destination" data-reading-find-boundary={authored ? true : undefined}>{authored ? url : label || href}</span></span>
      <SemanticIcon name="action.open-external" size={14} className="md-link-card__arrow" aria-hidden="true" />
    </button>
    <div className="md-link-card__footer" data-reading-find-boundary>
      <details className="md-link-card__address"><summary>Link address</summary><code>{url}</code></details>
      <ContentCopyButton text={url} identity={url} label="Copy link address" />
    </div>
  </div>
}
