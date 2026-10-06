import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { FileDocument } from '@agentmux/core'
import type { FileReadResult } from '@agentmux/core/files'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { MOTE_MEMORY_PATH } from '../../../shared/topic-agent-instructions'
import { api } from '../lib/api'
import { readMoteMaterial } from '../lib/mote-cooperation'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { documentKey } from '../lib/workbench-tabs'
import { useAppStore } from '../store'

const FileIcon = semanticIconComponent('file.text')
const DownIcon = semanticIconComponent('navigation.down')
type SavedMemory = { document: FileDocument; resource: FileReadResult['resource'] }
type Props = { scope: MoteWorkfaceScope; active: boolean; onOpenPath(path: string): Promise<unknown> }

/** This is an observation of the original file. The original Editor remains its only writer. */
export function MoteMemory(props: Props) {
  const { scope } = props
  return <OriginalMoteMemory key={JSON.stringify([scope.workspace.id, scope.workspace.hostId, scope.workspace.path,
    scope.topic.id, scope.topic.directoryPath, scope.rootPath])} {...props} />
}

function OriginalMoteMemory({ scope, active, onOpenPath }: Props) {
  const path = scope.rootPath + '/' + MOTE_MEMORY_PATH, key = documentKey(scope.workspace.id, path)
  const [expanded, setExpanded] = useState(false), [attempt, setAttempt] = useState(0)
  const [saved, setSaved] = useState<SavedMemory | null>(null)
  const [issue, setIssue] = useState<string | null>(null), [openIssue, setOpenIssue] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const enabled = active && expanded
  // Only this file's saved revision/failure can refresh the preview. Editor typing is not a save.
  const source = useAppStore(useShallow(state => enabled ? {
    revision: state.documents[key]?.revision, issue: state.documentIssues[key]
  } : null))
  const dirty = useAppStore(state => enabled && Boolean(state.dirtyDocuments[key]))
  const request = useMemo(() => ({ valid: true }), [enabled, attempt, source?.revision, source?.issue])
  const current = useRef<typeof request | null>(request); current.current = request
  const admitted = useRef<typeof request | null>(null)
  useEffect(() => {
    current.current = request
    if (!enabled) return () => { if (current.current === request) current.current = null }
    const resourceCurrent = () => {
      const workspace = useAppStore.getState().config?.workspaces.find(item => item.id === scope.workspace.id)
      return workspace?.hostId === scope.workspace.hostId && workspace.path === scope.workspace.path
    }
    const originalFolderIssue = 'The original Mote folder changed. Its last confirmed content is kept; return to the original folder and retry.'
    const stopResource = useAppStore.subscribe((next, previous) => {
      if (next.config === previous.config || resourceCurrent()) return
      request.valid = false
      setLoading(false); setIssue(originalFolderIssue)
    })
    const stopInvalidations = api.files.onInvalidated(event => {
      if (event.workspaceId !== scope.workspace.id || event.path !== path) return
      // An open Editor already publishes this file's revision or failure. No second watcher is made.
      if (!useAppStore.getState().documents[key]) setAttempt(value => value + 1)
    })
    if (admitted.current !== request) {
      admitted.current = request
      if (!resourceCurrent()) { request.valid = false; setLoading(false); setIssue(originalFolderIssue) }
      else {
        setLoading(true); setIssue(null)
        const isCurrent = () => current.current === request && request.valid && resourceCurrent()
        void readMoteMaterial(scope, path).then(observation => {
          if (!isCurrent()) return
          const result = observation.result
          if (result.status === 'read') setSaved({ document: result.document, resource: observation.resource })
          else setIssue(result.status === 'unknown' || result.status === 'error'
            ? 'Saved memory could not be read. ' + result.message
            : result.status === 'deleted' ? 'MEMORY.md is no longer present. Any last confirmed content is kept below; inspect the original file.'
            : result.status === 'binary' ? 'MEMORY.md contains binary data. Open the original file to inspect it.'
            : 'MEMORY.md is a directory. Inspect the original folder.')
        }).catch(cause => { if (isCurrent()) setIssue('Saved memory could not be read. ' + presentError(cause)) })
          .finally(() => { if (isCurrent()) setLoading(false) })
      }
    }
    return () => { stopResource(); stopInvalidations(); if (current.current === request) current.current = null }
  }, [request])

  const openEditor = () => {
    const original = current.current
    setOpenIssue(null)
    void onOpenPath(path).catch(cause => {
      if (current.current === original) setOpenIssue('The memory editor could not be opened. ' + presentError(cause))
    })
  }
  return <details className="mote-memory" data-mote-memory={scope.topic.id} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><FileIcon size={13} /><span>Memory</span><DownIcon size={14} /></summary>
    {expanded ? <div className="mote-memory__body">
      <div className="mote-details__section-actions"><span>{saved ? issue || loading ? 'Last confirmed saved content' : 'Saved in MEMORY.md' : 'MEMORY.md'}</span>
        <button type="button" className="small-button" aria-label="Correct or remove a memory detail in editor" onClick={openEditor}>Edit memory</button></div>
      {dirty ? <p role="status" className="mote-details__hint mote-memory__draft">The editor has unsaved changes. This preview shows the saved file.</p> : null}
      {loading ? <p role="status" className="mote-details__hint">Reading saved memory…</p> : null}
      {issue ? <div role="status" className="mote-details__issue"><span>{issue}</span><button type="button" className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry memory</button></div> : null}
      {openIssue ? <p role="status" className="mote-details__issue">{openIssue}</p> : null}
      {active && saved ? saved.document.content.trim() ? <AgentMarkdown content={saved.document.content} className="mote-details__prose mote-memory__prose"
        workspaceRoot={scope.workspace.path} sourcePath={path} openWorkspaceFile={link => { void onOpenPath(link) }} />
        : <p className="mote-details__hint">No saved notes yet. Add a detail in the editor.</p> : null}
      <details className="mote-memory__source"><summary><span>Source &amp; saved version</span><DownIcon size={12} /></summary>
        <dl><dt>File</dt><dd>{scope.topic.title} · {saved?.resource?.path ?? path}</dd><dt>Folder</dt><dd>{saved?.resource?.hostId ?? scope.workspace.hostId} · {saved?.resource?.zonePath ?? scope.topic.directoryPath}</dd>
          {saved ? <><dt>Saved version</dt><dd data-memory-revision><code>{saved.document.revision}</code></dd></> : null}</dl>
        <p className="mote-details__hint">{saved ? 'This is the file version read here. Agent use is not confirmed.' : 'The saved file has not been confirmed yet.'}</p>
      </details>
      <p className="mote-details__hint mote-memory__scope">Edit a detail, then Save. New discussions read the saved file; earlier conversations and model history remain.</p>
    </div> : null}
  </details>
}
