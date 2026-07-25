import type { SessionSnapshot } from '../../../shared/contracts'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
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
    setAgentComposerDraft(sessionId, `${text}${text && !text.endsWith(' ') ? ' ' : ''}@${activeFile} `)
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
        ...(activeFile ? { onReferenceActiveFile: addFileReference } : {})
      } : {})}
    />
  )
}
