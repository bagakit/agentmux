import type { BrowserInputContext, BrowserInputContextSource } from '@agentmux/core/browser-input-context'
import { useState } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { useBrowserSelectionImageRenderer } from '../platform.js'
import { useVisibleWork } from '../lib/use-visible-work.js'

function capturedTime(value: number): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Time not readable'
}

/** A historical observation, independent of the input author and current Browser control. */
export function ConversationBrowserContext({ context, source, raw, visible = true, readOnly = false, readOnlyImages = false }: {
  context: BrowserInputContext
  source?: BrowserInputContextSource | undefined
  raw?: string | undefined
  visible?: boolean
  readOnly?: boolean
  readOnlyImages?: boolean
}) {
  const activity = context.activity, selection = context.selection
  const [expanded, setExpanded] = useState(false)
  const renderImage = useBrowserSelectionImageRenderer()
  const attachment = selection?.attachment
  const imageWork = useVisibleWork<HTMLElement>(expanded && visible && (!readOnly || readOnlyImages) && Boolean(renderImage && attachment?.sha256))
  const sourceLabel = source === 'host-capture' ? 'Browser capture' : source === 'caller-declared' ? 'Declared context' : 'Source not recorded'
  return <details className="conversation-browser-context" data-browser-context-source={source ?? 'unknown'} onToggle={event => {
    if (event.target === event.currentTarget) setExpanded(event.currentTarget.open)
  }}>
    <summary>
      <SemanticIcon name="object.browser" size={13} aria-hidden="true" />
      <span className="conversation-browser-context__kind">{sourceLabel}</span>
      <span className="conversation-browser-context__title" title={context.page.title || context.page.url}>{context.page.title || context.page.url || 'Browser page'}</span>
      <SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />
    </summary>
    <div className="conversation-browser-context__body">
      <p className="conversation-browser-context__url">{context.page.url || 'URL not recorded'}</p>
      <dl>
        <dt>Captured</dt><dd>{capturedTime(context.capturedAt)}</dd>
        <dt>Browser</dt><dd><code>{context.browser.hostId} / {context.browser.browserId}</code></dd>
        <dt>Navigation</dt><dd><code>{context.browser.navigationId ?? 'Not recorded'}</code></dd>
        {activity ? <>
          <dt>Operation</dt><dd><code>{activity.operationId}</code></dd>
          <dt>Step at capture</dt><dd>{activity.stepSequence === null ? 'Not recorded' : activity.stepSequence} · {activity.phase}</dd>
        </> : null}
      </dl>
      {selection ? <section ref={imageWork.ref} className="conversation-browser-context__selection" aria-label="Captured selection">
        <h4>{selection.kind === 'region' ? 'Selected region' : 'Selected element'}</h4>
        {selection.element ? <p>{selection.element.accessibleName || selection.element.text || selection.element.tagName}</p> : null}
        <dl>
          <dt>Captured</dt><dd>{capturedTime(selection.capturedAt)}</dd>
          <dt>Source</dt><dd><code>{selection.source.hostId} / {selection.source.browserId}</code></dd>
          <dt>Navigation</dt><dd><code>{selection.source.navigationId ?? 'Not recorded'}</code></dd>
          <dt>Association</dt><dd>{selection.source.association === 'exact-step' ? 'Exact step' : selection.source.association === 'observed-during' ? 'Observed during' : 'Unknown'}{selection.source.stepSequence === undefined ? '' : ` · Step ${selection.source.stepSequence}`}</dd>
          {selection.source.operationId ? <><dt>Operation</dt><dd><code>{selection.source.operationId}</code></dd></> : null}
          {selection.region ? <><dt>Capture pixels</dt><dd>{selection.region.x}, {selection.region.y} · {selection.region.width} × {selection.region.height}</dd></> : null}
          {selection.attachment ? <><dt>Image reference</dt><dd><code>{selection.attachment.path}</code> · {selection.attachment.width} × {selection.attachment.height}</dd></> : null}
        </dl>
        {attachment ? !attachment.sha256 ? <p className="conversation-browser-context__notice">The original image digest was not recorded. Its exact preview is unavailable.</p>
          : !renderImage ? <p className="conversation-browser-context__notice">Image preview is unavailable in this client. The original reference is retained.</p>
          : imageWork.visible ? renderImage({ reference: attachment, visible: true, interactive: !readOnly }) : null : null}
        {selection.observationEnd ? <p className="conversation-browser-context__notice">Capture crossed an observation boundary; both observations remain in context data.</p> : null}
      </section> : null}
      <details className="conversation-browser-context__data"><summary>Context data</summary><pre>{raw ?? JSON.stringify(context, null, 2)}</pre></details>
    </div>
  </details>
}
