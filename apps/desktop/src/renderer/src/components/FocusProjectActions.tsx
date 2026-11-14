import { useRef, useState } from 'react'
import { folderSpaceFacts } from '@agentmux/core/space-folder'
import { formatSpaceAddress } from '@agentmux/core/sharing'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useAppStore } from '../store'

/** This menu invocation keeps the original registered Project, independent of later selection. */
export function FocusProjectActions({ project }: { project: WorkspaceRecord }) {
  const original = useRef({ id: project.id, hostId: project.hostId, path: project.path, repoPath: project.repoPath }).current
  const [issue, setIssue] = useState<string | null>(null)
  const reportError = useAppStore(state => state.reportError)
  function currentProject() {
    const matches = useAppStore.getState().config?.workspaces.filter(item => item.id === original.id) ?? []
    const current = matches.length === 1 ? matches[0] : undefined
    if (!current || current.hostId !== original.hostId || current.path !== original.path || current.repoPath !== original.repoPath) {
      const error = new Error('The original project registration changed. Its address and Space target are unconfirmed; close this menu and reopen the original project to retry. Existing work is kept.')
      setIssue(error.message); reportError(error); return null
    }
    return current
  }
  async function copy() {
    const current = currentProject()
    if (!current) return
    setIssue(null)
    await copyTextToClipboard(formatSpaceAddress({ spaceId: folderSpaceFacts(current).space.spaceId }), cause => {
      reportError(cause); setIssue(`Project address could not be copied: ${presentError(cause)}. Your original work is kept; retry this action.`)
    })
  }
  async function open() {
    const current = currentProject()
    if (!current) return
    try { await useAppStore.getState().selectWorkspace(current.id) }
    catch (cause) { reportError(cause); setIssue(`The original project could not open in Space: ${presentError(cause)}. Your original work is kept; retry this action.`) }
  }
  return <div role="group" aria-label="Project actions" style={{ display: 'grid', gap: 'var(--sp-1)' }}>
    <button type="button" className="small-button" style={{ justifyContent: 'flex-start' }} aria-label="Copy project address" onClick={() => void copy()}><SemanticIcon name="action.copy" size={13} />Copy project address</button>
    <button type="button" className="small-button" style={{ justifyContent: 'flex-start' }} aria-label="Open project in Space" onClick={() => void open()}><SemanticIcon name="navigation.space" size={13} />Open in Space</button>
    {issue ? <p role="status" className="focus-project-preferences__notice">{issue}</p> : null}
  </div>
}
