import type { SessionSnapshot } from '../../../shared/contracts'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { appendFileReferences } from '../lib/composer-file-reference'
import { useAppStore } from '../store'
import { AgentComposer } from './AgentComposer'

export type AgentComposerAvailability = {
  disabled: boolean
  placeholder: string
}

export function agentComposerAvailability(
  session: SessionSnapshot | undefined,
  forceDisabled = false
): AgentComposerAvailability {
  if (!session || session.kind !== 'agent') {
    return { disabled: true, placeholder: 'Agent is connecting…' }
  }
  if (forceDisabled) {
    return { disabled: true, placeholder: 'Agent is connecting…' }
  }
  if (session.status.state === 'disconnected') {
    return { disabled: true, placeholder: 'Agent is disconnected' }
  }
  if (session.processState !== 'running') {
    return { disabled: true, placeholder: 'Agent is not running' }
  }
  if (session.pendingInteraction) {
    return { disabled: true, placeholder: 'Answer the Agent request above…' }
  }
  return { disabled: false, placeholder: 'Ask, steer, or paste a command…' }
}

export function AgentSessionComposer({
  sessionId,
  disabled = false
}: {
  sessionId: string
  disabled?: boolean
}) {
  const text = useAppStore((state) => state.agentComposerDrafts[sessionId] ?? '')
  const setAgentComposerDraft = useAppStore((state) => state.setAgentComposerDraft)
  const clearAgentComposerDraftIfUnchanged = useAppStore((state) => state.clearAgentComposerDraftIfUnchanged)
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId))
  const workspace = useAppStore((state) =>
    state.config?.workspaces.find((item) =>
      session?.kind === 'agent' && workspaceOwnsSessionPath(item, session)
    )
  )
  const activeFile = useAppStore((state) =>
    workspace ? state.lastActiveFileByWorkspace[workspace.id] : undefined
  )
  const send = useAppStore((state) => state.send)
  const interrupt = useAppStore((state) => state.interrupt)
  const availability = agentComposerAvailability(session, disabled)
  const isWorking = session?.kind === 'agent' && session.status.state === 'working'

  async function submit(): Promise<void> {
    if (availability.disabled || !text.trim()) return
    const value = text
    try {
      await send(sessionId, value)
      clearAgentComposerDraftIfUnchanged(sessionId, value)
    } catch {
      // The Store owns error presentation; keep the draft available for retry.
    }
  }

  function addFileReference(): void {
    if (!activeFile || availability.disabled) return
    setAgentComposerDraft(sessionId, appendFileReferences(text, [activeFile]))
  }

  async function attachFiles(): Promise<void> {
    if (availability.disabled) return
    const workspacePath = session?.kind === 'agent' ? session.workspacePath : undefined
    const chosen = await api.ui.chooseFiles(workspacePath ? { defaultPath: workspacePath } : undefined)
    if (!chosen || chosen.length === 0) return
    // Read the draft at completion, not at click: the dialog is modal but the store is the owner.
    const current = useAppStore.getState().agentComposerDrafts[sessionId] ?? ''
    setAgentComposerDraft(sessionId, appendFileReferences(current, chosen, workspacePath))
  }

  async function pasteImage(image: { bytes: Uint8Array; extension: string }): Promise<void> {
    if (availability.disabled) return
    // The prompt channel is text with a hard size cap and no Provider speaks ACP, so an image can only
    // reach the Agent as a file it opens itself. Save it, then reference the path like any other file.
    const path = await api.ui.savePastedImage(image)
    const workspacePath = session?.kind === 'agent' ? session.workspacePath : undefined
    const current = useAppStore.getState().agentComposerDrafts[sessionId] ?? ''
    setAgentComposerDraft(sessionId, appendFileReferences(current, [path], workspacePath))
  }

  return (
    <AgentComposer
      value={text}
      disabled={availability.disabled}
      placeholder={availability.placeholder}
      isWorking={isWorking}
      {...(activeFile ? { activeFile } : {})}
      onChange={(value) => setAgentComposerDraft(sessionId, value)}
      {...(!availability.disabled ? {
        onSubmit: () => void submit(),
        onInterrupt: () => void interrupt(sessionId),
        onAttach: () => void attachFiles(),
        onPasteImage: (image: { bytes: Uint8Array; extension: string }) => void pasteImage(image),
        ...(activeFile ? { onReferenceActiveFile: addFileReference } : {})
      } : {})}
    />
  )
}
