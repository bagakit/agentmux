import { CheckCircle2, ExternalLink, FileDiff, Globe2, ListChecks } from 'lucide-react'
import type { AgentTimelineItem } from '../../../shared/contracts'
import { parseHttpLinkUrl, type OpenHttpLinkOrigin } from '../lib/open-destination'
import { toolCallToDiff, parseUnifiedDiff } from '../lib/activity-diff'
import { useAppStore } from '../store'

function resultTargets(items: readonly AgentTimelineItem[]): { diffPath: string | null; previewUrl: string | null } {
  let diffPath: string | null = null
  let previewUrl: string | null = null
  for (const item of [...items].reverse()) {
    const payload = item.toolInput ?? (item.kind === 'tool_call' ? item.content : undefined)
    if (!diffPath && payload) {
      const diff = (item.toolInput ? toolCallToDiff(item.title, item.toolInput) : null) ?? parseUnifiedDiff(payload)
      if (diff?.filePath) diffPath = diff.filePath
    }
    if (!previewUrl) {
      const candidate = (item.content ?? '').match(/https?:\/\/[^\s)<>]+/i)?.[0]
      if (candidate) previewUrl = parseHttpLinkUrl(candidate)
    }
    if (diffPath && previewUrl) break
  }
  return { diffPath, previewUrl }
}

export function SessionResultReview({
  sessionId,
  items,
  origin,
  visible
}: {
  sessionId: string
  items: readonly AgentTimelineItem[]
  origin: OpenHttpLinkOrigin
  visible: boolean
}) {
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId))
  const setViewMode = useAppStore((state) => state.setViewMode)
  const openFileDiff = useAppStore((state) => state.openFileDiff)
  const openHttpLink = useAppStore((state) => state.openHttpLink)
  const reportError = useAppStore((state) => state.reportError)
  if (!session || session.kind !== 'agent' || session.status.state !== 'done') return null
  const { diffPath, previewUrl } = resultTargets(items)
  return (
    <aside className="session-result-review" aria-label="Review Agent result">
      <div className="session-result-review__identity">
        <CheckCircle2 size={15} aria-hidden="true" />
        <span><strong>Result ready</strong><small>Review the work, then continue this Session.</small></span>
      </div>
      <div className="session-result-review__actions">
        <button type="button" className="small-button" onClick={() => setViewMode(sessionId, 'activity')}><ListChecks size={12} /> Activity</button>
        {diffPath ? <button type="button" className="small-button" onClick={() => void openFileDiff(diffPath).catch(reportError)}><FileDiff size={12} /> Review changes</button> : null}
        {previewUrl ? <button type="button" className="small-button" onClick={() => void openHttpLink(origin, previewUrl!, 'tab').catch(reportError)}><Globe2 size={12} /> Open preview <ExternalLink size={11} /></button> : null}
        {!diffPath && !previewUrl ? <span className="session-result-review__waiting">Waiting for a Diff or Browser preview target.</span> : null}
      </div>
      {!visible ? <span className="session-result-review__hint">Open this Session to review its result.</span> : null}
    </aside>
  )
}
