import { CheckCircle2, ExternalLink, FileDiff, Globe2, ListChecks, MessageCircle } from 'lucide-react'
import type { AgentTimelineItem } from '../../../shared/contracts'
import { parseHttpLinkUrl, type OpenHttpLinkOrigin } from '../lib/open-destination'
import { toolCallToDiff, parseUnifiedDiff } from '../lib/activity-diff'
import { workspaceForSession } from '../lib/workbench-tabs'
import { useGitStatus } from '../hooks/useGitStatus'
import { useAppStore } from '../store'

function resultTargets(items: readonly AgentTimelineItem[]): { diffPath: string | null; previewUrls: string[] } {
  let diffPath: string | null = null
  const previewUrls: string[] = []
  for (const item of [...items].reverse()) {
    const payload = item.toolInput ?? (item.kind === 'tool_call' ? item.content : undefined)
    if (!diffPath && payload) {
      const diff = (item.toolInput ? toolCallToDiff(item.title, item.toolInput) : null) ?? parseUnifiedDiff(payload)
      if (diff?.filePath) diffPath = diff.filePath
    }
    for (const match of (item.content ?? '').matchAll(/https?:\/\/[^\s)<>]+/ig)) {
      const parsed = parseHttpLinkUrl(match[0])
      if (parsed && !previewUrls.includes(parsed)) previewUrls.push(parsed)
    }
  }
  return { diffPath, previewUrls }
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
  const selectSession = useAppStore((state) => state.selectSession)
  const config = useAppStore((state) => state.config)
  const workspace = session ? workspaceForSession(config, session) : undefined
  const git = useGitStatus(workspace?.id ?? null)
  if (!session || session.kind !== 'agent' || session.status.state !== 'done') return null
  const { diffPath, previewUrls } = resultTargets(items)
  return (
    <aside className="session-result-review" aria-label="Review Agent result">
      <div className="session-result-review__identity">
        <CheckCircle2 size={15} aria-hidden="true" />
        <span><strong>Result ready</strong><small>Review the work, then continue this Session.</small></span>
      </div>
      <div className="session-result-review__actions">
        <button type="button" className="small-button" onClick={() => setViewMode(sessionId, 'activity')}><ListChecks size={12} /> Activity</button>
        {workspace && git.status?.kind === 'git-repository' ? git.status.changes.map((change) => (
          <button key={change.path} type="button" className="small-button" onClick={() => void openFileDiff(change.path, workspace.id).catch(reportError)}><FileDiff size={12} /> {change.path}</button>
        )) : null}
        {diffPath && !workspace ? <button type="button" className="small-button" onClick={() => void openFileDiff(diffPath).catch(reportError)}><FileDiff size={12} /> Review changes</button> : null}
        {previewUrls.map((previewUrl) => <button key={previewUrl} type="button" className="small-button" onClick={() => void openHttpLink(origin, previewUrl, 'tab').catch(reportError)}><Globe2 size={12} /> Preview <ExternalLink size={11} /></button>)}
        <button type="button" className="small-button" onClick={() => selectSession(session.id)}><MessageCircle size={12} /> Continue in Session</button>
        {!diffPath && previewUrls.length === 0 && (!workspace || git.status?.kind !== 'git-repository' || git.status.changes.length === 0) ? <span className="session-result-review__waiting">Waiting for a Diff or Browser preview target.</span> : null}
      </div>
      {workspace && git.error ? <span className="session-result-review__hint">Could not read changes for this workspace: {git.error}</span> : null}
      {workspace && git.status?.kind === 'not-a-git-repository' ? <span className="session-result-review__hint">This Session workspace is not a Git repository.</span> : null}
      {!workspace ? <span className="session-result-review__hint">The Session workspace could not be located; it remains available.</span> : null}
      {!visible ? <span className="session-result-review__hint">Open this Session to review its result.</span> : null}
    </aside>
  )
}
