import { useState } from 'react'
import { demandEvidenceLabel, demandEvidenceText, type DemandEvidence, type DemandFileEvidence } from '@agentmux/demand/goals'
import { readGoalFileEvidence } from '@agentmux/core/goal-evidence'
import { parseHttpLinkUrl } from '@agentmux/client-ui/link-url'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { documentKey } from '../lib/workbench-tabs'

const OpenIcon = semanticIconComponent('action.open-external')
export function GoalEvidence({ evidence, criterion }: { evidence: readonly DemandEvidence[]; criterion: string }) {
  return <div className="goals-evidence" aria-label={`Reported evidence for ${criterion}`}>
    {evidence.map((reference, index) => <Evidence key={`${index}:${demandEvidenceText(reference)}`} reference={reference} />)}
  </div>
}
function Evidence({ reference }: { reference: DemandEvidence }) {
  const [issue, setIssue] = useState(''), [busy, setBusy] = useState(false), [changed, setChanged] = useState(false)
  const label = demandEvidenceLabel(reference), original = demandEvidenceText(reference)
  const sourceName = useAppStore(state => {
    if (typeof reference === 'string') return ''
    const workspace = state.config?.workspaces.find(value => value.id === reference.resource.workspaceId && value.hostId === reference.resource.hostId && value.path === reference.resource.workspacePath)
    return workspace?.name ?? 'Original workspace'
  })
  const external = typeof reference === 'string' && /^[a-z][a-z0-9+.-]*:\/\//iu.test(reference) && !/^file:\/\//iu.test(reference)
  async function openFile(evidence: DemandFileEvidence) {
    const { resource } = evidence
    function exactWorkspace() {
      const state = useAppStore.getState(), workspace = state.config?.workspaces.find(value => value.id === resource.workspaceId)
      if (!workspace || workspace.hostId !== resource.hostId || workspace.path !== resource.workspacePath)
        throw new Error('The original Host or Workspace is unavailable or changed. Restore this exact source to open it.')
      return state
    }
    const before = exactWorkspace()
    if (!before.layouts[resource.workspaceId]) await before.selectWorkspace(resource.workspaceId)
    const state = exactWorkspace()
    // openFile synchronously captures this checked resource and watches rebindings
    // throughout its asynchronous read. No Project or display Workspace supplies it.
    if (!await state.openFile(resource.path, undefined, evidence.location, resource.workspaceId))
      throw new Error('The original file could not be opened. Its reference and report are preserved.')
    const current = useAppStore.getState(), key = documentKey(resource.workspaceId, resource.path)
    if (current.dirtyDocuments[key]) return 'Opened the original file with your unsaved changes. This draft is not the reported evidence.'
    const problem = current.documentIssues[key], revision = current.documents[key]?.revision ?? (problem?.kind === 'binary' ? problem.revision : null)
    if (problem && problem.kind !== 'binary') return 'Opened the original file with a file service notice. Its displayed content is not confirmed as the reported revision.'
    if (evidence.revision === null) return 'Opened the current file. This report did not record a file revision.'
    if (!revision) return 'Opened the original file. Its displayed revision is not confirmed; the reported revision is retained.'
    return revision === evidence.revision ? '' : 'Opened the current file. Its content differs from the reported revision.'
  }
  async function open(allowCurrent = false) {
    setBusy(true); setIssue('')
    try {
      if (typeof reference === 'string') {
        if (!external) return
        const http = parseHttpLinkUrl(reference), state = useAppStore.getState(), workspaceId = state.activeWorkspaceId
        if (http && workspaceId && state.layouts[workspaceId]) await state.openHttpLink({ workspaceId, tabGroupId: state.layouts[workspaceId]!.activeGroupId }, http, 'tab')
        else await api.ui.openExternal(http ?? reference)
      } else {
        const read = await readGoalFileEvidence(reference, params => api.files.readPublic(params)), result = read.observation.result
        if (result.status !== 'read' && result.status !== 'binary') throw new Error(result.status === 'error' || result.status === 'unknown' ? result.message : `Original file is ${result.status}.`)
        setChanged(read.version === 'changed')
        if (read.version === 'changed' && !allowCurrent) { setIssue('This file has changed since the report. The reported revision is retained.'); return }
        setIssue(await openFile(reference))
      }
    } catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  async function copy() {
    try { await api.ui.writeClipboardText(original) } catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
  }
  return <span>
    {typeof reference !== 'string' || external ? <button type="button" className="goals-evidence__open" title={label} disabled={busy} onClick={() => void open()}>{label}<OpenIcon size={11} /></button> : <code title={label}>{label}</code>}
    <button type="button" className="goals-evidence__copy" aria-label={`Copy evidence location ${label}`} title="Copy full location" onClick={() => void copy()}>Copy</button>
    {typeof reference === 'string' && !external ? <small>Original reference · File source not recorded</small> : null}
    {typeof reference !== 'string' ? <details><summary>{sourceName}</summary><code>{reference.resource.workspacePath}</code><small>{reference.resource.hostId} · {reference.revision ?? 'Revision not recorded'}</small></details> : null}
    {issue ? <span className="goals-service" role="status">{issue}{changed ? <button type="button" className="goals-button" disabled={busy} onClick={() => void open(true)}>View current file</button> : null}</span> : null}
  </span>
}
