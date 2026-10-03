import type { FileReadResource, FileReadResult, TopicKnowledgeDocument } from '@agentmux/core'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { ArrowUpRight, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { isImeCompositionKeyDown } from '../lib/ime-composition-keyboard-event'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { spatialCatalog, spatialDestination, zoneContext } from '../lib/space-agent-control'
import { fileTabId, initialWorkbenchRegionId } from '../lib/workbench-tabs'
import { useAppStore } from '../store'

/** A view of the original Files receipt. It never creates a knowledge entry or saves its body. */
export function TopicKnowledgeDocumentReader({ document: original, refresh, onClose }: {
  document: TopicKnowledgeDocument; refresh: number; onClose(): void
}) {
  const [reading, setReading] = useState(true)
  const [receipt, setReceipt] = useState<FileReadResult | null>(null)
  const [resource, setResource] = useState<FileReadResource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const targetKey = JSON.stringify(original.target)
  useEffect(() => {
    let live = true
    setReading(true); setError(null)
    void api.files.readPublic(original.target).then(result => {
      if (!live) return
      // An observation gap does not revoke this same source's confirmed file/editor capability.
      setResource(previous => result.resource ?? previous)
      if (result.result.status === 'read') setReceipt(result)
      else {
        // Keep a previously confirmed body for this same source when a refresh is unavailable.
        setReceipt(previous => previous?.result.status === 'read' ? previous : result)
        setError(result.result.status === 'unknown' || result.result.status === 'error' ? result.result.message
          : result.result.status === 'deleted' ? 'This original file is no longer available.'
            : result.result.status === 'binary' ? 'This original file needs its file viewer.' : 'This source is now a directory.')
      }
    }).catch(cause => { if (live) setError(presentError(cause)) }).finally(() => { if (live) setReading(false) })
    return () => { live = false }
  }, [targetKey, refresh])
  const body = receipt?.result.status === 'read' ? receipt.result.document : null
  async function openOriginal(path?: string, location?: { line: number; column?: number }) {
    if (!resource) { setError('The original file resource is unconfirmed. Refresh knowledge to read its source again.'); return }
    const state = useAppStore.getState()
    const workspace = state.config?.workspaces.find(candidate => candidate.id === resource.workspaceId)
    if (!workspace || workspace.hostId !== resource.hostId || workspace.path !== resource.workspacePath) {
      setError('The original Workspace changed. Refresh its source before opening this file.'); return
    }
    try {
      const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace) ?? []
      const catalog = spatialCatalog(state, topics), zone = catalog.zones.find(candidate => candidate.zoneId === resource.zoneId)
      if (!zone || zone.workspaceId !== resource.workspaceId || zone.hostId !== resource.hostId) throw new Error('The original file Zone is unconfirmed. Refresh its source before opening this file.')
      const filePath = path ?? resource.path, tabId = fileTabId(resource.workspaceId, filePath), regionId = initialWorkbenchRegionId(tabId)
      const target = spatialDestination(catalog, { zoneId: zone.zoneId, newTab: true }, { tabId, regionId }, state.layouts).address
      if (!await state.openFile(filePath, target.groupId, location, resource.workspaceId, true, {
        displayWorkspaceId: target.displayWorkspaceId,
        space: { spaceId: zoneContext(state, topics, zone), zoneId: zone.zoneId }, resource: { hostId: resource.hostId, path: resource.workspacePath },
        focus: true, fileOnly: true,
        selection: { spaceId: target.spaceId, zoneId: zone.zoneId, workspaceId: target.displayWorkspaceId,
          groupId: target.groupId, tabId, regionId, topicId: original.topicId }
      })) {
        setError('Opening the original file was not confirmed. Refresh its source or use its existing file workface.')
      }
    }
    catch (cause) { setError(presentError(cause)) }
  }
  return <article className="topic-knowledge-entry" aria-label="Original document detail" onKeyDown={event => {
    if (event.key === 'Escape' && !isImeCompositionKeyDown(event)) { event.preventDefault(); event.stopPropagation(); onClose() }
  }}>
    <header><span><strong title={original.title}>{original.title}</strong><small title={original.target.path}>Original file · {original.target.path}</small></span>
      <button type="button" className="icon-button" aria-label="Open original file" title="Open original file" onClick={() => void openOriginal()}><ArrowUpRight size={13} /></button>
      <button type="button" className="icon-button" aria-label="Close document detail" title="Back to results" onClick={onClose}><X size={13} /></button>
    </header>
    <div className="topic-knowledge-entry__body">
      {reading ? <p className="topic-knowledge-hint" role="status">Reading original file…</p> : null}
      {error ? <div className="surface-inline-error" role="status">{error} The source reference is kept; refresh to check it again.</div> : null}
      {body && receipt?.resource ? /\.(md|markdown)$/iu.test(original.target.path)
        ? <AgentMarkdown content={body.content} className="topic-knowledge-prose" workspaceRoot={receipt.resource.workspacePath} sourcePath={receipt.resource.path}
          {...(resource ? { openWorkspaceFile: (path: string, location?: { line: number; column?: number }) => { void openOriginal(path, location) } } : {})} />
        : <pre className="topic-knowledge-prose topic-knowledge-document-text">{body.content}</pre> : null}
    </div>
  </article>
}
