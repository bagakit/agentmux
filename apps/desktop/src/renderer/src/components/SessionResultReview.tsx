import { sessionPresentationById } from '../lib/session-presentation'
import { CheckCircle2, ChevronDown, ExternalLink, FileDiff, Globe2, ListChecks, MessageCircle, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { AgentTimelineItem } from '../../../shared/contracts'
import { parseHttpLinkUrl, type OpenHttpLinkOrigin } from '../lib/open-destination'
import { toolCallToDiff, parseUnifiedDiff } from '../lib/activity-diff'
import { workspaceRelativeGitPath } from '../lib/git-path-coordinates'
import { resolveWorkspaceRelativePath } from '../lib/terminal-path-link'
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

/**
 * Timeline tool inputs are normally Workspace-relative, while a provider may report the same file
 * in the repository coordinate system used by Git. Keep the two cases explicit: only a path carrying
 * this repository's prefix crosses the Git converter; all other forms use the existing Workspace
 * confinement rules. An absolute path outside the Session Workspace and `../` are rejected rather
 * than being sent to `openFileDiff` under a guessed root.
 */
function timelinePathForWorkspace(
  path: string,
  workspacePath: string,
  repoRelativePrefix: string
): string | null {
  const candidate = path.replace(/^\.\//u, '')
  const prefix = repoRelativePrefix.replace(/[\\/]+$/u, '')
  if (prefix && (candidate === prefix || candidate.startsWith(`${prefix}/`))) {
    return workspaceRelativeGitPath(candidate, repoRelativePrefix)
  }
  return resolveWorkspaceRelativePath(path, workspacePath)
}

export function SessionResultReview({
  sessionId,
  items,
  origin,
  visible,
  surfaceAnchor
}: {
  sessionId: string
  items: readonly AgentTimelineItem[]
  origin: OpenHttpLinkOrigin
  visible: boolean
  surfaceAnchor: string
}) {
  const session = useAppStore((state) => sessionPresentationById(state.sessions).get(sessionId))
  const setViewMode = useAppStore((state) => state.setViewMode)
  const openFileDiff = useAppStore((state) => state.openFileDiff)
  const openHttpLink = useAppStore((state) => state.openHttpLink)
  const reportError = useAppStore((state) => state.reportError)
  const selectSession = useAppStore((state) => state.selectSession)
  const config = useAppStore((state) => state.config)
  const workspace = session ? workspaceForSession(config, session) : undefined
  const git = useGitStatus(workspace?.id ?? null)
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const popoverId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const ready = session?.kind === 'agent' && session.status.state === 'done'
  const acquireNativeSurfaceOverlay = useAppStore((state) => state.acquireNativeSurfaceOverlay)
  const releaseNativeSurfaceOverlay = useAppStore((state) => state.releaseNativeSurfaceOverlay)
  useEffect(() => { setExpanded(false); setDismissed(false) }, [sessionId])
  useEffect(() => {
    if (!ready) { setExpanded(false); setDismissed(false) }
    if (expanded && !visible) popover.current?.hidePopover()
  }, [ready, expanded, visible])
  useEffect(() => {
    if (!ready || !expanded || dismissed || !visible) return
    acquireNativeSurfaceOverlay()
    return releaseNativeSurfaceOverlay
  }, [ready, expanded, dismissed, visible, acquireNativeSurfaceOverlay, releaseNativeSurfaceOverlay])
  // The fixed control slot also keeps a long draft from wrapping when a turn completes.
  if (!session || session.kind !== 'agent' || !ready || dismissed) return <span className="session-result-review-slot" aria-hidden="true" />
  const { diffPath, previewUrls } = resultTargets(items)
  const repository = workspace && git.status?.kind === 'git-repository' && !git.error ? git.status : null
  const reviewableChanges = repository
    ? repository.changes.flatMap((change) => {
        const path = workspaceRelativeGitPath(change.path, repository.repoRelativePrefix)
        return path ? [{ change, path }] : []
      })
    : []
  const timelineDiffPath = workspace && repository && diffPath
    ? timelinePathForWorkspace(diffPath, workspace.path, repository.repoRelativePrefix)
    : null
  const uniqueTimelineDiffPath = timelineDiffPath && !reviewableChanges.some(({ path }) => path === timelineDiffPath)
    ? timelineDiffPath
    : null
  const reviewState = !workspace
    ? 'unknown-workspace'
    : git.error
      ? 'read-failed'
      : git.status?.kind === 'not-a-git-repository'
        ? 'not-a-git-repository'
        : repository
          ? reviewableChanges.length > 0 ? 'changes' : 'no-changes'
          : git.loading ? 'loading' : 'unknown'
  const targetCount = reviewableChanges.length + (uniqueTimelineDiffPath ? 1 : 0) + previewUrls.length
  const summary = targetCount > 0 ? `${targetCount} review target${targetCount === 1 ? '' : 's'} available` : 'Review the work, then continue this Session.'
  return (
    <span className="session-result-review-slot session-result-review" data-result-review-expanded={expanded ? 'true' : 'false'}>
      <button ref={trigger} type="button" className="session-result-review__trigger" aria-label={`Result ready · Review Agent result. ${summary}`}
        title={`Result ready · ${summary}`} aria-expanded={expanded} aria-controls={popoverId}
        popoverTarget={popoverId} popoverTargetAction="toggle"
        onPointerDown={() => { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }}
        onClick={() => setExpanded((value) => !value)}>
        <CheckCircle2 size={14} aria-hidden="true" /><span className="session-result-review__label">Review</span>
      </button>
      <aside ref={popover} id={popoverId} popover="auto" className="session-result-review__popover" aria-label="Review Agent result" style={{ positionAnchor: surfaceAnchor }}
        onToggle={(event) => setExpanded(event.newState === 'open')}>
      {expanded ? <div className="session-result-review__details">
        <div className="session-result-review__heading">
          <div className="session-result-review__identity"><CheckCircle2 size={15} aria-hidden="true" /><span><strong>Result ready</strong><small>{summary}</small></span></div>
          <div className="session-result-review__actions" aria-label="Result review controls">
            <button type="button" className="small-button"
              onClick={() => { popover.current?.hidePopover(); setExpanded(false); trigger.current?.focus({ preventScroll: true }) }}><ChevronDown size={12} /> Collapse</button>
            <button type="button" className="small-button" aria-label="Dismiss result review" onClick={() => {
              const surface = trigger.current?.closest('.agent-surface')
              const target = previousFocus.current?.isConnected && previousFocus.current !== trigger.current && previousFocus.current !== document.body
                ? previousFocus.current : surface?.querySelector<HTMLElement>('.xterm-helper-textarea, .composer [role="textbox"], .agent-region-header__more')
              setExpanded(false); setDismissed(true); target?.focus({ preventScroll: true })
            }}><X size={12} /> Close</button>
          </div>
        </div>
        <div className="session-result-review__details-actions">
          <button type="button" className="small-button" onClick={() => setViewMode(sessionId, 'activity')}><ListChecks size={12} /> Activity</button>
          {workspace && repository ? reviewableChanges.map(({ change, path }) => (
            <button key={change.path} type="button" className="small-button" onClick={() => void openFileDiff(path, workspace.id).catch(reportError)}><FileDiff size={12} /> <span title={path}>{path}</span></button>
          )) : null}
          {workspace && uniqueTimelineDiffPath ? <button type="button" className="small-button" onClick={() => void openFileDiff(uniqueTimelineDiffPath, workspace.id).catch(reportError)}><FileDiff size={12} /> Review changes</button> : null}
          {previewUrls.map((previewUrl) => <button key={previewUrl} type="button" className="small-button" onClick={() => void openHttpLink(origin, previewUrl, 'tab').catch(reportError)}><Globe2 size={12} /> <span title={previewUrl}>Preview</span> <ExternalLink size={11} /></button>)}
          <button type="button" className="small-button" onClick={() => selectSession(session.id)}><MessageCircle size={12} /> Continue in Session</button>
        </div>
        {reviewState === 'read-failed' ? <span className="session-result-review__hint">Could not read changes for this workspace: {git.error}</span> : null}
        {reviewState === 'not-a-git-repository' ? <span className="session-result-review__hint">This Session workspace is not a Git repository.</span> : null}
        {reviewState === 'no-changes' ? <span className="session-result-review__hint">No Git changes were found in this Session workspace.</span> : null}
        {reviewState === 'loading' ? <span className="session-result-review__hint">Checking changes for this Session workspace…</span> : null}
        {reviewState === 'unknown-workspace' ? <span className="session-result-review__hint">The Session workspace could not be located; it remains available.</span> : null}
        {reviewState === 'unknown' ? <span className="session-result-review__hint">The Session workspace could not be checked for changes; it remains available.</span> : null}
        {!visible ? <span className="session-result-review__hint">Open this Session to review its result.</span> : null}
      </div> : null}
      </aside>
    </span>
  )
}
